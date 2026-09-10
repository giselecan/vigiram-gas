/**
 * @fileoverview Audit.gs — Identidade do usuário atual (LGPD).
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
 * CORREÇÃO (auditoria_qa_datas_tipagem_2026-07-13.md #6): as funções
 * carimbarAuditoria_() e registrarLog_() que existiam aqui gravavam DIRETO
 * no Sheets (Date real, sem trava de concorrência) e já não tinham nenhum
 * chamador — todo o sistema migrou para fsCarimbarAuditoria_()/
 * fsRegistrarLog_() (Firestore.gs), que gravam no Firestore como fonte
 * única e espelham no Sheets como string formatada (Mirror.gs), sob
 * comTrava_(). A última chamadora remanescente (Admin.gs) foi migrada para
 * fsRegistrarLog_() junto com esta limpeza — era a causa raiz de DB_Log
 * misturar Date real (ações de Admin) e string (todo o resto) na mesma
 * coluna. Removidas por serem código morto e por manter viva uma rota de
 * escrita sem trava para o mesmo arquivo que Mirror.gs protege.
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
