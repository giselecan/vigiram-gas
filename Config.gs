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
  unidade_intervalo:          ["HORA(S)", "DIA(S)", "SEMANA(S)", "MÊS(ES)", "ANO(S)"]
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
