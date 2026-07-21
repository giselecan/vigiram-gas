/**
 * @fileoverview Utils.gs — helpers que precisam viver no projeto institucional
 * (casca), porque dependem de HtmlService renderizando arquivos do próprio
 * projeto. Todo o resto dos helpers de infraestrutura (trava, parsing de
 * data, formatação de planilha etc.) foi para Utils.gs da library Backend
 * (github.com/giselecan/vigiram-backend).
 */

/**
 * Padroniza a saída das respostas HTTP da API em JSON. Cópia local — Router.gs
 * precisa dela mesmo quando a autorização do Backend falha, sem depender da
 * library nesse caminho de erro.
 */
function createJsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Inclui o conteúdo de outro arquivo HTML dentro de um template.
 * Uso no index.html: <?!= include('styles'); ?>
 */
function include (nomeArquivo) {
  return HtmlService.createHtmlOutputFromFile(nomeArquivo).getContent();
}
