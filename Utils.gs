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

/**
 * Retorna a planilha do sistema. Um projeto vinculado (container-bound) a
 * ela resolve via getActiveSpreadsheet() sem configuração nenhuma — é o
 * caso de implantações mais antigas. Um projeto avulso (standalone, ex.:
 * criado via `clasp create`) não tem planilha "ativa" nenhuma, então
 * precisa da Script Property PLANILHA_ID (planilha precisa estar
 * compartilhada como Editor com a conta que executa o script).
 */
function getPlanilha_() {
  const id = PropertiesService.getScriptProperties().getProperty('PLANILHA_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

/** Retorna a aba pelo nome, ou null se não existir (sem lançar erro). */
function getSheet_(nomeAba) {
  return getPlanilha_().getSheetByName(nomeAba);
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
    .replace(/[-_./]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Remove zeros à esquerda em números dentro do nome do setor (ex.: "POSTO 01" -> "POSTO 1").
 * @param {string} s
 * @returns {string}
 */
function _padronizarZerosSetor_(s) {
  return String(s || '').replace(/\b0+(\d+)\b/g, function (m, p1) { return p1; });
}

/**
 * Converte numerais arábicos (1 a 10) para romanos em tokens de setores (ex: "UTI ADULTO 1" -> "UTI ADULTO I").
 * @param {string} s
 * @returns {string}
 */
function _converterArabicoParaRomanoSetor_(s) {
  if (!s) return '';
  const mapa = { '1': 'I', '2': 'II', '3': 'III', '4': 'IV', '5': 'V', '6': 'VI', '7': 'VII', '8': 'VIII', '9': 'IX', '10': 'X' };
  return String(s).replace(/\b(\d{1,2})\b/g, function (match, n) {
    return mapa[n] || match;
  });
}

/**
 * Converte numerais romanos (I a X) para arábicos em tokens de setores (ex: "UTI ADULTO I" -> "UTI ADULTO 1").
 * @param {string} s
 * @returns {string}
 */
function _converterRomanoParaArabicoSetor_(s) {
  if (!s) return '';
  const mapa = { 'I': '1', 'II': '2', 'III': '3', 'IV': '4', 'V': '5', 'VI': '6', 'VII': '7', 'VIII': '8', 'IX': '9', 'X': '10' };
  return String(s).replace(/\b(X|IX|VIII|VII|VI|V|IV|III|II|I)\b/g, function (match, r) {
    return mapa[r] || match;
  });
}

/**
 * Dicionário de abreviações e termos hospitalares comuns no Brasil.
 */
const _ABREVIACOES_HOSPITALARES_ = {
  'UTI': 'UNIDADE DE TERAPIA INTENSIVA',
  'CTI': 'CENTRO DE TERAPIA INTENSIVA',
  'CC': 'CENTRO CIRURGICO',
  'CO': 'CENTRO OBSTETRICO',
  'CM': 'CLINICA MEDICA',
  'PED': 'PEDIATRIA',
  'PEDIATRICA': 'PEDIATRIA',
  'PEDIATRICO': 'PEDIATRIA',
  'NEO': 'NEONATAL',
  'NEONATOLOGIA': 'NEONATAL',
  'ENF': 'ENFERMARIA',
  'AD': 'ADULTO',
  'PS': 'PRONTO SOCORRO',
  'PA': 'PRONTO ATENDIMENTO',
  'AMB': 'AMBULATORIO',
  'APTO': 'APARTAMENTO',
  'APTOS': 'APARTAMENTO',
  'CIR': 'CIRURGIA',
  'CIRURGICA': 'CIRURGIA',
  'CIRURGICO': 'CIRURGIA',
  'OBST': 'OBSTETRICIA',
  'OBSTETRICA': 'OBSTETRICIA',
  'RPA': 'RECUPERACAO POS ANESTESICA',
  'HD': 'HOSPITAL DIA',
  'ISOL': 'ISOLAMENTO',
  'CARDIO': 'CARDIOLOGIA',
  'ONCO': 'ONCOLOGIA'
};

/**
 * Expande tokens abreviados para seu equivalente completo.
 * @param {string} str
 * @returns {string}
 */
function _expandirAbreviacoesSetor_(str) {
  const tokens = String(str || '').split(' ');
  return tokens.map(function (t) { return _ABREVIACOES_HOSPITALARES_[t] || t; }).join(' ');
}

/**
 * Distância de Levenshtein entre duas strings.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function _levenshteinDistancia_(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = [];
  for (let i = 0; i <= m; i++) d[i] = [i];
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

/**
 * Calcula a similaridade entre dois nomes de setores considerando acentuação,
 * pontuação, zeros à esquerda, abreviações hospitalares e sobreposição de termos.
 * @param {string} s1
 * @param {string} s2
 * @returns {{ score: number, porcentagem: number, motivo: string, compativel: boolean }}
 */
function _calcularSimilaridadeSetores_(s1, s2) {
  const n1 = _normalizarSetorComparacao_(s1);
  const n2 = _normalizarSetorComparacao_(s2);
  if (!n1 || !n2) return { score: 0, porcentagem: 0, motivo: 'Vazio', compativel: false };
  if (n1 === n2) return { score: 1.0, porcentagem: 100, motivo: 'Grafia idêntica', compativel: true };

  const z1 = _padronizarZerosSetor_(n1);
  const z2 = _padronizarZerosSetor_(n2);
  if (z1 === z2) return { score: 0.98, porcentagem: 98, motivo: 'Numeração equivalente (com/sem zeros)', compativel: true };

  const e1 = _expandirAbreviacoesSetor_(z1);
  const e2 = _expandirAbreviacoesSetor_(z2);
  if (e1 === e2) return { score: 0.95, porcentagem: 95, motivo: 'Abreviação hospitalar compatível', compativel: true };

  const t1 = z1.split(' ').filter(Boolean);
  const t2 = z2.split(' ').filter(Boolean);
  const set1 = {}; t1.forEach(function (x) { set1[x] = true; });
  const set2 = {}; t2.forEach(function (x) { set2[x] = true; });
  let inter = 0;
  t1.forEach(function (x) { if (set2[x]) inter++; });
  const dice = (2 * inter) / (t1.length + t2.length);

  const menor = t1.length <= t2.length ? t1 : t2;
  const maiorSet = t1.length <= t2.length ? set2 : set1;
  const contemTodos = menor.length > 0 && menor.every(function (x) { return !!maiorSet[x]; });

  const maxLen = Math.max(z1.length, z2.length);
  const dist = _levenshteinDistancia_(z1, z2);
  const levSim = maxLen > 0 ? (1 - dist / maxLen) : 0;

  const maxLenExp = Math.max(e1.length, e2.length);
  const distExp = _levenshteinDistancia_(e1, e2);
  const levSimExp = maxLenExp > 0 ? (1 - distExp / maxLenExp) : 0;

  let score = Math.max(levSim, levSimExp, dice);
  let motivo = 'Similaridade léxica';

  if (contemTodos) {
    const scoreSubset = 0.82 + (0.13 * (inter / Math.max(t1.length, t2.length)));
    if (scoreSubset > score) {
      score = scoreSubset;
      motivo = 'Contém todos os termos chave';
    }
  }

  if (levSim >= 0.85) motivo = 'Grafia muito próxima (variação/digitação)';
  else if (dice >= 0.70) motivo = 'Termos quase idênticos';

  score = Math.round(score * 100) / 100;
  const pct = Math.round(score * 100);
  return { score: score, porcentagem: pct, motivo: motivo, compativel: pct >= 55 };
}

/**
 * Encontra a melhor correspondência para um setor dentro de uma lista de candidatos.
 * @param {string} setorAlvo
 * @param {string[]} listaCandidatos
 * @returns {{ setor: string, score: number, porcentagem: number, motivo: string, compativel: boolean } | null}
 */
function _encontrarMelhorCorrespondenciaSetor_(setorAlvo, listaCandidatos) {
  if (!setorAlvo || !Array.isArray(listaCandidatos) || !listaCandidatos.length) return null;
  let melhor = null;
  for (let i = 0; i < listaCandidatos.length; i++) {
    const cand = String(listaCandidatos[i] || '').trim();
    if (!cand) continue;
    const sim = _calcularSimilaridadeSetores_(setorAlvo, cand);
    if (!melhor || sim.score > melhor.score) {
      melhor = {
        setor: cand,
        score: sim.score,
        porcentagem: sim.porcentagem,
        motivo: sim.motivo,
        compativel: sim.compativel
      };
    }
  }
  return (melhor && melhor.compativel) ? melhor : null;
}

/**
 * Atualiza em lote o nome do setor na coluna SETOR (coluna 11) da planilha DB_Casos_RAM.
 * Lê a coluna 11 uma única vez, aplica o de-para em memória e regrava de uma só vez sob trava.
 * @param {Sheet} planilha
 * @param {{ [chaveNormalizada: string]: string }} deParaChaves — mapa chave_normalizada -> nome_canonico
 * @returns {number} quantidade de células atualizadas
 */
function _atualizarSetoresEmPlanilha_(planilha, deParaChaves) {
  if (!planilha || !deParaChaves || Object.keys(deParaChaves).length === 0) return 0;
  const ultimaLinha = planilha.getLastRow();
  if (ultimaLinha < 2) return 0;

  const range = planilha.getRange(2, SCHEMA.COL.SETOR, ultimaLinha - 1, 1);
  const valores = range.getValues();
  let atualizados = 0;

  for (let i = 0; i < valores.length; i++) {
    const atual = String(valores[i][0] || '').trim();
    if (!atual) continue;
    const chave = _normalizarSetorComparacao_(atual);
    if (deParaChaves[chave] && deParaChaves[chave] !== atual) {
      valores[i][0] = deParaChaves[chave];
      atualizados++;
    }
  }

  if (atualizados > 0) {
    comTrava_(function () {
      range.setValues(valores);
    });
  }
  return atualizados;
}

/**
 * Extrai dose numérica e unidade de medida a partir de uma descrição de medicamento.
 * Ex.: "FITOMENADIONA 10MG/ML AMPOLA" -> { dose: "10", unidade: "MG/ML" }
 * Ex.: "DIPIRONA 500 MG" -> { dose: "500", unidade: "MG" }
 * @param {string} texto
 * @returns {{ dose: string, unidade: string }}
 */
function _extrairDoseEUnidadeMedicamento_(texto) {
  if (!texto) return { dose: '', unidade: '' };
  const str = String(texto).toUpperCase().trim();
  const regex = /(?:\b(\d+(?:[.,]\d+)?)\s*(MG\/ML|MCG\/ML|UG\/ML|UI\/ML|G\/ML|MEQ\/ML|MMOL\/ML|MG|MCG|UG|UI|G|KG|ML)(?!\w)|\b(\d+(?:[.,]\d+)?)\s*(%))/i;
  const match = str.match(regex);
  if (match) {
    const dose = (match[1] || match[3] || '').replace(',', '.');
    const unidade = (match[2] || match[4] || '').toUpperCase();
    return { dose, unidade };
  }
  return { dose: '', unidade: '' };
}

/**
 * Limpa apresentações, formas farmacêuticas, embalagens, dosagens e sais de um medicamento
 * para isolar a substância ativa principal / princípio ativo.
 * @param {string} texto
 * @returns {string}
 */
function _limparFormaDosagemMedicamento_(texto) {
  if (!texto) return '';
  let s = String(texto).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

  // 1. Remove doses e concentrações
  s = s.replace(/\b\d+(?:[.,]\d+)?\s*(?:MG\/ML|MCG\/ML|UG\/ML|UI\/ML|G\/ML|MEQ\/ML|MMOL\/ML|MG|MCG|UG|UI|G|KG|ML)(?!\w)/gi, ' ');
  s = s.replace(/\b\d+(?:[.,]\d+)?\s*%/g, ' ');
  s = s.replace(/\b\d+(?:[.,]\d+)?\b/g, ' ');

  // 2. Remove formas farmacêuticas e embalagens
  s = s.replace(/\b(?:SOLUCAO|SOL|INJETAVEL|INJ|AMPOLA|AMP|FRASCO|FR|COMPRIMIDO|COMP|CAPSULA|CAP|GOTAS|GTS|XAROPE|SUSPENSAO|SUSP|POMADA|CREME|PO|LIOFILIZADO|LIOF|BOLUS|INFUSAO|ENV|ENVELOPE|SERINGA|SER|ADESIVO|TUBO|BISNAGA|COLIRIO|SPRAY|AEROSOL|DRAGEA|DRG)\b/gi, ' ');

  // 3. Remove sais e qualificadores químicos comuns
  s = s.replace(/\b(?:CLORIDRATO|SULFATO|FOSFATO|ACETATO|CITRATO|CARBONATO|BROMETO|GLUCONATO|MALEATO|SUCCINATO|LACTATO|SODICA|SODICO|POTASSICA|POTASSICO|DIPOTASSICO|DISSODICO|CALCICA|CALCICO|MONOIDRATADA|MONOHIDRATADA|DIIDRATADA|HEMIDRATADA|BASE)\b/gi, ' ');

  // 4. Remove conectivos e pontuação
  s = s.replace(/\b(?:DE|DO|DA|COM|E|EM|POR|PARA)\b/gi, ' ');
  s = s.replace(/[-_./\\(),;:+*#&%]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

/**
 * Normaliza a chave para comparação estrita de medicamentos (sem acento, sem pontuação, sem espaços).
 * @param {string} str
 * @returns {string}
 */
function _normalizarChaveGatilho_(str) {
  return String(str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

/**
 * Normaliza as iniciais do paciente para formato padronizado com pontos (ex.: "J.S." ou "J.C.A.").
 * @param {string} iniciais
 * @returns {string}
 */
function _normalizarIniciaisPaciente_(iniciais) {
  const str = String(iniciais || '').trim().toUpperCase();
  if (!str) return 'N/I';

  // Se já for formado por letras soltas ou separadas por espaço/ponto (ex: "J S", "J. S.", "J.S.", "JS")
  const letras = str.replace(/[^A-Z]/g, '');
  if (letras.length >= 2 && letras.length <= 4 && (str.length <= 8 || str.indexOf('.') !== -1)) {
    return letras.split('').join('.') + '.';
  }

  // Se vier como nome completo por acidente (ex: "JOAO SILVA"), extrai iniciais
  const partes = str.split(/\s+/).filter(function (p) {
    return p.length > 2 || !/^(DE|DA|DO|DOS|DAS)$/i.test(p);
  });
  if (partes.length >= 2) {
    return (partes[0][0] + '.' + partes[partes.length - 1][0] + '.');
  }

  return str.replace(/\s+/g, ' ');
}

/**
 * Normaliza o campo sexo para 'M' ou 'F' (alinhado ao E2B D.5 administrativeGenderCode).
 * @param {string} sexo
 * @returns {string}
 */
function _normalizarSexo_(sexo) {
  if (!sexo) return '';
  const s = String(sexo).trim().toUpperCase();
  if (s === 'M' || s === 'MASCULINO' || s === '1') return 'M';
  if (s === 'F' || s === 'FEMININO'  || s === '2') return 'F';
  return '';
}

/**
 * Atualiza em lote o nome do medicamento na coluna MEDICAMENTO (coluna 12) da planilha DB_Casos_RAM.
 * @param {Sheet} planilha
 * @param {{ [chaveNormalizada: string]: string }} deParaChaves
 * @returns {number} quantidade de células atualizadas
 */
function _atualizarMedicamentosEmPlanilha_(planilha, deParaChaves) {
  if (!planilha || !deParaChaves || Object.keys(deParaChaves).length === 0) return 0;
  const ultimaLinha = planilha.getLastRow();
  if (ultimaLinha < 2) return 0;

  const range = planilha.getRange(2, SCHEMA.COL.MEDICAMENTO, ultimaLinha - 1, 1);
  const valores = range.getValues();
  let atualizados = 0;

  for (let i = 0; i < valores.length; i++) {
    const atual = String(valores[i][0] || '').trim();
    if (!atual) continue;
    const chave = _normalizarChaveGatilho_(atual);
    if (deParaChaves[chave] && deParaChaves[chave] !== atual) {
      valores[i][0] = deParaChaves[chave];
      atualizados++;
    }
  }

  if (atualizados > 0) {
    comTrava_(function () {
      range.setValues(valores);
    });
  }
  return atualizados;
}

/**
 * Remove linhas do Sheets pelo ID_CASO de forma em lote rápida e segura contra deslocamento.
 * Lê a coluna A (ID_CASO) uma única vez, identifica as linhas e exclui em blocos
 * contíguos ordenados do fim para o início (deleteRows) sob comTrava_.
 * @param {Sheet} planilha
 * @param {Set<string>} idsSet
 * @returns {number} quantidade de linhas excluídas
 */
function _removerLinhasPlanilhaPorIds_(planilha, idsSet) {
  if (!planilha || !idsSet || idsSet.size === 0) return 0;
  const ultimaLinha = planilha.getLastRow();
  if (ultimaLinha < 2) return 0;

  const dadosIds = planilha.getRange(2, SCHEMA.COL.ID, ultimaLinha - 1, 1).getValues();
  const linhasParaExcluir = [];

  for (let i = 0; i < dadosIds.length; i++) {
    const idNaLinha = String(dadosIds[i][0] || '').trim();
    if (idNaLinha && idsSet.has(idNaLinha)) {
      linhasParaExcluir.push(i + 2);
    }
  }

  if (linhasParaExcluir.length === 0) return 0;

  comTrava_(function () {
    let i = linhasParaExcluir.length - 1;
    while (i >= 0) {
      let fim = linhasParaExcluir[i];
      let qtd = 1;
      while (i > 0 && linhasParaExcluir[i - 1] === fim - qtd) {
        qtd++;
        i--;
      }
      const inicio = fim - qtd + 1;
      planilha.deleteRows(inicio, qtd);
      i--;
    }
  });

  return linhasParaExcluir.length;
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
