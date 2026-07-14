/**
 * @fileoverview Router.gs — Pontos de entrada HTTP. Só roteamento.
 * A lógica vive nos módulos Cases / Ingest / Notify. Segurança em Security.gs.
 *
 * FASE 7 (#2): doPost agora EXIGE assinatura HMAC (verificarAssinaturaETL_)
 * para as ações de escrita do ETL (uploadRaw, insertDB). Sem assinatura válida,
 * a requisição é rejeitada antes de qualquer escrita.
 *
 * FASE 8 (IP/autoria): doGet e doPost agora chamam verificarAmbienteAutorizado_()
 * (Security.gs) como PRIMEIRA coisa dentro do try — antes de qualquer outra
 * rota ou leitura. Bloqueia TODAS as rotas se o ambiente de execução (e-mail
 * de deploy / scriptId) não bater com o autorizado — ver Security.gs.
 */

/**
 * POST — envio de dados do PowerShell (ETL). Autenticado por HMAC.
 */
function doPost(e) {
  try {
    verificarAmbienteAutorizado_(); // Security.gs — trava de ambiente/autoria (Fase 8)
    const acao = e.parameter.action;
    switch (acao) {
      case 'uploadRaw':
        verificarAssinaturaETL_(e); // Security.gs — lança se inválida
        return handleUploadRaw(e);  // Ingest.gs
      case 'insertDB':
        verificarAssinaturaETL_(e);
        return handleInsertDB(e);   // Ingest.gs
      default:
        throw new Error(`Ação POST não reconhecida ou ausente: ${acao}`);
    }
  } catch (erro) {
    // Resposta montada ANTES do log — se o log (Firestore/Sheets) demorar
    // ou falhar, o payload de erro para o robô PowerShell já está pronto.
    const resposta = createJsonResponse({ status: 'erro', mensagem: erro.toString() });
    try {
      fsRegistrarLog_('ERRO_DOPOST', 'N/A',
        String(e && e.parameter && e.parameter.action) + ' — ' + erro.toString());
    } catch (e2) { /* best-effort — nunca bloqueia a resposta */ }
    return resposta;
  }
}

/**
 * GET — navegador (painel/formulário) ou consulta do robô.
 *
 * NOTA: getTriggers permanece como leitura pública (apenas nomes de
 * medicamentos-gatilho, baixa sensibilidade). Se desejar protegê-la também,
 * é possível assinar a query no PowerShell e validar aqui — fora do escopo atual.
 */
function doGet(e) {
  try {
    verificarAmbienteAutorizado_(); // Security.gs — trava de ambiente/autoria (Fase 8)

    // 1. Rota do robô PowerShell
    if (e.parameter && e.parameter.action === 'getTriggers') {
      return handleGetTriggers(); // Ingest.gs
    }

    // 2. Formulário da assistência
    if (e.parameter && e.parameter.page === 'form') {
      const htmlForm = HtmlService.createTemplateFromFile('form').evaluate();
      htmlForm.setTitle('VigiRAM - Notificação');
      htmlForm.addMetaTag('viewport', 'width=device-width, initial-scale=1');
      aplicarFavicon_(htmlForm); // Favicon.gs — setFaviconUrl na página de cima (o <link> no HTML é ignorado no iframe do GAS)
      return htmlForm;
    }

    // 3. Painel Kanban (padrão)
    const htmlIndex = HtmlService.createTemplateFromFile('index').evaluate();
    htmlIndex.setTitle('VigiRAM');
    htmlIndex.addMetaTag('viewport', 'width=device-width, initial-scale=1');
    htmlIndex.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
    aplicarFavicon_(htmlIndex); // Favicon.gs — idem
    return htmlIndex;

  } catch (erro) {
    const resposta = createJsonResponse({ erro: erro.toString() });
    try {
      fsRegistrarLog_('ERRO_DOGET', 'N/A',
        String(e && e.parameter && (e.parameter.action || e.parameter.page)) + ' — ' + erro.toString());
    } catch (e2) { /* best-effort — nunca bloqueia a resposta */ }
    return resposta;
  }
}
