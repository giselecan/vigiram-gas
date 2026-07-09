/**
 * @fileoverview Utils.gs — helpers de infraestrutura reutilizados por todos os módulos.
 */

const LOCK_TIMEOUT_MS = 30000;

/**
 * Executa uma operação de escrita protegida por trava global.
 * Impede que o ETL (PowerShell) e ações manuais do painel escrevam ao mesmo tempo.
 */
function comTrava_(operacao) {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    return operacao();
  } finally {
    lock.releaseLock();
  }
}

/** Retorna a aba pelo nome, ou null se não existir (sem lançar erro). */
function getSheet_(nomeAba) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nomeAba);
}

/** Retorna a aba pelo nome, lançando erro claro se não existir. */
function getSheetOuErro_(nomeAba) {
  const aba = getSheet_(nomeAba);
  if (!aba) throw new Error(`Aba "${nomeAba}" não localizada na planilha.`);
  return aba;
}

/**
 * Lê uma célula de uma linha de matriz usando a coluna 1-based do SCHEMA.
 * Ex.: cel(linha, SCHEMA.COL.SETOR)
 */
function cel(linha, coluna1based) {
  return linha[coluna1based - 1];
}

/**
 * Localiza a linha (1-based) de um caso pelo ID, buscando SOMENTE na coluna A.
 * Substitui a varredura O(n) por TextFinder.
 * @returns {number} número da linha, ou -1 se não encontrado.
 */
function localizarLinhaCaso_(planilha, idCaso) {
  const idAlvo = String(idCaso).trim();
  const ultimaLinha = planilha.getLastRow();
  if (ultimaLinha < 2) return -1;
  const match = planilha
    .getRange(1, SCHEMA.COL.ID, ultimaLinha, 1)
    .createTextFinder(idAlvo)
    .matchEntireCell(true)
    .findNext();
  return match ? match.getRow() : -1;
}

/** Escapa caracteres HTML para impedir injeção em e-mails. */
function escaparHtml_(texto) {
  return String(texto == null ? "" : texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Padroniza a saída das respostas HTTP da API em JSON. */
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
