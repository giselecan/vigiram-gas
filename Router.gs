/**
 * @fileoverview Router.gs — Pontos de entrada HTTP. Só roteamento.
 * A lógica vive nos módulos Cases / Ingest / Notify. Segurança em Security.gs.
 *
 * FASE 7 (#2): doPost agora EXIGE assinatura HMAC (verificarAssinaturaETL_)
 * para as ações de escrita do ETL (uploadRaw, insertDB). Sem assinatura válida,
 * a requisição é rejeitada antes de qualquer escrita.
 */

/**
 * POST — envio de dados do PowerShell (ETL). Autenticado por HMAC.
 */
function doPost(e) {
  try {
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
    return createJsonResponse({ status: 'erro', mensagem: erro.toString() });
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
    // 1. Rota do robô PowerShell
    if (e.parameter && e.parameter.action === 'getTriggers') {
      return handleGetTriggers(); // Ingest.gs
    }

    // 2. Formulário da assistência
    if (e.parameter && e.parameter.page === 'form') {
      const htmlForm = HtmlService.createTemplateFromFile('form').evaluate();
      htmlForm.setTitle('VigiRAM - Notificação');
      htmlForm.addMetaTag('viewport', 'width=device-width, initial-scale=1');
      return htmlForm;
    }

    // 3. Painel Kanban (padrão)
    const htmlIndex = HtmlService.createTemplateFromFile('index').evaluate();
    htmlIndex.setTitle('VigiRAM');
    htmlIndex.addMetaTag('viewport', 'width=device-width, initial-scale=1');
    htmlIndex.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
    return htmlIndex;

  } catch (erro) {
    return createJsonResponse({ erro: erro.toString() });
  }
}
