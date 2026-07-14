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
 * Converte o valor de um <input type="number"> (sempre formato numérico
 * nativo do browser — ponto decimal, nunca vírgula) para Number antes de
 * persistir no Firestore. Vazio/nulo/não-parseável vira '' (não `null` nem
 * `0`), preservando o mesmo comportamento de "não preenchido" que o campo
 * já tinha como string vazia — leitores existentes (_mapearCasoCompleto_,
 * _normalizarNumeroE2B_) já tratam tanto Number quanto String de forma
 * segura, inclusive o valor 0 (não é tratado como "vazio").
 * Ver auditoria_qa_datas_tipagem_2026-07-13.md, achado #8.
 */
function _paraNumeroOuVazio_(v) {
  if (v === '' || v == null) return '';
  const n = Number(v);
  return isNaN(n) ? '' : n;
}

/**
 * Interpreta um valor de flag "ativo" em QUALQUER uma das convenções que
 * coexistem no projeto durante a transição documentada em
 * auditoria_qa_datas_tipagem_2026-07-13.md (achado #7): boolean (novo
 * padrão, a partir de 2026-07-13 — ver Admin.gs/Config write.gs) ou string
 * 'SIM'/'NÃO'/'NAO' (legado — ainda presente em qualquer documento gravado
 * ANTES desta correção, até rodar a migração de backfill). Campo ausente
 * é tratado como ativo — mesmo default "SIM" que o projeto já tinha antes.
 * NUNCA comparar `doc.ativo === 'SIM'` nem `doc.ativo === true` direto:
 * sempre passar por aqui, para funcionar com os dois tipos ao mesmo tempo.
 */
function _ativoComoBooleano_(valor) {
  if (valor === undefined || valor === null || valor === '') return true;
  if (typeof valor === 'boolean') return valor;
  const s = String(valor).trim().toUpperCase();
  return s !== 'NAO' && s !== 'NÃO' && s !== 'FALSE' && s !== '0';
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

/**
 * Gera o ID do documento da coleção `setores` (SCHEMA.FS.SETORES) a partir
 * do NOME do setor + e-mail do farmacêutico responsável.
 *
 * Setores como "TODOS" podem ter múltiplos farmacêuticos responsáveis
 * (mesmo setor, pessoas diferentes) — usar só o nome do setor como ID
 * causa colisão: o segundo responsável cadastrado sobrescreve o primeiro
 * silenciosamente (era exatamente o bug de "cada vez que preencho apaga o
 * anterior"). Setor+e-mail garante 1 documento por PAR setor/responsável.
 * Mesma regra usada pela migração original — ver migrarSetoresParaFirestore
 * em MigracaoFirestore.gs. Sem e-mail, cai de volta no ID legado (só setor).
 * @param {string} setor
 * @param {string} email
 * @returns {string}
 */
function _idDocSetor_(setor, email) {
  const slugSetor = String(setor || '').trim().toUpperCase()
    .replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');
  const slugEmail = String(email || '').trim().toLowerCase()
    .replace(/[^a-z0-9]/g, '_');
  return slugEmail ? (slugSetor + '__' + slugEmail) : slugSetor;
}

/**
 * Normaliza um nome de setor só para COMPARAÇÃO/agrupamento (diagnóstico de
 * duplicados) — NUNCA usar no lugar de _idDocSetor_ para gerar o ID do
 * documento, isso reintroduziria a própria duplicação que este helper serve
 * para detectar (docs antigos ficariam com ID diferente do recém-calculado).
 * Remove acento via NFD + descarte de marcas diacríticas (Á/Ã/Ç → A/A/C,
 * cobre inclusive diferenças de forma de composição Unicode ao colar de
 * Word/Excel), maiúsculas, e colapsa hífen/underscore/espaços repetidos em
 * um único espaço — assim "UTI Adulto", "UTI-ADULTO" e "uti  adulto " caem
 * na mesma chave.
 */
function _normalizarSetorComparacao_(setor) {
  return String(setor || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
