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

/**
 * Converte um valor de data (Date, string, timestamp) para ISO 8601, sem
 * lançar erro se o valor for inválido/não-parseável — retorna null nesse
 * caso, em vez de derrubar a função chamadora inteira.
 */
function dataParaIsoSegura_(valor) {
  if (!valor) return null;
  const data = valor instanceof Date ? valor : new Date(valor);
  return isNaN(data.getTime()) ? null : data.toISOString();
}

/**
 * Interpreta um valor de data em qualquer um dos formatos usados
 * historicamente pelo projeto — Date real, "dd/MM/yyyy[ HH:mm[:ss]]" (BR)
 * ou "yyyy-MM-dd[ T]HH:mm[:ss]" (ISO, inclusive o que <input type=
 * "datetime-local"> envia) — e devolve sempre um Date real, ou null se não
 * for possível interpretar com segurança.
 *
 * Existe para dar fim à causa raiz documentada em
 * auditoria_qa_datas_tipagem_2026-07-13.md (achados #1/#4/#5/#9): o campo
 * `data`/`data_evento` era gravado em formatos concorrentes conforme a
 * origem do caso (ETL, Demanda Espontânea com/sem data preenchida), o que
 * quebrava silenciosamente o filtro de período do Kanban/Dashboard e o
 * critério de "caso de hoje" de Manuntenção.gs. Componentes são extraídos
 * e passados a `new Date(ano, mes, dia, ...)` (nunca `new Date(string)`)
 * para evitar ambiguidade de fuso/locale na hora do parse.
 */
function _parseDataFlexivel_(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return isNaN(valor.getTime()) ? null : valor;

  const s = String(valor).trim();

  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (br) {
    const d = new Date(
      parseInt(br[3], 10), parseInt(br[2], 10) - 1, parseInt(br[1], 10),
      parseInt(br[4] || '0', 10), parseInt(br[5] || '0', 10), parseInt(br[6] || '0', 10)
    );
    return isNaN(d.getTime()) ? null : d;
  }

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) {
    const d = new Date(
      parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10),
      parseInt(iso[4] || '0', 10), parseInt(iso[5] || '0', 10), parseInt(iso[6] || '0', 10)
    );
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
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
