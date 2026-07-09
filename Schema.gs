/**
 * @fileoverview Schema.gs — FONTE ÚNICA DE VERDADE do VigiRAM.
 *
 * Toda posição de coluna, nome de status e nome de aba vive AQUI.
 * Nenhum outro arquivo deve conter número de coluna "mágico" ou status literal.
 *
 * Para inserir uma coluna nova no futuro: ajuste o número aqui e pronto.
 *
 * ATUALIZAÇÃO (Fase 3 / DB_Setores):
 *   Adicionado COL_SETORES — mapa das colunas da aba DB_Setores.
 *
 * ATUALIZAÇÃO (Fase 6 / Separação Assistência × Investigação + PII estruturada):
 *   Colunas reordenadas para refletir a nova estrutura da tabela de exportação/relatório.
 *   As colunas de PII do notificador e dados de assistência foram reposicionadas.
 *
 *   MOTIVO #7: registrarInvestigacao grava em RELATO e EVOLUCAO.
 *   Antes, salvarDemandaEspontanea também usava 13/16, então abrir a
 *   investigação de um caso DE sobrescrevia o relato do notificador. Agora o
 *   relato da assistência tem sua própria coluna (read-only no modal) e a investigação
 *   é livre para preencher o relato do evento sem perda.
 *
 *   MOTIVO #8: PII do notificador (nome/categoria/e-mail) deixava de ser
 *   estruturada — ia concatenada em texto livre na coluna OBSERVACOES,
 *   inviabilizando eliminação/retenção seletiva exigida pela LGPD. Agora cada
 *   atributo tem coluna própria, permitindo limpeza cirúrgica por campo.
 *
 *   SCHEMA.LARGURA reflete o total de colunas (usado para gravação em lote).
 *
 * ATUALIZAÇÃO (Fase 8 / Exportação E2B(R3) para VigiMed):
 *   Adicionadas colunas 35-42 (REACAO_TERMO até SAFETYREPORTID_E2B) — dados
 *   que o E2B(R3) exige e que não existiam como campo discreto até então
 *   (reação era só texto livre dentro de RELATO_NOTIFICADOR/RELATO).
 *
 *   Adicionado bloco SCHEMA.E2B — mapas de tradução entre os valores livres
 *   dos dropdowns existentes (DEFAULT_LISTAS em Config.gs) e os códigos
 *   fechados exigidos pelo padrão ICH E2B(R3)/HL7v3. Esses mapas NÃO leem
 *   config_geral/listas em runtime — se o admin adicionar uma opção nova em
 *   Gravidade/Desfecho pelo painel, o mapa aqui PRECISA ser atualizado junto,
 *   ou a geração do XML deve falhar explicitamente (ver E2B.gs).
 *
 *   MEDDRA_CODE foi propositalmente OMITIDO — sem licença MedDRA ativa, o
 *   campo fica de fora até decisão de ativar a licença.
 */
const SCHEMA = {

  // ── Nomes das abas da planilha ────────────────────────────────────────────
  ABAS: {
    CASOS:     "DB_Casos_RAM",
    ANTIDOTOS: "DB_Antidotos",        // gatilhos (Trigger Tool)
    EMAILS:    "DB_Config_Emails",    // legado (consolidado em DB_Setores)
    GERAL:     "DB_Config_Geral",     // parâmetros globais (chave/valor)
    SETORES:   "DB_Setores",          // lista canônica de setores + responsáveis
    LISTAS:    "DB_Listas",           // opções de todos os dropdowns
    NARANJO:   "DB_Naranjo",          // perguntas/pesos do Naranjo (opcional)
    LOG:       "DB_Log",              // trilha de auditoria (opcional)
    USUARIOS:  "DB_Usuarios"          // usuários do painel (Auth.gs)
  },

  // ── Nomes de coleção no Firestore (Fase 2 — migração gradual) ────────────
  // Espelha SCHEMA.ABAS, mas em formato compatível com Firestore (sem maiúsculas
  // obrigatórias, sem acento, snake_case por convenção).
  //
  // ARQUITETURA (Fase 9 — Firestore como Single Source of Truth):
  // Firestore é a ÚNICA fonte lida em runtime para configuração/cadastros
  // dinâmicos (setores, listas, naranjo, usuários, gatilhos). O Sheets
  // (SCHEMA.ABAS) foi rebaixado a repositório "append-only" — recebe
  // gravações via appendRow (log de auditoria + backup histórico de casos
  // investigados), mas NENHUMA função de negócio volta a lê-lo para decidir
  // comportamento. Ver Mirror.gs para o detalhamento do fluxo de backup.
  FS: {
    CASOS:         'casos_ram',
    GERAL:         'config_geral',
    SETORES:       'setores',
    LISTAS:        'listas',
    NARANJO:       'naranjo',
    LOG:           'log_auditoria',
    USUARIOS:      'usuarios',
    GATILHOS:      'gatilhos',          // medicamentos monitorados (Trigger Tool / robô PowerShell)
    EMAILS_LEGADO: 'config_emails_legado'
  },

  // ── Posição das colunas em DB_Casos_RAM (1-based) ─────────────────────────
  // REORDENADO 07/2026 — reflete o cabeçalho FÍSICO da aba (blocos: paciente →
  // medicamento (dose/lote/laboratório/via/início adm.) → assistência →
  // investigação → conclusão → auditoria → E2B → triagem).
  // LOTE_LABORATORIO foi DIVIDIDO em LOTE + LABORATORIO — G.k.4.r.7 exige só o lote.
  COL: {
    ID:                  1,  // ID_CASO
    DATA:                2,  // DATA_EVENTO
    TIPO:                3,  // TIPO
    NOTIF_NOME:          4,  // NOTIF_NOME
    NOTIF_CATEGORIA:     5,  // NOTIF_CATEGORIA
    DATA_NOTIFICACAO:    6,  // DATA_NOTIFICACAO
    PRONTUARIO:          7,  // PRONTUARIO
    INICIAIS:            8,  // INICIAIS_PACIENTE
    NASCIMENTO:          9,  // DATA_NASCIMENTO
    SEXO:               10,  // SEXO — D.5 administrativeGenderCode (era col 43)
    SETOR:              11,  // SETOR
    MEDICAMENTO:        12,  // MEDICAMENTO_SUSPEITO
    DOSE_MEDICAMENTO:   13,  // DOSE_MEDICAMENTO (G.k.4.r.1a)
    DOSE_UNIDADE:       14,  // DOSE_UNIDADE (G.k.4.r.1b)
    LOTE:               15,  // LOTE — G.k.4.r.7 lotNumberText (separado de LABORATORIO)
    LABORATORIO:        16,  // LABORATORIO — fabricante/detentor (uso interno + narrativa E2B)
    VIA_ADMINISTRACAO:  17,  // VIA_ADMINISTRACAO (G.k.4.r.10.1)
    DATA_INICIO_ADM:    18,  // DATA_INICIO_ADMINISTRACAO (G.k.4.r.4) — distinto de DATA_INICIO_REACAO
    RELATO_NOTIFICADOR: 19,  // RELATO_NOTIFICADOR
    CONDUTA_NOTIFICADOR:20,  // CONDUTA_NOTIFICADOR
    STATUS:             21,  // STATUS
    SLA:                22,  // PRAZO_SLA
    MOTIVO_DESCARTE:    23,  // MOTIVO_DESCARTE
    HISTORIA:           24,  // HISTORIA_CLINICA
    RELATO:             25,  // RELATO_EVENTO (Farmacêutico)
    REACAO_TERMO:       26,  // REACAO_TERMO (E.i.1.1a)
    DATA_INICIO_REACAO: 27,  // DATA_INICIO_REACAO (E.i.4)
    EXAMES:             28,  // EXAMES_COMPLEMENTARES
    READMINISTRADO:     29,  // READMINISTRADO
    EVOLUCAO:           30,  // EVOLUCAO_POS_CONDUTAS (Farmacêutico)
    DESFECHO:           31,  // DESFECHO
    CONCLUSAO:          32,  // CONCLUSAO
    NARANJO:            33,  // NARANJO
    GRAVIDADE:          34,  // GRAVIDADE
    FARMACEUTICO:       35,  // FARMACEUTICO
    NUM_VIGIMED:        36,  // NUM_VIGIMED
    DATA_VIGIMED:       37,  // DATA_VIGIMED
    OBSERVACOES:        38,  // OBSERVACOES
    NARANJO_RESP:       39,  // NARANJO_RESPOSTAS
    ATUALIZADO_POR:     40,  // ATUALIZADO_POR
    ATUALIZADO_EM:      41,  // ATUALIZADO_EM
    NOTIF_EMAIL:        42,  // NOTIF_EMAIL
    ID_REACAO_E2B:      43,  // ID_REACAO_E2B — UUID estável, gerado 1x na 1ª exportação
    ID_MEDICAMENTO_E2B: 44,  // ID_MEDICAMENTO_E2B — UUID estável, gerado 1x na 1ª exportação
    SAFETYREPORTID_E2B: 45,  // SAFETYREPORTID_E2B — último C.1.1 (controle reenvio/follow-up)
    DATA_TRIAGEM:       46   // Timestamp carimbado 1x em registrarTriagem() (Cases.gs)
  },
  LARGURA: 46,

  // ── Posição das colunas em DB_Setores (1-based) ───────────────────────────
  //   A: SETOR | B: ATIVO | C: FARMACEUTICO_RESPONSAVEL | D: EMAIL_RESPONSAVEL
  COL_SETORES: {
    SETOR:                   1,
    ATIVO:                   2,
    FARMACEUTICO_RESPONSAVEL:3,
    EMAIL_RESPONSAVEL:       4
  },

  COL_USUARIOS: {
    EMAIL: 1,
    SENHA: 2,
    NOME:  3,
    ATIVO: 4,
    PERFIL:5
  },

  // ── Status do caso (Kanban) ───────────────────────────────────────────────
  STATUS: {
    TRIAGEM:     "PENDENTE TRIAGEM",
    INVESTIGACAO:"EM INVESTIGAÇÃO",
    CONCLUIDO:   "CONCLUÍDO",
    DESCARTADO:  "DESCARTADO"
  },

  // ── Fase 8 / Exportação E2B(R3) — OIDs e mapas de tradução ────────────────
  // Fonte: ICH ICSR Technical Information (Appendix I(G)) + validação real
  // contra ambiente de teste VigiFlow/VigiMed (AckLogs de 01/07/2026).
  E2B: {
    CODESYS: {
      TIPO_RELATO:          '2.16.840.1.113883.3.989.2.1.1.2',
      QUALIFICACAO_NOTIF:   '2.16.840.1.113883.3.989.2.1.1.6',
      SENDER_TYPE:          '2.16.840.1.113883.3.989.2.1.1.7',
      FIRST_SENDER:         '2.16.840.1.113883.3.989.2.1.1.3',
      OBSERVACOES:          '2.16.840.1.113883.3.989.2.1.1.19',
      CATEGORIA_GK:         '2.16.840.1.113883.3.989.2.1.1.20',
      ACAO_MEDICAMENTO:     '2.16.840.1.113883.3.989.2.1.1.15',
      CARACTERIZACAO_DROGA: '2.16.840.1.113883.3.989.2.1.1.13',
      DESFECHO:             '2.16.840.1.113883.3.989.2.1.1.11',
      REEXPOSICAO:          '2.16.840.1.113883.3.989.2.1.1.16',  // CL16 — G.k.9.i.4
      TERMO_DESTACADO:      '2.16.840.1.113883.3.989.2.1.1.10',  // CL10 — E.i.3.1
      // BUGFIX (09/07/2026, IG_Complete_Package_v1_11_1): estas duas chaves
      // já eram referenciadas em E2B.gs (asIdentifiedEntity do prontuário e
      // author dos comentários H.2/H.4/H.5) mas nunca existiram aqui — saíam
      // como codeSystem="undefined" no XML. Confirmadas contra as code lists
      // oficiais CL4 (ich-medical-record-number-source-type) e CL21 (ich-role-code).
      FONTE_PRONTUARIO:     '2.16.840.1.113883.3.989.2.1.1.4',   // CL4 — D.1.1.3 (código "3" = Hospital Record)
      AUTOR_COMENTARIO:     '2.16.840.1.113883.3.989.2.1.1.21',  // CL21 — H.2/H.4/H.5 (1=sender, 2=reporter, 3=sourceReporter)
      PROBLEMAS_ADICIONAIS: '2.16.840.1.113883.3.989.2.1.1.17',  // CL17 — G.k.10.r (Fase 2 / F2-12)
      PAIS:                 '1.0.3166.1.2.2',
      SEXO:                 '1.0.5218'   // D.5 administrativeGenderCode — [1] Masculino [2] Feminino
    },

    // ── Fase 2 (roadmap) — campos novos da tela de investigação ──────────────

    // F2-01 · G.k.8 Ação Adotada com o Medicamento (CL15). Rótulos idênticos
    // aos do roadmap/DEFAULT_LISTAS.acao_adotada (Config.gs).
    ACAO_MEDICAMENTO_MAP: {
      'RETIRADA DO MEDICAMENTO':    '1',
      'REDUÇÃO DA DOSE':            '2',
      'AUMENTO DA DOSE':            '3',
      'SEM ALTERAÇÃO DA DOSE':      '4',
      'DESCONHECIDO':               '0',
      'NÃO APLICÁVEL':              '9'
    },

    // F2-11 · G.k.1 Caracterização do Papel do Medicamento (CL13). Hoje
    // hardcoded '1' (Suspeito) em _montarXmlE2B_ — dropdown novo o torna
    // dinâmico. Fallback '1' se vazio/sem match (mantém o comportamento
    // atual para casos já em andamento sem o campo preenchido).
    CARACTERIZACAO_DROGA_MAP: {
      'SUSPEITO':                    '1',
      'CONCOMITANTE':                '2',
      'INTERAGENTE':                 '3',
      'MEDICAMENTO NÃO ADMINISTRADO':'4'
    },

    // F2-12 · G.k.10.r Outras Informações sobre o Medicamento — CODIFICADO
    // (CL17, multi-select — 0..N). Confirmado contra a Reference Instance
    // v3.1 (linhas 1967-1980): outboundRelationship2/observation code="9"
    // ("codedDrugInformation") + value CE com código CL17. G.k.11 é a
    // variante em TEXTO LIVRE (code="2", value ST) — não usada aqui porque
    // o multi-select já é um vocabulário fechado. Tradução PT dos rótulos
    // oficiais do CL17.
    PROBLEMAS_ADICIONAIS_MAP: {
      'FALSIFICAÇÃO':                                   '1',
      'SUPERDOSAGEM':                                    '2',
      'MEDICAMENTO USADO PELO PAI':                      '3',
      'USO APÓS VALIDADE':                               '4',
      'LOTE TESTADO — DENTRO DAS ESPECIFICAÇÕES':        '5',
      'LOTE TESTADO — FORA DAS ESPECIFICAÇÕES':          '6',
      'ERRO DE MEDICAÇÃO':                               '7',
      'USO INDEVIDO':                                    '8',
      'ABUSO':                                            '9',
      'EXPOSIÇÃO OCUPACIONAL':                           '10',
      'USO OFF-LABEL':                                   '11'
    },

    // F2-08 · G.k.4.r.3 Unidade do intervalo (CL26 — ich-interval-unit,
    // tokens UCUM, não é um codelist numérico ICH). Rótulo em PT (mostrado
    // no dropdown) -> token UCUM (vai literal no atributo `unit` do XML).
    UNIDADE_INTERVALO_MAP: {
      'HORA(S)':   'h',
      'DIA(S)':    'd',
      'SEMANA(S)': 'wk',
      'MÊS(ES)':   'mo',
      'ANO(S)':    'a'
    },

    // D.5 — espelha valores livres vindos do ETL (relatório de entradas).
    // Cobre variações comuns de grafia da origem bruta.
    SEXO_MAP: {
      'M': '1', 'MASCULINO': '1',
      'F': '2', 'FEMININO':  '2'
    },

    // NOTA: sistema hoje é uso exclusivo da Farmácia — C.2.r.4 é fixado em
    // '2' (Pharmacist) direto em E2B.gs, sem depender de caso.notificador.categoria.
    // Mapa mantido só para eventual reintrodução de notificador externo.
    // Espelha exatamente os data-cat dos botões "cat-pill" em form.html.
    // Se um novo botão de categoria for adicionado lá, adicionar aqui também.
    QUALIFICACAO_MAP: {
      'Médico(a)':                '1',
      'Farmacêutico(a)':           '2',
      'Enfermeiro(a)':             '3',
      'Técnico(a) de Enfermagem':  '3',
      'Outro':                     '3'
    },

    // Espelha DEFAULT_LISTAS.gravidade (Config.gs / config_geral/listas).
    // GRAVE cai em "outro_importante" por falta de granularidade nos dados —
    // ver decisão pendente sobre adicionar checkboxes específicos.
    GRAVIDADE_MAP: {
      'FATAL':    { morte: true,  hospital: false, risco_vida: false, incapacitante: false, outro_importante: false },
      'GRAVE':    { morte: false, hospital: false, risco_vida: false, incapacitante: false, outro_importante: true  },
      'MODERADA': { morte: false, hospital: false, risco_vida: false, incapacitante: false, outro_importante: false },
      'LEVE':     { morte: false, hospital: false, risco_vida: false, incapacitante: false, outro_importante: false }
    },

    // Espelha DEFAULT_LISTAS.desfecho -> E.i.7 (codelist pública do ICH,
    // não é vocabulário proprietário — sem bloqueio de licença).
    DESFECHO_MAP: {
      'PACIENTE RECUPERADO':      '1', // Recovered/resolved
      'TRANSFERÊNCIA INTERNA':    '2', // Recovering/resolving
      'ALTA':                     '2',
      'PROLONGADO INTERNAÇÃO':    '3', // Not recovered/not resolved
      'TRANSFERÊNCIA EXTERNA':    '3',
      'ÓBITO':                    '5'  // Fatal
      // fallback '6' Unknown se valor não mapeado — ver validação em E2B.gs
    },

    // F0-01 (G.k.9.i.4 Reexposição, CL16) — espelha os 4 valores do dropdown
    // DEFAULT_LISTAS.readministrado (Config.gs). Elemento 0..1: se
    // caso.readministrado estiver vazio ou sem match, o bloco é omitido no XML
    // (ver E2B.gs) em vez de forçar um código.
    REEXPOSICAO_MAP: {
      'NÃO':                                '4', // Não–N/A (sem reexposição)
      'SIM':                                '3', // Sim–Desconhecido (reexposição feita, desfecho não detalhado)
      'SIM. SINTOMAS REAPARECERAM':         '1', // Sim–Sim (reexposição feita, reação recorreu)
      'SIM. SINTOMAS NÃO REAPARECERAM':     '2'  // Sim–Não (reexposição feita, reação não recorreu)
    },

    // F0-04 (E.i.3.1 Termo destacado pelo notificador, CL10) — derivado de
    // caso.gravidade, mesmas chaves de GRAVIDADE_MAP. FATAL/GRAVE = destacado.
    TERMO_DESTACADO_MAP: {
      'FATAL':    '3',
      'GRAVE':    '3',
      'MODERADA': '2',
      'LEVE':     '2'
    },

    // Espelha NARANJO_FAIXAS (js_investigacao.html) — replicado aqui pro
    // backend, que não deve depender do frontend como fonte de verdade.
    NARANJO_CATEGORIA: [
      { min: 9,          max: Infinity,  valor: 'DEFINITE' },
      { min: 5,          max: 8,         valor: 'PROBABLE' },
      { min: 1,          max: 4,         valor: 'POSSIBLE' },
      { min: -Infinity,  max: 0,         valor: 'DOUBTFUL' }
    ]
  }
};

/**
 * SCHEMA.FS (anexo Schema.gs):
 * { CASOS:'casos_ram', GERAL:'config_geral', SETORES:'setores',
 *   LISTAS:'listas', NARANJO:'naranjo', LOG:'log_auditoria', USUARIOS:'usuarios' }
 */
