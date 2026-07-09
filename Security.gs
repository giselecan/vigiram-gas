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

function _verSegredo() {
  const s = getSegredoETL_();
  Logger.log(s ? ('OK, length=' + s.length) : 'VAZIO — ETL_SECRET não está salvo');
  return s;
}

/**
 * Define o segredo do ETL. Rode UMA vez no editor e guarde o MESMO valor no
 * PowerShell. Ex.: definirSegredoETL('cole-aqui-um-valor-aleatorio-longo')
 */
function definirSegredoETL(segredo) {
  if (!segredo || String(segredo).length < 24) {
    throw new Error('Use um segredo com ao menos 24 caracteres aleatórios.');
  }
  PropertiesService.getScriptProperties().setProperty(_PROP_ETL_SECRET, String(segredo));
  return 'Segredo do ETL definido.';
}

/** Gera um segredo aleatório forte (copie para o PowerShell). */
function gerarSegredoETL() {
  const s = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  Logger.log('ETL_SECRET sugerido: %s', s);
  return s;
}

/** Define a allowlist de pastas do Drive para uploadRaw (CSV de IDs). */
function definirPastasETL(csvFolderIds) {
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
//   1. No editor: rode gerarSegredoETL() e copie o valor do log.
//   2. No editor: rode definirSegredoETL('<valor copiado>') digitando na
//      janela de execução — NUNCA salve o valor em arquivo .gs.
//   3. Atualize o mesmo valor no Pipeline_v3.ps1 (lado PowerShell).
//   4. Confirme com _verSegredo() (loga apenas o tamanho, nunca o valor).
