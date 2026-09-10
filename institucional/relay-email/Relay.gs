/**
 * @fileoverview Relay de e-mail institucional — VigiRAM (Opção B do plano de
 * migração, ver plano_migracao_conta_pessoal.md, Seção 2).
 *
 * O QUE É: um projeto Apps Script MÍNIMO E SEPARADO do VigiRAM, publicado
 * como Web App sob a conta INSTITUCIONAL (nunca migra pra pessoal). A única
 * função dele é receber um pedido de envio de e-mail assinado por HMAC e
 * chamar MailApp.sendEmail() rodando como institucional — usa a cota do
 * Workspace, e o remetente é genuinamente a conta institucional (sem alias,
 * sem "via", sem senha de app). Não contém NENHUMA lógica de negócio do
 * VigiRAM (Kanban, casos, investigação, Firestore etc.) — só e-mail.
 *
 * POR QUE ESSA OPÇÃO: as duas alternativas para manter o remetente
 * institucional exigem acesso que pode não estar disponível:
 *   - Alias "Enviar como" (Opção A) exige Verificação em 2 etapas + Senha de
 *     app na conta institucional — bloqueado se a política do Workspace
 *     não permitir e você não tiver acesso ao Admin Console pra liberar.
 *   - Este relay (Opção B) só exige conseguir criar/publicar UM projeto
 *     Apps Script novo com a conta institucional — não depende de nenhuma
 *     configuração de segurança da conta nem de acesso de administrador.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * COMO IMPLANTAR (uma vez só)
 * ═══════════════════════════════════════════════════════════════════════
 *  1. script.google.com, logado na conta INSTITUCIONAL → Novo projeto.
 *  2. Cole o conteúdo deste arquivo nele (substitua o Código.gs padrão).
 *  3. No editor: selecione a função `gerarSegredoRelay`, execute, copie o
 *     valor do log.
 *  4. NÃO dá pra passar argumento direto pelo botão Executar. Cole no final
 *     do arquivo uma função temporária só pra essa chamada:
 *       function configurarSegredoAgora() {
 *         definirSegredoRelay('cole-aqui-o-valor-copiado-no-passo-3');
 *       }
 *     Salve, selecione `configurarSegredoAgora` no menu de funções, execute,
 *     confira no log "Segredo do relay definido.", e SÓ DEPOIS apague essa
 *     função temporária do arquivo (não deixar o segredo salvo em texto).
 *  5. Implantar → Nova implantação → Tipo: App da Web.
 *       Executar como: Eu (a conta institucional)
 *       Quem tem acesso: Qualquer pessoa
 *     Copie a URL .../exec gerada.
 *  6. No projeto NOVO do VigiRAM (conta pessoal), Script Properties:
 *       RELAY_EMAIL_URL    = <URL .../exec copiada no passo 5>
 *       RELAY_EMAIL_SECRET = <mesmo valor do passo 3/4>
 *     A partir daí, _enviarEmail_() (Utils.gs) passa a tentar este relay
 *     primeiro, com fallback automático pro envio direto se o relay não
 *     responder — não precisa mexer em mais nada no VigiRAM.
 *
 * Rotação do segredo: repita os passos 3-4 aqui E atualize
 * RELAY_EMAIL_SECRET no projeto do VigiRAM com o mesmo valor nesse mesmo
 * momento — como no ETL_SECRET, nunca deixe o segredo hardcoded no código.
 * ═══════════════════════════════════════════════════════════════════════
 */

const _PROP_RELAY_SECRET = 'RELAY_EMAIL_SECRET';
const _RELAY_JANELA_SEG  = 300; // ±5 min, mesma janela anti-replay do ETL

// ─────────────────────────────────────────────────────────────────────────────
// HMAC / HEX / COMPARAÇÃO — duplicado de Security.gs de propósito: este
// projeto é standalone e não pode depender de nenhum outro arquivo do
// VigiRAM (é exatamente por isso que é seguro apagar o projeto principal
// sem afetar o envio de e-mail).
// ─────────────────────────────────────────────────────────────────────────────
function bytesParaHexRelay(bytes) {
  return bytes.map(function (b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');
}

function hmacHexRelay(mensagem, segredo) {
  const raw = Utilities.computeHmacSha256Signature(
    String(mensagem), String(segredo), Utilities.Charset.UTF_8
  );
  return bytesParaHexRelay(raw);
}

function comparacaoSeguraRelay(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return r === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEGREDO — mesmo padrão do ETL_SECRET (Security.gs) do projeto principal.
// ─────────────────────────────────────────────────────────────────────────────
function getSegredoRelay() {
  return PropertiesService.getScriptProperties().getProperty(_PROP_RELAY_SECRET) || '';
}

/** Rode UMA vez no editor pra ver o segredo sugerido (copie do log). */
function gerarSegredoRelay() {
  const s = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  Logger.log('RELAY_EMAIL_SECRET sugerido: %s', s);
  return s;
}

/**
 * Grava o segredo. NÃO dá pra rodar direto pelo botão Executar (ele não
 * aceita argumento) — crie uma função temporária que chama esta aqui com o
 * valor colado, execute a temporária, confirme o log, e apague a
 * temporária depois. Ver instruções no topo do arquivo.
 */
function definirSegredoRelay(segredo) {
  if (!segredo || String(segredo).length < 24) {
    throw new Error('Use um segredo com ao menos 24 caracteres aleatórios.');
  }
  PropertiesService.getScriptProperties().setProperty(_PROP_RELAY_SECRET, String(segredo));
  return 'Segredo do relay definido.';
}

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST — único uso: enviar 1 e-mail assinado por HMAC.
 * Query string: ?ts=<epoch_seg>&sig=<hex>
 *   sig = HMAC_SHA256( ts + "\n" + corpo_bruto , RELAY_EMAIL_SECRET )
 * Corpo (JSON): { to, subject, htmlBody? , body? , name? }
 */
function doPost(e) {
  try {
    const segredo = getSegredoRelay();
    if (!segredo) throw new Error('RELAY_EMAIL_SECRET não configurado neste projeto.');

    const ts  = String((e.parameter && e.parameter.ts)  || '');
    const sig = String((e.parameter && e.parameter.sig) || '').toLowerCase();
    if (!ts || !sig) throw new Error('Requisição não assinada.');

    const tsNum = parseInt(ts, 10);
    const agora = Math.floor(Date.now() / 1000);
    if (!tsNum || Math.abs(agora - tsNum) > _RELAY_JANELA_SEG) {
      throw new Error('Janela de tempo expirada.');
    }

    const corpo = (e.postData && e.postData.contents) ? e.postData.contents : '';
    const esperado = hmacHexRelay(ts + '\n' + corpo, segredo);
    if (!comparacaoSeguraRelay(esperado, sig)) throw new Error('Assinatura inválida.');

    const dados = JSON.parse(corpo);
    if (!dados.to || !dados.subject || (!dados.htmlBody && !dados.body)) {
      throw new Error('Campos obrigatórios ausentes (to, subject, htmlBody ou body).');
    }

    MailApp.sendEmail({
      to: String(dados.to),
      name: dados.name ? String(dados.name) : 'VigiRAM',
      subject: String(dados.subject),
      htmlBody: dados.htmlBody ? String(dados.htmlBody) : undefined,
      body: dados.body ? String(dados.body) : undefined
    });

    return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (erro) {
    console.error('Relay e-mail institucional — erro: ' + erro.message);
    return ContentService.createTextOutput(JSON.stringify({ status: 'erro', mensagem: erro.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/** GET só existe pra confirmar visualmente que a implantação está no ar. */
function doGet() {
  return ContentService.createTextOutput('Relay de e-mail institucional VigiRAM — só aceita POST assinado.');
}
