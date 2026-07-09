/**
 * @fileoverview Audit.gs — Trilha de auditoria (LGPD).
 *
 * FASE 7 (#1): usuarioAtual_() passou a priorizar o e-mail resolvido do token
 * de sessão (__emailSessaoAtual, publicado por comAutenticacao_ em Auth.gs).
 *
 * Por que isto era necessário: com o Web App em "executar como eu" + acesso
 * anônimo, Session.getActiveUser().getEmail() volta VAZIO para todos. Antes,
 * toda escrita autenticada (triagem/investigação) era carimbada como "sistema",
 * anulando a rastreabilidade. Agora o carimbo reflete o farmacêutico logado.
 *
 * Ordem de prioridade da identidade:
 *   1) e-mail do token (ações do painel autenticado)
 *   2) Session.getActiveUser().getEmail() (caso o deploy o forneça)
 *   3) "sistema" (fallback)
 *
 * Origens explícitas continuam tendo precedência quando passadas diretamente
 * a carimbarAuditoria_(): "ETL" (Ingest) e "Formulário Assistência" (form DE).
 */

/** Retorna o e-mail do usuário atual (token > sessão > "sistema"). */
function usuarioAtual_() {
  if (__emailSessaoAtual) return __emailSessaoAtual;
  try {
    const email = Session.getActiveUser().getEmail();
    return email ? email : 'sistema';
  } catch (e) {
    return 'sistema';
  }
}

/**
 * Carimba auditoria (quem/quando) numa linha do DB_Casos_RAM.
 * @param {Sheet} planilha
 * @param {number} linha - linha 1-based
 * @param {string=} origem - opcional; se ausente, usa usuarioAtual_()
 */
function carimbarAuditoria_(planilha, linha, origem) {
  const quem = origem || usuarioAtual_();
  planilha.getRange(linha, SCHEMA.COL.ATUALIZADO_POR).setValue(quem);
  planilha.getRange(linha, SCHEMA.COL.ATUALIZADO_EM).setValue(new Date());
}

/**
 * Registra um evento na aba de log (se existir). Não interrompe o fluxo
 * principal em caso de erro.
 * @param {string} acao
 * @param {string} idCaso
 * @param {string=} detalhe
 */
function registrarLog_(acao, idCaso, detalhe) {
  try {
    const plan = getSheet_(SCHEMA.ABAS.LOG);
    if (!plan) return; // log é opcional
    plan.appendRow([new Date(), usuarioAtual_(), acao, idCaso || '', detalhe || '']);
  } catch (e) {
    console.error('Falha ao registrar log: ' + e.message);
  }
}
