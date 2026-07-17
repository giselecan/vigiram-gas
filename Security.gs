/**
 * @fileoverview Security.gs — Camada de segurança de borda (Fase 7).
 *
 *  #2 — Autenticação dos endpoints de ESCRITA do ETL (doPost):
 *       insertDB e uploadRaw passam a exigir assinatura HMAC-SHA256.
 *       A requisição traz ?ts=<epoch_seg>&sig=<hex>, onde:
 *           sig = HMAC_SHA256( ts + "\n" + corpo_bruto , ETL_SECRET )
 *       Validações: janela de ±300s (anti-replay temporal) e comparação de
 *       tempo constante. O segredo vive em Script Properties (nunca no código).
 *
 *       Anti-replay: dentro da janela de 300s a mesma requisição poderia ser
 *       reenviada. Para insertDB a deduplicação por id_caso já neutraliza
 *       inserções repetidas; para uploadRaw o risco é, no máximo, um backup
 *       duplicado. Reduza a janela se desejar endurecer.
 *
 *  Também: allowlist opcional de pastas do Drive para uploadRaw, evitando que
 *  um folderId arbitrário (parâmetro controlável) direcione escrita para
 *  qualquer pasta acessível ao deployer.
 *
 *  Helpers de hash/hex/comparação são reutilizados por Auth.gs (#3).
 *
 *  CONTENÇÃO DO PILOTO — verificarAmbienteAutorizado_() (chamada em todo
 *  doGet/doPost, ver Router.gs) trava três coisas, todas via Script
 *  Properties (nunca hardcoded): (1) hash de adulteração da autoria,
 *  (2) e-mail do deployer / scriptId autorizado — bloqueia cópia do projeto
 *  feita por outra conta/unidade, e (3) validade do piloto (opcional, ver
 *  definirValidadePiloto_()) — bloqueia o uso, mesmo do ambiente já
 *  autorizado, após a data combinada, para evitar que o piloto se estenda
 *  ou seja replicado para outra unidade hospitalar sem um novo acordo.
 *  Isto NÃO substitui um acordo formal de uso/piloto com a instituição —
 *  é só a trava técnica, redundante com o combinado por escrito.
 */

const _PROP_ETL_SECRET   = 'ETL_SECRET';
const _PROP_ETL_FOLDERS  = 'ETL_FOLDER_IDS'; // CSV opcional de folderIds permitidos
const _ETL_JANELA_SEG    = 300;               // ±5 min (anti-replay)

// ─────────────────────────────────────────────────────────────────────────────
// HMAC / HEX / COMPARAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

/** Converte byte array (assinado) em string hex minúscula. */
function bytesParaHex_(bytes) {
  return bytes.map(function (b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');
}

/** HMAC-SHA256(mensagem, segredo) → hex. */
function hmacHex_(mensagem, segredo) {
  const raw = Utilities.computeHmacSha256Signature(
    String(mensagem), String(segredo), Utilities.Charset.UTF_8
  );
  return bytesParaHex_(raw);
}

/** Comparação de strings em tempo constante (evita timing attacks). */
function comparacaoSegura_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return r === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEGREDO DO ETL
// ─────────────────────────────────────────────────────────────────────────────

function getSegredoETL_() {
  return PropertiesService.getScriptProperties().getProperty(_PROP_ETL_SECRET) || '';
}

// SEGURANÇA: estas 4 funções de setup terminam em "_" DE PROPÓSITO — sem o
// sufixo, ficariam expostas a google.script.run e QUALQUER visitante anônimo da
// URL do Web App poderia sobrescrever o ETL_SECRET (quebrando o HMAC do doPost)
// ou zerar a allowlist de pastas. O "_" as remove do google.script.run mas elas
// continuam executáveis manualmente pelo editor do Apps Script (que é o único
// uso pretendido). Ao rodar, selecione a função no editor e clique em Executar.
function verSegredoETL_() {
  const s = getSegredoETL_();
  Logger.log(s ? ('OK, length=' + s.length) : 'VAZIO — ETL_SECRET não está salvo');
  return s;
}

/**
 * Define o segredo do ETL. Rode UMA vez no editor e guarde o MESMO valor no
 * PowerShell. Ex.: definirSegredoETL_('cole-aqui-um-valor-aleatorio-longo')
 */
function definirSegredoETL_(segredo) {
  if (!segredo || String(segredo).length < 24) {
    throw new Error('Use um segredo com ao menos 24 caracteres aleatórios.');
  }
  PropertiesService.getScriptProperties().setProperty(_PROP_ETL_SECRET, String(segredo));
  return 'Segredo do ETL definido.';
}

/** Gera um segredo aleatório forte (copie para o PowerShell). */
function gerarSegredoETL_() {
  const s = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  Logger.log('ETL_SECRET sugerido: %s', s);
  return s;
}

/** Define a allowlist de pastas do Drive para uploadRaw (CSV de IDs). */
function definirPastasETL_(csvFolderIds) {
  PropertiesService.getScriptProperties()
    .setProperty(_PROP_ETL_FOLDERS, String(csvFolderIds || '').trim());
  return 'Allowlist de pastas atualizada.';
}

// ─────────────────────────────────────────────────────────────────────────────
// VERIFICAÇÃO DA REQUISIÇÃO ETL (chamada no doPost — Router.gs)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Valida a assinatura HMAC do POST do ETL. Lança erro se inválida.
 * @param {Object} e - evento do doPost
 */
function verificarAssinaturaETL_(e) {
  const segredo = getSegredoETL_();
  if (!segredo) throw new Error('ETL_SECRET não configurado no servidor.');

  const ts  = String((e.parameter && e.parameter.ts)  || '');
  const sig = String((e.parameter && e.parameter.sig) || '').toLowerCase();
  if (!ts || !sig) throw new Error('Requisição não assinada.');

  const tsNum = parseInt(ts, 10);
  const agora = Math.floor(Date.now() / 1000);
  if (!tsNum || Math.abs(agora - tsNum) > _ETL_JANELA_SEG) {
    throw new Error('Janela de tempo expirada (verifique o relógio do robô).');
  }

  const corpo    = (e.postData && e.postData.contents) ? e.postData.contents : '';
  const esperado = hmacHex_(ts + '\n' + corpo, segredo);
  if (!comparacaoSegura_(esperado, sig)) throw new Error('Assinatura inválida.');

  return true;
}

/**
 * Garante que o folderId esteja na allowlist, QUANDO ela estiver configurada.
 * Sem allowlist definida, mantém compatibilidade (apenas registra aviso).
 */
function validarFolderPermitido_(folderId) {
  const csv = PropertiesService.getScriptProperties().getProperty(_PROP_ETL_FOLDERS) || '';
  if (!csv.trim()) {
    console.warn('ETL_FOLDER_IDS não configurado — folderId não validado.');
    return true;
  }
  const permitidos = csv.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (permitidos.indexOf(String(folderId).trim()) === -1) {
    throw new Error('folderId não autorizado.');
  }
  return true;
}

// [REMOVIDO — CRÍTICO] _setupSegredo() continha o ETL_SECRET hardcoded no
// código-fonte (e, por consequência, no backup .md exportado). Segredo em
// código = segredo comprometido: rotacione IMEDIATAMENTE.
// Procedimento de rotação:
//   1. No editor: rode gerarSegredoETL_() e copie o valor do log.
//   2. No editor: rode definirSegredoETL_('<valor copiado>') digitando na
//      janela de execução — NUNCA salve o valor em arquivo .gs.
//   3. Atualize o mesmo valor no Pipeline_v3.ps1 (lado PowerShell).
//   4. Confirme com verSegredoETL_() (loga apenas o tamanho, nunca o valor).

const _PROP_ENV_EMAIL     = 'VIGIRAM_OWNER_EMAIL';
const _PROP_ENV_SCRIPT_ID = 'VIGIRAM_AUTHORIZED_SCRIPT_ID';
const _PROP_PILOT_EXPIRA  = 'VIGIRAM_PILOT_EXPIRA'; // AAAA-MM-DD — opcional, ver definirValidadePiloto_()

const _AUTORIA_GISELE_ = Object.freeze({
  AUTOR:   'GISELE CRISTINE ARAUJO NASCIMENTO',
  PROJETO: 'VigiRAM',
  EMAILS_AUTORIZADOS_PADRAO: Object.freeze([
    'giselechereese@gmail.com',
    'gisele.can@isgh.org.br'
  ])
});

function _hashSecurityGISELE_() {
  const HASH_AUTORIA_ESPERADO =
    'bad7946daaf875596c1401c489d5c8aa3feb677bee217b03cc94f138b50c7de9';
  const base = _AUTORIA_GISELE_.AUTOR + '|' + _AUTORIA_GISELE_.PROJETO;
  const hashAtual = hmacHex_(base, 'VIGIRAM_IP_PROTECT_2026');
  if (hashAtual !== HASH_AUTORIA_ESPERADO) {
    throw new Error(
      'VigiRAM: assinatura de autoria adulterada ou ausente. Sistema bloqueado. ' +
      'Este software é propriedade intelectual de ' + _AUTORIA_GISELE_.AUTOR + '.'
    );
  }
  return true;
}

function verificarAmbienteAutorizado_() {
  _hashSecurityGISELE_();

  const props = PropertiesService.getScriptProperties();

  const emailAtual = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  const csvAutorizados = props.getProperty(_PROP_ENV_EMAIL);
  const emailsAutorizados = (csvAutorizados ? csvAutorizados.split(',') : _AUTORIA_GISELE_.EMAILS_AUTORIZADOS_PADRAO)
    .map(function (e) { return String(e || '').trim().toLowerCase(); })
    .filter(Boolean);

  if (emailAtual && emailsAutorizados.length && emailsAutorizados.indexOf(emailAtual) === -1) {
    throw new Error(
      'VigiRAM: ambiente de execução não autorizado (identidade de deploy divergente). ' +
      'Este sistema é propriedade intelectual de ' + _AUTORIA_GISELE_.AUTOR +
      ' e está licenciado para uso exclusivo da unidade autorizada. ' +
      'Cópias não autorizadas deste projeto ficam bloqueadas automaticamente.'
    );
  }

  const scriptIdAtual = ScriptApp.getScriptId();
  const scriptIdAutorizado = props.getProperty(_PROP_ENV_SCRIPT_ID);

  if (scriptIdAutorizado && scriptIdAtual !== scriptIdAutorizado) {
    throw new Error(
      'VigiRAM: projeto de script não autorizado (scriptId divergente do original). ' +
      'Este sistema é propriedade intelectual de ' + _AUTORIA_GISELE_.AUTOR + '. ' +
      'Cópias não autorizadas deste projeto ficam bloqueadas automaticamente.'
    );
  }

  // Validade do piloto (opcional — sem PILOT_EXPIRA definido, sem expiração automática).
  // Ver definirValidadePiloto_(). Passada a data, bloqueia até renovação manual, mesmo
  // para o ambiente já autorizado — evita que o piloto continue (ou seja estendido a
  // outra unidade) indefinidamente sem um novo acordo.
  const dataExpiracaoPiloto = props.getProperty(_PROP_PILOT_EXPIRA);
  if (dataExpiracaoPiloto) {
    const limite = new Date(dataExpiracaoPiloto + 'T23:59:59-03:00');
    if (!isNaN(limite.getTime()) && Date.now() > limite.getTime()) {
      throw new Error(
        'VigiRAM: piloto expirado em ' + dataExpiracaoPiloto + '. ' +
        'Este sistema é um piloto de propriedade intelectual de ' + _AUTORIA_GISELE_.AUTOR +
        ', licenciado por prazo determinado. O uso contínuo ou a expansão para outra ' +
        'unidade após esse prazo não está autorizado. Para renovar ou negociar o uso ' +
        'comercial, entre em contato com ' + _AUTORIA_GISELE_.AUTOR + '.'
      );
    }
  }

  return true;
}

// SEGURANÇA: setters de validade do piloto terminam em "_" DE PROPÓSITO — mesmo motivo
// dos setters do ETL_SECRET acima: sem o sufixo ficariam expostos a google.script.run e
// qualquer visitante anônimo poderia apagar/estender o prazo do piloto. Rodar manualmente
// pelo editor do Apps Script.

/**
 * Define a data-limite do piloto. Após 23:59 (horário de Brasília) dessa data,
 * verificarAmbienteAutorizado_() passa a bloquear doGet/doPost até alguém rodar
 * de novo esta função com uma nova data (renovação) ou removerValidadePiloto_().
 * Ex.: definirValidadePiloto_('2026-12-31')
 */
function definirValidadePiloto_(dataISO) {
  const data = String(dataISO || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || isNaN(new Date(data + 'T23:59:59-03:00').getTime())) {
    throw new Error("Use o formato AAAA-MM-DD. Ex.: definirValidadePiloto_('2026-12-31')");
  }
  PropertiesService.getScriptProperties().setProperty(_PROP_PILOT_EXPIRA, data);
  return 'Validade do piloto definida para ' + data + ' 23:59 (horário de Brasília).';
}

/** Consulta a data-limite atual do piloto (ou confirma que não há expiração automática). */
function verValidadePiloto_() {
  const data = PropertiesService.getScriptProperties().getProperty(_PROP_PILOT_EXPIRA);
  Logger.log(data ? ('Piloto expira em ' + data + ' 23:59 (horário de Brasília).')
                   : 'Sem validade definida — piloto sem expiração automática.');
  return data || null;
}

/** Remove a expiração automática do piloto (uso manual, ex. após virar contrato comercial). */
function removerValidadePiloto_() {
  PropertiesService.getScriptProperties().deleteProperty(_PROP_PILOT_EXPIRA);
  return 'Validade do piloto removida — sistema sem expiração automática.';
}

function travarAmbienteAtual_() {
  const id = ScriptApp.getScriptId();
  PropertiesService.getScriptProperties().setProperty(_PROP_ENV_SCRIPT_ID, id);
  Logger.log('Ambiente travado. scriptId autorizado = %s', id);
  return id;
}

function definirEmailsAutorizados_(csvEmails) {
  const emails = String(csvEmails || '')
    .split(',')
    .map(function (e) { return e.trim().toLowerCase(); })
    .filter(Boolean);

  if (!emails.length || emails.some(function (e) { return e.indexOf('@') === -1; })) {
    throw new Error('Informe um CSV de e-mails válidos. Ex.: "a@x.com,b@y.com"');
  }

  PropertiesService.getScriptProperties().setProperty(_PROP_ENV_EMAIL, emails.join(','));
  return 'E-mails autorizados atualizados para: ' + emails.join(', ');
}
