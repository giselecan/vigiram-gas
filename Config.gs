/**
 * @fileoverview Config.gs — Serviço de Configuração Externalizada (Fase 2 → Fase 4 Firestore).
 *
 * MIGRAÇÃO (Fase 4): fonte de dados trocada de Google Sheets para Firestore.
 * A ASSINATURA PÚBLICA NÃO MUDA: getConfig() continua retornando exatamente
 * o mesmo formato de objeto { geral, setores, listas, naranjo, status }.
 * Nenhuma alteração necessária em js_core.html / aplicarConfig() / frontend.
 *
 * DEGRADAÇÃO GRACIOSA MANTIDA: se uma coleção Firestore estiver vazia ou
 * inacessível, cai nos valores PADRÃO (DEFAULT_GERAL/DEFAULT_LISTAS/
 * DEFAULT_NARANJO) — o sistema nunca quebra por falta de configuração,
 * igual ao comportamento original com abas ausentes no Sheets.
 *
 * ROLLBACK: se algo der errado, basta restaurar a versão anterior deste
 * arquivo (baseada em SpreadsheetApp) — DB_Config_Geral, DB_Setores,
 * DB_Listas e DB_Naranjo continuam intactas no Sheets, não foram alteradas
 * pela migração, apenas copiadas.
 */

const CONFIG_CACHE_KEY  = "VIGI_CONFIG_V1";
const CONFIG_CACHE_SEG  = 600; // 10 minutos — mesmo valor de antes

// ── Valores padrão (espelham os dropdowns atuais do index.html) ──────────────
// Mantidos idênticos à versão Sheets — são o fallback de última instância.
const DEFAULT_GERAL = {
  EMAIL_COORDENACAO: "farmacia.clinica@hospital.com",
  SLA_PADRAO_HORAS:  "48",
  ALERTAS_ATIVOS:    "SIM",
  TITULO_SISTEMA:    "VigiRAM",
  // URL fixa da implantação (deployment) de produção, usada nos links dos
  // e-mails em vez de ScriptApp.getService().getUrl() — esse método é
  // instável quando chamado fora de uma requisição web (ex.: no trigger
  // diário), podendo resolver para uma implantação antiga. Vazio por
  // padrão: cai no fallback dinâmico até o admin preencher no painel.
  URL_SISTEMA:       ""
};

const DEFAULT_LISTAS = {
  gravidade:        ["LEVE", "MODERADA", "GRAVE", "FATAL"],
  desfecho:         ["PROLONGADO INTERNAÇÃO", "PACIENTE RECUPERADO", "TRANSFERÊNCIA INTERNA",
                     "ALTA", "TRANSFERÊNCIA EXTERNA", "ÓBITO"],
  conclusao:        ["CONFIRMADO", "NÃO RELACIONADO AO MEDICAMENTO", "PROVÁVEL"],
  motivo_descarte:  ["USO PROFILÁTICO / ROTINA", "ERRO DE PRESCRIÇÃO", "EVOLUÇÃO DA DOENÇA", "OUTROS"],
  readministrado:   ["NÃO", "SIM", "SIM. SINTOMAS REAPARECERAM", "SIM. SINTOMAS NÃO REAPARECERAM"],
  evolucao:         ["NENHUMA CONDUTA REALIZADA", "SINTOMAS DESAPARECERAM",
                     "MELHORA DOS SINTOMAS", "SINTOMAS NÃO DESAPARECERAM"],
  // ── Fase 2 (roadmap) — campos novos da tela de investigação ──────────────
  // Rótulos aqui precisam bater (após toUpperCase) com as chaves dos mapas
  // SCHEMA.E2B.*_MAP correspondentes — ver Schema.gs.
  acao_adotada:               ["RETIRADA DO MEDICAMENTO", "REDUÇÃO DA DOSE", "AUMENTO DA DOSE",
                               "SEM ALTERAÇÃO DA DOSE", "DESCONHECIDO", "NÃO APLICÁVEL"],
  relacao_medicamento_evento: ["SUSPEITO", "CONCOMITANTE", "INTERAGENTE", "MEDICAMENTO NÃO ADMINISTRADO"],
  problemas_adicionais:       ["FALSIFICAÇÃO", "SUPERDOSAGEM", "MEDICAMENTO USADO PELO PAI",
                               "USO APÓS VALIDADE", "LOTE TESTADO — DENTRO DAS ESPECIFICAÇÕES",
                               "LOTE TESTADO — FORA DAS ESPECIFICAÇÕES", "ERRO DE MEDICAÇÃO",
                               "USO INDEVIDO", "ABUSO", "EXPOSIÇÃO OCUPACIONAL", "USO OFF-LABEL"],
  unidade_intervalo:          ["HORA(S)", "DIA(S)", "SEMANA(S)", "MÊS(ES)", "ANO(S)"],
  // Melhoria UCUM/VigiFlow — dropdown fechado p/ G.k.4.r.1b (Unidade da
  // Dose). Rótulos aqui precisam bater (após toUpperCase) com as chaves de
  // SCHEMA.E2B.DOSE_UNIDADE_MAP — ver Schema.gs.
  //
  // INCIDENTE (motivo desta lista ter sido ampliada): a lista tinha sido
  // reduzida a ["GOTAS"] pelo painel admin. Como lerListasFirestore_ SUBSTITUI
  // a lista inteira (não mescla), todas as demais unidades sumiram do
  // dropdown; e como "GOTAS" não existia no DOSE_UNIDADE_MAP, E2b.gs caía no
  // fallback "mantém o que foi digitado" e emitia unit="GOTAS" — token UCUM
  // inválido, que faz o VigiFlow descartar o bloco de posologia inteiro.
  // Toda opção adicionada aqui PRECISA ter entrada correspondente no
  // DOSE_UNIDADE_MAP (validado por _validarUnidadesDose_ em Config write.gs).
  dose_unidade:               ["mg", "g", "mcg", "ng", "kg", "mL", "L",
                               "UI", "mEq", "mmol", "mol", "%", "GOTAS",
                               "mg/kg", "mcg/kg", "mg/m2", "UI/kg"],
  // G.k.4.r.9.1 — Forma Farmacêutica (apresentação). Era texto livre: cada
  // farmacêutico escrevia de um jeito ("CP", "comp.", "Comprimido") e o E2B
  // saía com originalText inconsistente. Vocabulário fechado alinhado aos
  // termos padrão EDQM/ANVISA usados no VigiMed. Continua exportado como
  // texto livre no XML (o campo é ST no E2B(R3)), mas agora padronizado.
  forma_farmaceutica:         ["COMPRIMIDO", "COMPRIMIDO REVESTIDO",
                               "COMPRIMIDO DE LIBERAÇÃO PROLONGADA",
                               "CÁPSULA", "CÁPSULA DE LIBERAÇÃO PROLONGADA",
                               "DRÁGEA", "PÓ PARA SOLUÇÃO INJETÁVEL",
                               "SOLUÇÃO INJETÁVEL", "SUSPENSÃO INJETÁVEL",
                               "EMULSÃO INJETÁVEL", "SOLUÇÃO PARA INFUSÃO",
                               "SOLUÇÃO ORAL", "SOLUÇÃO ORAL EM GOTAS",
                               "SUSPENSÃO ORAL", "XAROPE", "ELIXIR",
                               "PÓ PARA SUSPENSÃO ORAL", "GRANULADO",
                               "SOLUÇÃO NASAL", "SOLUÇÃO OFTÁLMICA",
                               "SOLUÇÃO OTOLÓGICA", "SOLUÇÃO INALATÓRIA",
                               "AEROSSOL", "PÓ INALATÓRIO",
                               "CREME", "POMADA", "GEL", "LOÇÃO",
                               "ADESIVO TRANSDÉRMICO", "SUPOSITÓRIO",
                               "ÓVULO", "SOLUÇÃO RETAL", "OUTRA"]
};

const DEFAULT_NARANJO = [
  { pergunta: "Relatos prévios sobre esta reação?",                    sim: 1, nao:  0, ns: 0 },
  { pergunta: "Apareceu após o uso do medicamento?",                   sim: 2, nao: -1, ns: 0 },
  { pergunta: "Melhorou ao suspender ou usar antagonista?",            sim: 1, nao:  0, ns: 0 },
  { pergunta: "Reapareceu ao readministrar?",                          sim: 2, nao: -1, ns: 0 },
  { pergunta: "Existem causas alternativas?",                          sim:-1, nao:  2, ns: 0 },
  { pergunta: "Reapareceu com placebo?",                               sim:-1, nao:  1, ns: 0 },
  { pergunta: "Detectado no sangue em concentração tóxica?",           sim: 1, nao:  0, ns: 0 },
  { pergunta: "Mais grave ao aumentar a dose?",                        sim: 1, nao:  0, ns: 0 },
  { pergunta: "Reação semelhante no passado?",                         sim: 1, nao:  0, ns: 0 },
  { pergunta: "Confirmado por evidência objetiva?",                    sim: 1, nao:  0, ns: 0 }
];

// ─────────────────────────────────────────────────────────────────────────────
// PONTO ÚNICO DE LEITURA — com cache de 10 minutos (idêntico ao original)
// ─────────────────────────────────────────────────────────────────────────────
// [SEGURANÇA/LGPD] getConfig() devolve `setores` COM nome/e-mail do farmacêutico
// de cada setor + EMAIL_COORDENACAO (PII). Por isso a entrada pública exige token
// válido (getConfig(token) → comAutenticacao_). O corpo virou getConfig_(), com
// sufixo "_" para NÃO ficar exposto a google.script.run anônimo — o form público
// usa getSetoresPublico() (só nomes), e o backend chama getConfig_() diretamente.
function getConfig(token) {
  return comAutenticacao_(token, function () { return getConfig_(); });
}

function getConfig_() {
  const cache = CacheService.getScriptCache();
  const hit   = cache.get(CONFIG_CACHE_KEY);
  if (hit) {
    try { return JSON.parse(hit); } catch (e) { /* cache corrompido: relê */ }
  }

  const config = {
    geral:   lerConfigGeralFirestore_(),
    setores: lerSetoresFirestore_(),
    listas:  lerListasFirestore_(),
    naranjo: lerNaranjoFirestore_(),
    status:  SCHEMA.STATUS
  };

  try { cache.put(CONFIG_CACHE_KEY, JSON.stringify(config), CONFIG_CACHE_SEG); } catch (e) {}
  return config;
}

/** Limpa o cache (use após editar dados para refletir imediatamente). */
function invalidarConfig() {
  const cache = CacheService.getScriptCache();
  cache.remove(CONFIG_CACHE_KEY);
  cache.remove(CONFIG_SETORES_PUB_KEY); // cache público do form (getSetoresPublico)
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// [M8 — LGPD] LEITURA PÚBLICA MÍNIMA — form.html (anônimo)
// ─────────────────────────────────────────────────────────────────────────────
// form.html chamava getConfig() completo: expunha a QUALQUER anônimo os
// e-mails e nomes dos farmacêuticos por setor, EMAIL_COORDENACAO e o Naranjo.
// O form só precisa dos NOMES dos setores. Este endpoint devolve apenas isso.
// Cache próprio (mesmo TTL de 10 min) — payload minúsculo, zero PII.

const CONFIG_SETORES_PUB_KEY = 'VIGI_SETORES_PUB_V1';

/**
 * Lista pública de setores ativos — SOMENTE nomes, para o dropdown do
 * formulário anônimo de notificação (form.html).
 * @returns {{ setores: string[] }}
 */
function getSetoresPublico() {
  const cache = CacheService.getScriptCache();
  const hit   = cache.get(CONFIG_SETORES_PUB_KEY);
  if (hit) {
    try { return JSON.parse(hit); } catch (e) { /* cache corrompido: relê */ }
  }

  const nomes = lerSetoresFirestore_()
    .map(function (s) { return s.setor; })
    .filter(Boolean)
    .sort();

  const resultado = { setores: nomes };
  try { cache.put(CONFIG_SETORES_PUB_KEY, JSON.stringify(resultado), CONFIG_CACHE_SEG); } catch (e) {}
  return resultado;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEITORES INDIVIDUAIS — agora via Firestore (fsListarTodos_/fsGetDoc_)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lê config_geral (coleção com 1 documento por chave) e funde com os
 * padrões — equivalente a DEFAULT_GERAL + sobrescrita por linha do Sheets.
 */
function lerConfigGeralFirestore_() {
  const obj = Object.assign({}, DEFAULT_GERAL);
  try {
    const docs = fsListarTodos_(SCHEMA.FS.GERAL);
    docs.forEach(function (doc) {
      const chave = String(doc.chave || doc._id || '').trim();
      const valor = String(doc.valor || '').trim();
      if (chave) obj[chave] = valor;
    });
  } catch (e) {
    console.error('lerConfigGeralFirestore_: falha ao ler Firestore, usando DEFAULT_GERAL — ' + e.message);
  }
  return obj;
}

/**
 * Lê setores (Fase 4: 1 documento por SETOR+e-mail, já que setores como
 * "TODOS" podem ter múltiplos farmacêuticos — ver migrarSetoresParaFirestore).
 * Retorna o MESMO formato de array que o frontend já espera:
 *   [{ setor, email, farmaceutico }, ...]
 */
function lerSetoresFirestore_() {
  try {
    const docs = fsListarTodos_(SCHEMA.FS.SETORES);
    const lista = [];
    docs.forEach(function (doc) {
      const setor = String(doc.setor || '').trim();
      if (!setor) return;
      // CORREÇÃO (auditoria_qa_datas_tipagem_2026-07-13.md #7): doc.ativo
      // pode ser boolean (novo padrão) ou string legada — _ativoComoBooleano_
      // aceita os dois.
      if (!_ativoComoBooleano_(doc.ativo)) return;

      lista.push({
        setor: setor,
        email: String(doc.emailResponsavel || '').trim(),
        farmaceutico: String(doc.farmaceuticoResponsavel || '').trim()
      });
    });
    return lista;
  } catch (e) {
    console.error('lerSetoresFirestore_: falha ao ler Firestore — ' + e.message);
    return [];
  }
}

/**
 * Setores DESATIVADOS — usado por handleInsertDB (Ingest.gs) para descartar
 * os gatilhos que o robô varreu em setores que a farmácia não monitora mais
 * (ex.: ala desativada, setor terceirizado, unidade em reforma).
 *
 * Um setor pode ter VÁRIOS documentos (1 por setor+farmacêutico — ver
 * _idDocSetor_). Só conta como desativado quando NENHUM dos seus documentos
 * está ativo: se ao menos um responsável segue ativo, o setor continua sendo
 * varrido. Desativar por engano a varredura inteira de um setor é pior que
 * gerar um alerta a mais.
 *
 * Pelo mesmo motivo, falha de leitura do Firestore devolve mapa VAZIO (nada
 * bloqueado) em vez de propagar o erro — indisponibilidade da config nunca
 * pode virar "hospital sem busca ativa de RAM", que é uma falha silenciosa
 * com risco assistencial.
 *
 * Chave = nome normalizado por _normalizarSetorComparacao_ (sem acento,
 * maiúsculo, espaços colapsados): o robô manda o setor já passado pelo
 * Normalizar-Clinica do PowerShell, que remove acento — comparar direto
 * deixaria "OBSTETRÍCIA" (Firestore) nunca casar com "OBSTETRICIA" (ETL).
 *
 * @returns {{ [chaveNormalizada: string]: string }} chave → nome original
 */
function _setoresInativosMapa_() {
  const estado = {};
  try {
    const docs = fsListarTodos_(SCHEMA.FS.SETORES);
    docs.forEach(function (doc) {
      const setor = String(doc.setor || '').trim();
      if (!setor) return;
      const chave = _normalizarSetorComparacao_(setor);
      if (!estado[chave]) estado[chave] = { algumAtivo: false, nome: setor };
      if (_ativoComoBooleano_(doc.ativo)) estado[chave].algumAtivo = true;

      // Também mapeia sinônimos registrados para o mesmo estado de ativo/inativo
      if (Array.isArray(doc.sinonimos)) {
        doc.sinonimos.forEach(function (sin) {
          const s = String(sin || '').trim();
          if (!s) return;
          const chaveSin = _normalizarSetorComparacao_(s);
          if (!estado[chaveSin]) estado[chaveSin] = { algumAtivo: false, nome: setor };
          if (_ativoComoBooleano_(doc.ativo)) estado[chaveSin].algumAtivo = true;
        });
      }
    });
  } catch (e) {
    console.error('_setoresInativosMapa_: falha ao ler Firestore, nenhum setor será bloqueado — ' + e.message);
    return {};
  }

  const inativos = {};
  Object.keys(estado).forEach(function (chave) {
    if (!estado[chave].algumAtivo) inativos[chave] = estado[chave].nome;
  });
  return inativos;
}

/**
 * Monta o mapa [chaveNormalizada] -> nomeCanonico, cobrindo os nomes oficiais
 * e todos os sinônimos registrados em cada documento de SCHEMA.FS.SETORES.
 * @returns {{ [chave: string]: string }}
 */
function _mapaSinonimosSetores_() {
  const mapa = {};
  try {
    const docs = fsListarTodos_(SCHEMA.FS.SETORES);
    docs.forEach(function (doc) {
      const setor = String(doc.setor || '').trim();
      if (!setor) return;
      const chaveOficial = _normalizarSetorComparacao_(setor);
      mapa[chaveOficial] = setor;

      if (Array.isArray(doc.sinonimos)) {
        doc.sinonimos.forEach(function (sin) {
          const s = String(sin || '').trim();
          if (s) mapa[_normalizarSetorComparacao_(s)] = setor;
        });
      }
    });
  } catch (e) {
    console.error('_mapaSinonimosSetores_: falha ao ler Firestore — ' + e.message);
  }
  return mapa;
}

/**
 * Resolve o nome canônico oficial de um setor a partir de qualquer variação ou sinônimo cadastrado.
 * Utiliza busca hierárquica inteligente:
 * 1. Consulta direta por chave normalizada ou sinônimo explícito
 * 2. Padronização de zeros (ex.: "POSTO 01" -> "POSTO 1")
 * 3. Expansão de abreviações hospitalares (ex.: "UTI AD" -> "UTI ADULTO")
 * 4. Correspondência por similaridade (score >= 80%) contra setores cadastrados
 * 5. Fallback limpo padronizado
 * @param {string} setorBruto
 * @param {{ [chave: string]: string }=} mapaPreCarregado
 * @returns {string}
 */
function _resolverSetorCanonico_(setorBruto, mapaPreCarregado) {
  let limpo = String(setorBruto || '').trim();
  if (!limpo) return '';

  // 0. Tratamento de hierarquia hospitalar por pontos (ex.: "UTI ADULTO III.UTI ADULTO III .03" ou "UTI.3")
  if (limpo.indexOf('.') !== -1) {
    const partes = limpo.split('.');
    const primeiro = partes[0].trim();
    const idPrimeiro = _extrairIdentificadorUnidadeSetor_(primeiro);
    const popPrimeiro = _extrairPopulacaoSetor_(primeiro);

    // Se o prefixo antes do ponto já traz a unidade completa (ex: "UTI ADULTO III" ou "UTI PEDIATRICA"), isola-o
    if (idPrimeiro.numeros.length > 0 || idPrimeiro.letra || popPrimeiro) {
      limpo = primeiro;
    } else {
      // Se era algo como "UTI.3" ou "UTI.ADULTO.III", substitui pontos por espaços para não perder os termos
      limpo = limpo.replace(/\.+/g, ' ');
    }
  }

  // Remove sufixos de leito, box, quarto ou apartamento (ex: "- LEITO 04", "/ BOX 12", "LTO 01")
  limpo = limpo.replace(/\s*[-/:]?\s*\b(?:LEITO|LTO|BOX|QUARTO|APTO|L)\b\s*[-.:/]?\s*\d+\b/gi, '').trim().replace(/[\s\-_/:]+$/, '');

  const mapa = mapaPreCarregado || _mapaSinonimosSetores_();
  const chave = _normalizarSetorComparacao_(limpo);

  // 1. Consulta direta por chave normalizada ou sinônimo cadastrado
  if (mapa[chave]) return mapa[chave];

  // 2. Padronização de zeros (ex: "POSTO 01" -> "POSTO 1")
  const chaveSemZeros = _normalizarSetorComparacao_(_padronizarZerosSetor_(limpo));
  if (mapa[chaveSemZeros]) {
    mapa[chave] = mapa[chaveSemZeros];
    return mapa[chaveSemZeros];
  }

  // 2.1 Conversão de numerais romanos / arábicos (ex: "UTI ADULTO 1" <-> "UTI ADULTO I")
  const chaveRomana = _normalizarSetorComparacao_(_converterArabicoParaRomanoSetor_(chaveSemZeros));
  if (mapa[chaveRomana]) {
    mapa[chave] = mapa[chaveRomana];
    return mapa[chaveRomana];
  }
  const chaveArabica = _normalizarSetorComparacao_(_converterRomanoParaArabicoSetor_(chaveSemZeros));
  if (mapa[chaveArabica]) {
    mapa[chave] = mapa[chaveArabica];
    return mapa[chaveArabica];
  }

  // 3. Expansão de abreviações hospitalares (ex: "UTI AD" -> "UTI ADULTO")
  const chaveExpandida = _normalizarSetorComparacao_(_expandirAbreviacoesSetor_(chaveSemZeros));
  if (mapa[chaveExpandida]) {
    mapa[chave] = mapa[chaveExpandida];
    return mapa[chaveExpandida];
  }
  const chaveExpandidaRomana = _normalizarSetorComparacao_(_converterArabicoParaRomanoSetor_(chaveExpandida));
  if (mapa[chaveExpandidaRomana]) {
    mapa[chave] = mapa[chaveExpandidaRomana];
    return mapa[chaveExpandidaRomana];
  }
  const chaveExpandidaArabica = _normalizarSetorComparacao_(_converterRomanoParaArabicoSetor_(chaveExpandida));
  if (mapa[chaveExpandidaArabica]) {
    mapa[chave] = mapa[chaveExpandidaArabica];
    return mapa[chaveExpandidaArabica];
  }

  // 4. Busca inteligente por similaridade contra setores oficiais cadastrados
  // Garante que o setor retornado seja estritamente um setor cadastrado oficial
  const candidatos = Array.from(new Set(Object.values(mapa)));
  if (candidatos.length > 0) {
    const melhor = _encontrarMelhorCorrespondenciaSetor_(limpo, candidatos);
    if (melhor && melhor.compativel && melhor.score >= 0.80) {
      mapa[chave] = melhor.setor;
      mapa[chaveSemZeros] = melhor.setor;
      return melhor.setor;
    }
  }

  // 5. Fallback limpo: maiúsculo com zeros padronizados e espaços colapsados
  return _padronizarZerosSetor_(limpo).toUpperCase().replace(/[-_./]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Lê listas (Fase 4: 1 documento por campo, já com array de opções
 * ordenado — ver migrarListasParaFirestore). Funde com DEFAULT_LISTAS.
 */
function lerListasFirestore_() {
  const listas = JSON.parse(JSON.stringify(DEFAULT_LISTAS)); // cópia profunda dos padrões
  try {
    const docs = fsListarTodos_(SCHEMA.FS.LISTAS);
    docs.forEach(function (doc) {
      const campo = String(doc.campo || doc._id || '').trim();
      if (!campo || !Array.isArray(doc.opcoes)) return;
      listas[campo] = doc.opcoes;
    });
  } catch (e) {
    console.error('lerListasFirestore_: falha ao ler Firestore, usando DEFAULT_LISTAS — ' + e.message);
  }
  return listas;
}

/**
 * Lê naranjo (Fase 4: documento único 'algoritmo_padrao' com array de
 * 10 perguntas — ver migrarNaranjoParaFirestore). Mesma validação de
 * segurança do original: precisa ter exatamente 10 itens.
 */
function lerNaranjoFirestore_() {
  try {
    const doc = fsGetDoc_(SCHEMA.FS.NARANJO, 'algoritmo_padrao');
    if (doc && Array.isArray(doc.perguntas) && doc.perguntas.length === 10) {
      return doc.perguntas;
    }
  } catch (e) {
    console.error('lerNaranjoFirestore_: falha ao ler Firestore, usando DEFAULT_NARANJO — ' + e.message);
  }
  return DEFAULT_NARANJO;
}
