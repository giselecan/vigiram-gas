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

/**
 * Alias opcional de remetente dos e-mails de alerta (ver
 * plano_migracao_conta_pessoal.md, Seção 2, Opção A — "Enviar como"). Sem a
 * Script Property EMAIL_REMETENTE_ALIAS, os e-mails saem normalmente como a
 * conta que fez o deploy (comportamento de sempre). Com ela configurada — e
 * o alias correspondente configurado em Gmail → Contas e importação →
 * "Enviar e-mail como" na conta que roda o script — os e-mails passam a
 * sair com esse remetente (ex.: mantém a aparência institucional mesmo com
 * o VigiRAM rodando na conta pessoal). Não afeta a cota de envio: quem
 * processa o envio continua sendo sempre a conta que executa o script.
 */
function _camposRemetenteEmail_() {
  const alias = PropertiesService.getScriptProperties().getProperty('EMAIL_REMETENTE_ALIAS');
  return alias ? { name: 'VigiRAM', from: alias } : { name: 'VigiRAM' };
}

/**
 * Envia um e-mail de alerta do VigiRAM — ÚNICO ponto de envio usado por
 * Notify.gs/Mirror.gs (nenhum deles chama MailApp.sendEmail() diretamente).
 *
 * Opção B do plano de migração (ver plano_migracao_conta_pessoal.md, Seção
 * 2, e relay-institucional/Relay.gs): se RELAY_EMAIL_URL e
 * RELAY_EMAIL_SECRET estiverem configurados nas Script Properties, tenta
 * primeiro esse relay — um projeto Apps Script minúsculo e separado,
 * publicado sob a conta institucional, que só recebe o pedido assinado por
 * HMAC e dispara o e-mail rodando como institucional de verdade (sem
 * alias, sem senha de app). Se o relay não estiver configurado, ou
 * falhar/não responder, cai para o envio direto por MailApp.sendEmail()
 * (mesma lógica de degradação graciosa já usada em getConfig_() —
 * Config.gs), aplicando o alias cosmético opcional de
 * _camposRemetenteEmail_() se houver.
 *
 * @param {{to:string, subject:string, htmlBody?:string, body?:string}} campos
 */
function _enviarEmail_(campos) {
  const props = PropertiesService.getScriptProperties();
  const relayUrl    = props.getProperty('RELAY_EMAIL_URL');
  const relaySecret = props.getProperty('RELAY_EMAIL_SECRET');

  if (relayUrl && relaySecret) {
    try {
      const corpo = JSON.stringify(campos);
      const ts    = Math.floor(Date.now() / 1000);
      const sig   = hmacHex_(ts + '\n' + corpo, relaySecret); // Security.gs

      const url = relayUrl + (relayUrl.indexOf('?') === -1 ? '?' : '&') +
        'ts=' + encodeURIComponent(ts) + '&sig=' + encodeURIComponent(sig);

      const resposta = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: corpo,
        muteHttpExceptions: true
      });

      if (resposta.getResponseCode() === 200) return;
      console.warn('_enviarEmail_: relay institucional retornou HTTP ' +
        resposta.getResponseCode() + ' — caindo para envio direto. Corpo: ' +
        resposta.getContentText());
    } catch (e) {
      console.warn('_enviarEmail_: relay institucional indisponível (' + e.message + ') — caindo para envio direto.');
    }
  }

  MailApp.sendEmail(Object.assign({}, campos, _camposRemetenteEmail_()));
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

  // Formato BR: dd/MM/yyyy ou dd/MM/yy [HH:mm[:ss]]
  const br = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (br) {
    let ano = parseInt(br[3], 10);
    if (ano < 100) ano += 2000;
    const d = new Date(
      ano, parseInt(br[2], 10) - 1, parseInt(br[1], 10),
      parseInt(br[4] || '0', 10), parseInt(br[5] || '0', 10), parseInt(br[6] || '0', 10)
    );
    return isNaN(d.getTime()) ? null : d;
  }

  // Formato ISO: yyyy-MM-dd [HH:mm[:ss]]
  const iso = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
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
 * Sanitiza um texto para uso como parte do ID determinístico de caso (alfanumérico sem acentos).
 * Ex: "UTI ADULTO III" -> "UTIADULTOIII"
 * @param {string} texto
 * @returns {string}
 */
function _chaveIdSanitizada_(texto) {
  if (!texto) return 'NA';
  const limpo = _removerAcentos_(String(texto)).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return limpo || 'NA';
}

/**
 * Padroniza o nome de um setor segundo o padrão canônico do hospital:
 * - Remove acentos (ex.: "CLÍNICA MÉDICA" -> "CLINICA MEDICA", "OBSTETRÍCIA" -> "OBSTETRICIA")
 * - Converte para MAIÚSCULAS
 * - Corrige artefatos/typos comuns de digitação/OCR (ex.: "CLNICA"/"CLINCA" -> "CLINICA", "MDICA"/"MEDCA" -> "MEDICA")
 * - Remove sufixos de leito, box, quarto ou apartamento
 * - Remove zeros à esquerda ("POSTO 01" -> "POSTO 1")
 * - Colapsa separadores e espaços múltiplos em espaço simples
 * @param {string} nome
 * @returns {string}
 */
function _padronizarNomeSetor_(nome) {
  if (!nome) return '';
  let s = String(nome).trim();
  if (!s) return '';

  // 1. Remove acentos e converte para maiúsculo
  s = _removerAcentos_(s);

  // 2. Corrige typos/artefatos de digitação e remoção de acentos sem I
  s = s.replace(/\bCLNICA\b/g, 'CLINICA')
       .replace(/\bCLINCA\b/g, 'CLINICA')
       .replace(/\bMDICA\b/g, 'MEDICA')
       .replace(/\bMEDCA\b/g, 'MEDICA');

  // 3. Trata hierarquia por pontos se houver (ex.: "UTI ADULTO III.03" -> "UTI ADULTO III")
  if (s.indexOf('.') !== -1) {
    const partes = s.split('.');
    const primeiro = partes[0].trim();
    const idPrimeiro = _extrairIdentificadorUnidadeSetor_(primeiro);
    const popPrimeiro = _extrairPopulacaoSetor_(primeiro);
    if (idPrimeiro.numeros.length > 0 || idPrimeiro.letra || popPrimeiro) {
      s = primeiro;
    } else {
      s = s.replace(/\.+/g, ' ');
    }
  }

  // 4. Remove sufixos de leito, box, quarto ou apartamento
  s = s.replace(/\s*[-/:]?\s*\b(?:LEITO|LTO|BOX|QUARTO|APTO|L)\b\s*[-.:/]?\s*\d+\b/gi, '')
       .trim().replace(/[\s\-_/:]+$/, '');

  // 5. Padroniza zeros à esquerda em números ("POSTO 01" -> "POSTO 1")
  s = _padronizarZerosSetor_(s);

  // 6. Colapsa separadores e espaços múltiplos
  s = s.replace(/[-_./]+/g, ' ').replace(/\s+/g, ' ').trim();

  return s;
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
  const nomePadrao = _padronizarNomeSetor_(setor);
  const slugSetor = nomePadrao
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
    .replace(/\bUNIDADE\s+DE\s+TERAPIA\s+INTENSIVA\b/g, 'UTI')
    .replace(/\bCENTRO\s+DE\s+TERAPIA\s+INTENSIVA\b/g, 'CTI')
    .replace(/[ºª°]/g, '')
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
 * Converte numerais arábicos (1 a 20) para romanos em tokens de setores (ex: "UTI ADULTO 1" -> "UTI ADULTO I").
 * @param {string} s
 * @returns {string}
 */
function _converterArabicoParaRomanoSetor_(s) {
  if (!s) return '';
  const mapa = {
    '1': 'I', '2': 'II', '3': 'III', '4': 'IV', '5': 'V',
    '6': 'VI', '7': 'VII', '8': 'VIII', '9': 'IX', '10': 'X',
    '11': 'XI', '12': 'XII', '13': 'XIII', '14': 'XIV', '15': 'XV',
    '16': 'XVI', '17': 'XVII', '18': 'XVIII', '19': 'XIX', '20': 'XX'
  };
  return String(s).replace(/\b(\d{1,2})\b/g, function (match, n) {
    return mapa[n] || match;
  });
}

/**
 * Converte numerais romanos (I a XX) para arábicos em tokens de setores (ex: "UTI ADULTO I" -> "UTI ADULTO 1").
 * @param {string} s
 * @returns {string}
 */
function _converterRomanoParaArabicoSetor_(s) {
  if (!s) return '';
  const mapa = {
    'XX': '20', 'XIX': '19', 'XVIII': '18', 'XVII': '17', 'XVI': '16', 'XV': '15',
    'XIV': '14', 'XIII': '13', 'XII': '12', 'XI': '11', 'X': '10',
    'IX': '9', 'VIII': '8', 'VII': '7', 'VI': '6', 'V': '5',
    'IV': '4', 'III': '3', 'II': '2', 'I': '1'
  };
  return String(s).replace(/\b(XX|XIX|XVIII|XVII|XVI|XV|XIV|XIII|XII|XI|X|IX|VIII|VII|VI|V|IV|III|II|I)\b/g, function (match, r) {
    return mapa[r] || match;
  });
}

/**
 * Dicionário de abreviações e termos hospitalares comuns no Brasil.
 * Acrônimos primários como UTI e CTI são preservados como padrão canônico conciso
 * para evitar inflação artificial de similaridade léxica.
 */
const _ABREVIACOES_HOSPITALARES_ = {
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
 * Extrai o identificador de unidade assistencial de um setor (números, algarismos romanos ou letras de ala/bloco).
 * Desconsidera números de leito, box, quarto ou apartamento para não confundi-los com a numeração do setor.
 * @param {string} str
 * @returns {{ numeros: string[], letra: string | null }}
 */
function _extrairIdentificadorUnidadeSetor_(str) {
  if (!str) return { numeros: [], letra: null };
  // 1. Remove menções a leito, box, quarto ou apartamento (ex: "LEITO 12", "BOX 03", "L.05")
  let s = String(str).replace(/\s*[-/:]?\s*\b(?:LEITO|LTO|BOX|QUARTO|APTO|L)\b\s*[-.:/]?\s*\d+\b/gi, ' ');
  s = _padronizarZerosSetor_(_normalizarSetorComparacao_(s));

  // 2. Converte algarismos romanos para arábicos para unificar comparação
  const sArabico = _converterRomanoParaArabicoSetor_(s);

  // 3. Extrai números do setor (ex: ["1"], ["2"], ["4"])
  const numeros = sArabico.match(/\b\d+\b/g) || [];

  // 4. Extrai letras únicas de ala/bloco/posto (ex: "POSTO A" -> "A", "BLOCO B" -> "B", "ALA C" -> "C")
  const matchLetra = sArabico.match(/\b(?:ALA|BLOCO|POSTO|SETOR|ENF|ENFERMARIA|SALA|UTI|CTI)\s+([A-Z])\b/i);
  const candLetra = matchLetra ? matchLetra[1].toUpperCase() : null;
  const letra = (candLetra && !['I', 'V', 'X'].includes(candLetra)) ? candLetra : null;

  return { numeros: numeros, letra: letra };
}

/**
 * Identifica o perfil assistencial/populacional de um setor.
 * Setores de perfis diferentes (Adulto vs Pediátrico vs Neonatal vs Obstétrico)
 * são ESTRITAMENTE INCOMPATÍVEIS e jamais podem ser agrupados ou aproximados por similaridade.
 * @param {string} str
 * @returns {'ADULTO' | 'PEDIATRICO' | 'NEONATAL' | 'OBSTETRICO' | null}
 */
function _extrairPopulacaoSetor_(str) {
  if (!str) return null;
  const s = _normalizarSetorComparacao_(str);
  if (/\b(?:NEO|NEONATAL|NEONATOLOGIA|BERCARIO|RN)\b/.test(s)) return 'NEONATAL';
  if (/\b(?:PED|PEDIATRIA|PEDIATRICA|PEDIATRICO|INFANTIL|CRIANCA)\b/.test(s)) return 'PEDIATRICO';
  if (/\b(?:OBST|OBSTETRICIA|OBSTETRICA|OBSTETRICO|MATERNIDADE|PARTO|PUERPERIO)\b/.test(s)) return 'OBSTETRICO';
  if (/\b(?:AD|ADULTO|ADULTOS|ADULTA)\b/.test(s)) return 'ADULTO';
  return null;
}

/**
 * Calcula a similaridade entre dois nomes de setores considerando acentuação,
 * pontuação, zeros à esquerda, abreviações hospitalares e sobreposição de termos.
 * Garante proteção estrita contra confusão entre setores com numerações distintas (ex: UTI I vs UTI II)
 * e perfis assistenciais incompatíveis (ex: UTI ADULTO vs UTI PEDIATRICA).
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

  // 1. TRAVA ESTRITA DE NUMERAÇÃO E ALA:
  // Se os setores possuem números distintos (ex: "UTI 1" vs "UTI 2", "UTI I" vs "UTI II", "UTI III" vs "UTI IV")
  // ou letras de ala distintas ("POSTO A" vs "POSTO B"), ou se um possui número e o outro não ("UTI" vs "UTI 1"),
  // tratam-se de unidades físicas DIFERENTES e JAMAIS devem ser aproximados por similaridade.
  const id1 = _extrairIdentificadorUnidadeSetor_(z1);
  const id2 = _extrairIdentificadorUnidadeSetor_(z2);

  const temNum1 = id1.numeros.length > 0;
  const temNum2 = id2.numeros.length > 0;

  if (temNum1 || temNum2) {
    const sNum1 = id1.numeros.join(',');
    const sNum2 = id2.numeros.join(',');
    if (sNum1 !== sNum2) {
      return {
        score: 0,
        porcentagem: 0,
        motivo: temNum1 && temNum2
          ? `Numerações distintas de setor (${sNum1} vs ${sNum2})`
          : 'Um setor possui numeração e o outro não',
        compativel: false
      };
    }
  }

  if (id1.letra || id2.letra) {
    if (id1.letra !== id2.letra) {
      return {
        score: 0,
        porcentagem: 0,
        motivo: `Alas/blocos com letras distintas (${id1.letra || 'Nenhuma'} vs ${id2.letra || 'Nenhuma'})`,
        compativel: false
      };
    }
  }

  // 1.1 TRAVA ESTRITA DE PERFIL POPULACIONAL / ESPECIALIDADE ASSISTENCIAL:
  // É ERRO GRAVE misturar pacientes adultos com pediátricos/neonatais/obstétricos.
  // Setores com populações distintas têm incompatibilidade absoluta.
  const pop1 = _extrairPopulacaoSetor_(z1);
  const pop2 = _extrairPopulacaoSetor_(z2);
  if (pop1 && pop2 && pop1 !== pop2) {
    return {
      score: 0,
      porcentagem: 0,
      motivo: `Perfis assistenciais incompatíveis (${pop1} vs ${pop2})`,
      compativel: false
    };
  }

  // Se um setor possui perfil especializado (Pediátrico, Neonatal ou Obstétrico)
  // e o outro não possui (ex.: "UTI" vs "UTI PEDIATRICA"), bloqueio imediato:
  const esp1 = (pop1 === 'PEDIATRICO' || pop1 === 'NEONATAL' || pop1 === 'OBSTETRICO');
  const esp2 = (pop2 === 'PEDIATRICO' || pop2 === 'NEONATAL' || pop2 === 'OBSTETRICO');
  if (esp1 !== esp2) {
    return {
      score: 0,
      porcentagem: 0,
      motivo: 'Um setor possui especialidade (Pediátrico/Neonatal/Obstétrico) e o outro não',
      compativel: false
    };
  }

  // 2. Equivalência por numeração romana vs arábica (ex: "UTI ADULTO 1" <-> "UTI ADULTO I")
  const z1Arabico = _converterRomanoParaArabicoSetor_(z1);
  const z2Arabico = _converterRomanoParaArabicoSetor_(z2);
  if (z1Arabico === z2Arabico) {
    return { score: 0.98, porcentagem: 98, motivo: 'Numeração romana/arábica equivalente', compativel: true };
  }

  // 3. Equivalência por abreviação hospitalar
  const e1 = _expandirAbreviacoesSetor_(z1);
  const e2 = _expandirAbreviacoesSetor_(z2);
  if (e1 === e2) {
    return { score: 0.95, porcentagem: 95, motivo: 'Abreviação hospitalar compatível', compativel: true };
  }

  const e1Arabico = _converterRomanoParaArabicoSetor_(e1);
  const e2Arabico = _converterRomanoParaArabicoSetor_(e2);
  if (e1Arabico === e2Arabico) {
    return { score: 0.95, porcentagem: 95, motivo: 'Abreviação e numeração romana/arábica equivalentes', compativel: true };
  }

  const t1 = z1Arabico.split(' ').filter(Boolean);
  const t2 = z2Arabico.split(' ').filter(Boolean);
  const set1 = {}; t1.forEach(function (x) { set1[x] = true; });
  const set2 = {}; t2.forEach(function (x) { set2[x] = true; });
  let inter = 0;
  t1.forEach(function (x) { if (set2[x]) inter++; });
  const dice = (2 * inter) / (t1.length + t2.length);

  const menor = t1.length <= t2.length ? t1 : t2;
  const maiorSet = t1.length <= t2.length ? set2 : set1;
  const contemTodos = menor.length > 0 && menor.every(function (x) { return !!maiorSet[x]; });

  // Expansão de abreviações nos tokens
  const te1 = e1Arabico.split(' ').filter(Boolean);
  const te2 = e2Arabico.split(' ').filter(Boolean);
  const sete1 = {}; te1.forEach(function (x) { sete1[x] = true; });
  const sete2 = {}; te2.forEach(function (x) { sete2[x] = true; });
  let interExp = 0;
  te1.forEach(function (x) { if (sete2[x]) interExp++; });
  const diceExp = (2 * interExp) / (te1.length + te2.length);
  const menorExp = te1.length <= te2.length ? te1 : te2;
  const maiorSetExp = te1.length <= te2.length ? sete2 : sete1;
  const contemTodosExp = menorExp.length > 0 && menorExp.every(function (x) { return !!maiorSetExp[x]; });

  const maxLen = Math.max(z1Arabico.length, z2Arabico.length);
  const dist = _levenshteinDistancia_(z1Arabico, z2Arabico);
  const levSim = maxLen > 0 ? (1 - dist / maxLen) : 0;

  const maxLenExp = Math.max(e1Arabico.length, e2Arabico.length);
  const distExp = _levenshteinDistancia_(e1Arabico, e2Arabico);
  const levSimExp = maxLenExp > 0 ? (1 - distExp / maxLenExp) : 0;

  let score = Math.max(levSim, levSimExp, dice, diceExp);
  let motivo = 'Similaridade léxica';

  if (contemTodos || contemTodosExp) {
    const maxLenT = Math.max(contemTodos ? t1.length : te1.length, contemTodos ? t2.length : te2.length);
    const interFinal = contemTodos ? inter : interExp;
    const scoreSubset = 0.82 + (0.13 * (interFinal / maxLenT));
    if (scoreSubset > score) {
      score = scoreSubset;
      motivo = 'Contém todos os termos chave';
    }
  }

  if (levSim >= 0.85 || levSimExp >= 0.85) motivo = 'Grafia muito próxima (variação/digitação)';
  else if (dice >= 0.70 || diceExp >= 0.70) motivo = 'Termos quase idênticos';

  score = Math.round(score * 100) / 100;
  const pct = Math.round(score * 100);
  return { score: score, porcentagem: pct, motivo: motivo, compativel: pct >= 55 };
}

/**
 * Encontra a melhor correspondência para um setor dentro de uma lista de candidatos.
 * Garante que somente candidatos compatíveis (sem conflito de numeração) sejam selecionados.
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
    if (!sim || !sim.compativel) continue;
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
    const destino = deParaChaves[chave] || _padronizarNomeSetor_(atual);
    if (destino && destino !== atual) {
      valores[i][0] = destino;
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
 * Atualiza o setor de casos na planilha espelho (DB_Casos_RAM) baseado no ID do caso.
 * @param {Sheet} planilha
 * @param {{ [idCaso: string]: string }} mapaIdParaSetor — mapa idCaso -> novoSetor
 * @returns {number} quantidade de linhas atualizadas
 */
function _atualizarSetorEmPlanilhaPorId_(planilha, mapaIdParaSetor) {
  if (!planilha || !mapaIdParaSetor || Object.keys(mapaIdParaSetor).length === 0) return 0;
  const ultimaLinha = planilha.getLastRow();
  if (ultimaLinha < 2) return 0;

  const rangeIds = planilha.getRange(2, SCHEMA.COL.ID, ultimaLinha - 1, 1).getValues();
  const rangeSetores = planilha.getRange(2, SCHEMA.COL.SETOR, ultimaLinha - 1, 1);
  const valoresSetor = rangeSetores.getValues();
  let atualizados = 0;

  for (let i = 0; i < rangeIds.length; i++) {
    const id = String(rangeIds[i][0] || '').trim();
    if (id && mapaIdParaSetor[id] && valoresSetor[i][0] !== mapaIdParaSetor[id]) {
      valoresSetor[i][0] = mapaIdParaSetor[id];
      atualizados++;
    }
  }

  if (atualizados > 0) {
    comTrava_(function () {
      rangeSetores.setValues(valoresSetor);
    });
  }
  return atualizados;
}

/**
 * Remove acentuação e converte para maiúsculo.
 * @param {string} str
 * @returns {string}
 */
function _removerAcentos_(str) {
  return String(str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
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
