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

// ─────────────────────────────────────────────────────────────────────────────
// FASE 8 — PROPRIEDADE INTELECTUAL: ASSINATURA DE AUTORIA + TRAVA DE AMBIENTE
//
// VigiRAM é propriedade intelectual de GISELE CRISTINE ARAUJO NASCIMENTO,
// cedida em uso à unidade hospitalar piloto. O Apps Script não permite
// ocultar código-fonte de quem tem acesso de Editor — então esta seção não
// tenta "esconder" nada. Em vez disso: (1) deixa a autoria embutida no
// código de forma que sobrevive a uma cópia (prova de autoria) e (2) trava
// a EXECUÇÃO do sistema ao ambiente autorizado, para que uma cópia do
// projeto (via "Fazer uma cópia" no editor, ou export do código-fonte para
// outro projeto) pare de funcionar fora do ambiente original.
//
// Por que Script Properties sozinhas não bastam: elas NÃO são copiadas
// quando alguém duplica o projeto no editor do Apps Script — uma cópia
// nasce com Script Properties vazias. Por isso o e-mail autorizado tem um
// valor padrão embutido no PRÓPRIO CÓDIGO-FONTE (_AUTORIA_GISELE_ abaixo):
// mesmo uma cópia sem nenhuma configuração adicional já nasce travada,
// porque Session.getEffectiveUser() dela nunca vai bater com o padrão.
// ─────────────────────────────────────────────────────────────────────────────

const _PROP_ENV_EMAIL     = 'VIGIRAM_OWNER_EMAIL';
const _PROP_ENV_SCRIPT_ID = 'VIGIRAM_AUTHORIZED_SCRIPT_ID';

/**
 * Assinatura de autoria — âncora que não depende de Script Properties
 * (que não sobrevivem a uma cópia do projeto). Removê-la ou alterá-la exige
 * edição deliberada do código-fonte: nesse caso, _hashSecurityGISELE_()
 * (mais abaixo) deixa de bater com o valor esperado e bloqueia o sistema —
 * a adulteração da assinatura é, ela mesma, o que aciona a trava.
 */
const _AUTORIA_GISELE_ = Object.freeze({
  AUTOR:                  'GISELE CRISTINE ARAUJO NASCIMENTO',
  PROJETO:                'VigiRAM',
  EMAIL_AUTORIZADO_PADRAO: 'giselechereese@gmail.com'
});

/**
 * _hashSecurityGISELE() — trip-wire de integridade da autoria.
 * Funções vitais do sistema (login, geração de E2B, roteamento HTTP)
 * chamam esta função antes de rodar. Ela recalcula um HMAC sobre a
 * constante de autoria acima e compara com o valor gravado abaixo; se a
 * constante tiver sido alterada (ex.: name-swap para remover a autoria
 * numa cópia), o hash não bate e a função lança erro, interrompendo a
 * operação vital que dependia dela.
 * NÃO é criptografia de proteção de acesso (roda em texto aberto no V8) —
 * é assinatura + verificação de integridade, para fins de autoria.
 */
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

/**
 * Verificação estrita de ambiente de execução — chamada no início de
 * doGet/doPost (Router.gs) e replicada em funções vitais (autenticarUsuario,
 * gerarXmlE2B) como segunda camada. Compara:
 *
 *   1) Session.getEffectiveUser().getEmail() — em um Web App publicado com
 *      "Executar como: EU" (executeAs=USER_DEPLOYING, ver appsscript.json),
 *      este é o e-mail de quem FEZ O DEPLOY. Se alguém copiar o projeto e
 *      publicar a cópia como Web App próprio, este e-mail passa a ser o do
 *      copiador — e diverge do autorizado.
 *   2) ScriptApp.getScriptId() — todo projeto duplicado no editor do Apps
 *      Script recebe um ID novo. Uma vez travado (travarAmbienteAtual_),
 *      qualquer scriptId diferente do autorizado bloqueia a execução.
 *
 * Qualquer uma das duas divergências dispara erro fatal, interrompendo a
 * rota antes de qualquer leitura/escrita de dados.
 *
 * CONFIGURAÇÃO (rodar 1x no editor — mesmo padrão de definirSegredoETL_):
 *   travarAmbienteAtual_()      — registra o scriptId ATUAL como autorizado.
 *   definirEmailAutorizado_(e)  — só necessário se o e-mail de deploy for
 *                                  diferente do padrão embutido no código.
 */
function verificarAmbienteAutorizado_() {
  _hashSecurityGISELE_();

  const props = PropertiesService.getScriptProperties();

  const emailAtual = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  const emailAutorizado = String(
    props.getProperty(_PROP_ENV_EMAIL) || _AUTORIA_GISELE_.EMAIL_AUTORIZADO_PADRAO
  ).trim().toLowerCase();

  if (emailAtual && emailAutorizado && emailAtual !== emailAutorizado) {
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

  return true;
}

// SEGURANÇA: mesma convenção do bloco ETL acima — sufixo "_" de propósito,
// para não ficar exposta a google.script.run; rode manualmente no editor.
function travarAmbienteAtual_() {
  const id = ScriptApp.getScriptId();
  PropertiesService.getScriptProperties().setProperty(_PROP_ENV_SCRIPT_ID, id);
  Logger.log('Ambiente travado. scriptId autorizado = %s', id);
  return id;
}

/** Só necessário se o e-mail de deploy autorizado for diferente do padrão embutido. */
function definirEmailAutorizado_(email) {
  const limpo = String(email || '').trim().toLowerCase();
  if (!limpo || limpo.indexOf('@') === -1) throw new Error('E-mail inválido.');
  PropertiesService.getScriptProperties().setProperty(_PROP_ENV_EMAIL, limpo);
  return 'E-mail autorizado atualizado para: ' + limpo;
}
