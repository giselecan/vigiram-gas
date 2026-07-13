/**
 * @fileoverview Cases.gs — Operações de caso (Fase 4: Firestore).
 *
 * A ASSINATURA PÚBLICA das funções pré-existentes NÃO MUDA — apenas o
 * FORMATO do objeto retornado por getTodosOsCasos() mudou (ver P2 abaixo).
 *
 * CONCORRÊNCIA: comTrava_()/LockService substituído por fsRunTransaction_()
 * (transação nativa do Firestore com retry automático em conflito — ver
 * Firestore.gs).
 *
 * BUSCA DE CASO: localizarLinhaCaso_/TextFinder substituído por
 * fsLocalizarCaso_ — já é O(1) por natureza.
 *
 * AUDITORIA: carimbarAuditoria_/registrarLog_ (Sheets) substituídos por
 * fsCarimbarAuditoria_/fsRegistrarLog_ (Firestore.gs).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * OTIMIZAÇÃO DE PERFORMANCE (revisão 07/2026):
 *   P1.1 — getTodosOsCasos() agora usa CacheService (TTL 45s). Com ~22
 *          usuários simultâneos, várias sincronizações caem na mesma
 *          janela e reaproveitam o cache em vez de repetir o full-scan
 *          no Firestore.
 *   P1.2 — registrarTriagem() e registrarInvestigacao() agora RETORNAM
 *          o caso atualizado (antes retornavam apenas `true`). Isso
 *          permite ao frontend fazer atualização otimista local
 *          (atualizarCasoLocal em js_core.html) em vez de chamar
 *          carregarCasos() e reprocessar a base inteira após CADA ação
 *          pontual de escrita.
 *   P2    — getTodosOsCasos() passa a buscar apenas o RESUMO do caso
 *          (campos usados no Kanban/Dashboard: id, prontuário, setor,
 *          medicamento, status, data, iniciais, gravidade, farmacêutico,
 *          conclusão) via fsListarComMascara_, reduzindo o payload da
 *          sincronização geral. Os campos de investigação completa
 *          (história clínica, Naranjo, PII do notificador etc.) só são
 *          buscados sob demanda por getCasoDetalhado(id, token), chamada
 *          quando o modal de investigação é aberto (ver js_investigacao.html).
 *          IMPORTANTE: casosGlobais no frontend passa a conter objetos
 *          "resumo" — qualquer novo campo de card no Kanban/Dashboard
 *          precisa ser adicionado em CAMPOS_RESUMO_CASOS + _mapearCasoResumo_.
 * ═══════════════════════════════════════════════════════════════════════
 */

// ============================================================
// CONSTANTES — chave de cache e campos do "resumo" (Kanban/Dashboard)
// ============================================================
const CACHE_CASOS_KEY     = 'CASOS_RESUMO_V1';
const CACHE_CASOS_TTL_SEG = 45;

// Nomes de campo no documento Firestore (não os nomes que o frontend usa) —
// mantidos aqui em vez de Schema.gs porque são específicos da leitura em
// lista (fsListarComMascara_), diferente de SCHEMA.FS.* (nome de coleção).
const CAMPOS_RESUMO_CASOS = [
  'id', 'data', 'tipo', 'prontuario', 'iniciais', 'nascimento',
  'setor', 'medicamento', 'status', 'gravidade', 'farmaceutico', 'conclusao',
  'numVigimed', 'dataVigimed', 'dataTriagem'
];
// ============================================================
// MAPEAMENTO — RESUMO (Kanban/Dashboard) vs COMPLETO (modal de investigação)
// ============================================================

/** Mapeia um doc Firestore (já filtrado por CAMPOS_RESUMO_CASOS) para o formato do frontend. */
function _mapearCasoResumo_(doc) {
  if (!doc || !doc.id) return null;
  const tz = Session.getScriptTimeZone();

  const dataTratada = doc.data instanceof Date
    ? Utilities.formatDate(doc.data, tz, 'dd/MM/yyyy HH:mm')
    : (doc.data ? String(doc.data).trim() : 'Data N/I');

  return {
    id:              String(doc.id || '').trim(),
    data_evento:     dataTratada,
    tipo:            String(doc.tipo || 'BA').trim(),
    prontuario:      String(doc.prontuario || 'N/I').trim(),
    paciente:        String(doc.iniciais || 'N/I').trim(),
    data_nascimento: String(doc.nascimento != null ? doc.nascimento : '').trim(),
    setor:           String(doc.setor || 'N/I').trim(),
    medicamento:     String(doc.medicamento || 'N/I').trim(),
    status:          String(doc.status || SCHEMA.STATUS.TRIAGEM).trim(),
    gravidade:       String(doc.gravidade || '').trim(),
    farmaceutico:    String(doc.farmaceutico || '').trim(),
    conclusao:       String(doc.conclusao || '').trim(),
    numVigimed:      String(doc.numVigimed || '').trim(),
    dataVigimed:     doc.dataVigimed instanceof Date
      ? Utilities.formatDate(doc.dataVigimed, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : String(doc.dataVigimed || '').trim(),
    dataTriagem:     doc.dataTriagem instanceof Date
      ? Utilities.formatDate(doc.dataTriagem, tz, "yyyy-MM-dd'T'HH:mm:ss")
      : String(doc.dataTriagem || '').trim()
  };
}

/** Mapeia um doc Firestore COMPLETO (sem field mask) para o formato do frontend — usado pelo modal de investigação. */
function _mapearCasoCompleto_(doc) {
  if (!doc || !doc.id) return null;
  const tz = Session.getScriptTimeZone();

  const dataTratada = doc.data instanceof Date
    ? Utilities.formatDate(doc.data, tz, 'dd/MM/yyyy HH:mm')
    : (doc.data ? String(doc.data).trim() : 'Data N/I');

  const dataVigi = doc.dataVigimed instanceof Date
    ? Utilities.formatDate(doc.dataVigimed, tz, 'yyyy-MM-dd HH:mm')
    : (doc.dataVigimed ? String(doc.dataVigimed).trim() : '');

  const atualizadoEm = (doc.auditoria && doc.auditoria.atualizadoEm instanceof Date)
    ? Utilities.formatDate(doc.auditoria.atualizadoEm, tz, 'dd/MM/yyyy HH:mm')
    : (doc.auditoria && doc.auditoria.atualizadoEm ? String(doc.auditoria.atualizadoEm).trim() : '');

  const notif = doc.notificador || {};
  const dataNotificacao = notif.dataNotificacao instanceof Date
    ? Utilities.formatDate(notif.dataNotificacao, tz, 'dd/MM/yyyy HH:mm')
    : (notif.dataNotificacao ? String(notif.dataNotificacao).trim() : '');

  return {
    id:              String(doc.id || '').trim(),
    data_evento:     dataTratada,
    tipo:            String(doc.tipo || 'BA').trim(),
    prontuario:      String(doc.prontuario || 'N/I').trim(),
    paciente:        String(doc.iniciais || 'N/I').trim(),
    data_nascimento: String(doc.nascimento != null ? doc.nascimento : '').trim(),
    setor:           String(doc.setor || 'N/I').trim(),
    medicamento:     String(doc.medicamento || 'N/I').trim(),
    status:          String(doc.status || SCHEMA.STATUS.TRIAGEM).trim(),
    historiaClinica: String(doc.historiaClinica || '').trim(),
    relatoEvento:    String(doc.relato || '').trim(),
    exames:          String(doc.exames || '').trim(),
    readministrado:  String(doc.readministrado || '').trim(),
    evolucao:        String(doc.evolucao || '').trim(),
    desfecho:        String(doc.desfecho || '').trim(),
    conclusao:       String(doc.conclusao || '').trim(),
    naranjo:         String(doc.naranjo || '').trim(),
    gravidade:       String(doc.gravidade || '').trim(),
    farmaceutico:    String(doc.farmaceutico || '').trim(),
    numVigimed:      String(doc.numVigimed || '').trim(),
    dataVigimed:     dataVigi,
    observacoes:     String(doc.observacoes || '').trim(),
    naranjoRespostas:String(doc.naranjoRespostas || '').trim(),
    atualizadoPor:   String(doc.auditoria && doc.auditoria.atualizadoPor || '').trim(),
    atualizadoEm:    atualizadoEm,
    // LOTE/LABORATORIO separados (07/2026). Fallback lê o campo legado
    // loteLaboratorio de docs antigos ainda não re-salvos pela investigação.
    lote:            String(doc.lote != null && doc.lote !== '' ? doc.lote : (doc.loteLaboratorio || '')).trim(),
    laboratorio:     String(doc.laboratorio || '').trim(),
    relatoNotificador:  String(doc.relatoNotificador  || '').trim(),
    condutaNotificador: String(doc.condutaNotificador || '').trim(),

    notifNome:       String(notif.nome      || '').trim(),
    notifCategoria:  String(notif.categoria || '').trim(),
    notifEmail:      String(notif.email     || '').trim(),
    dataNotificacao: dataNotificacao,
    // ── Fase 8 / Exportação E2B(R3) — adicionar dentro do objeto retornado ──
    reacaoTermo:       String(doc.reacaoTermo      || '').trim(),
    doseMedicamento:   String(doc.doseMedicamento  || '').trim(),
    doseUnidade:       String(doc.doseUnidade      || '').trim(),
    viaAdministracao:  String(doc.viaAdministracao || '').trim(),
    dataInicioReacao:  (doc.dataInicioReacao instanceof Date)
    ? Utilities.formatDate(doc.dataInicioReacao, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
    : String(doc.dataInicioReacao || '').trim(),

    // ── Ajuste E2B (D.5 Sexo / G.k.4.r.4 Início Adm. / D.2.1 Nascimento editável) ──
    sexo:                     String(doc.sexo || '').trim(),
    nascimento:               String(doc.nascimento != null ? doc.nascimento : '').trim(),
    dataInicioAdministracao:  (doc.dataInicioAdministracao instanceof Date)
      ? Utilities.formatDate(doc.dataInicioAdministracao, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
      : String(doc.dataInicioAdministracao || '').trim(),

    // ── Fase 2 (roadmap) — campos novos da tela de investigação ────────────
    acaoAdotada:              String(doc.acaoAdotada             || '').trim(),
    indicacaoUso:             String(doc.indicacaoUso            || '').trim(),
    dataFimAdministracao:     (doc.dataFimAdministracao instanceof Date)
      ? Utilities.formatDate(doc.dataFimAdministracao, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
      : String(doc.dataFimAdministracao || '').trim(),
    dataFimReacao:            (doc.dataFimReacao instanceof Date)
      ? Utilities.formatDate(doc.dataFimReacao, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
      : String(doc.dataFimReacao || '').trim(),
    pesoKg:                   String(doc.pesoKg                  != null ? doc.pesoKg  : '').trim(),
    alturaCm:                 String(doc.alturaCm                != null ? doc.alturaCm : '').trim(),
    formaFarmaceutica:        String(doc.formaFarmaceutica       || '').trim(),
    numeroDosesIntervalo:     String(doc.numeroDosesIntervalo    != null ? doc.numeroDosesIntervalo : '').trim(),
    unidadeIntervalo:         String(doc.unidadeIntervalo        || '').trim(),
    // F2-09 — subtabela repetível [{ nome, data, valor, unidade, refMin, refMax }]
    examesEstruturados:       Array.isArray(doc.examesEstruturados) ? doc.examesEstruturados : [],
    dataObito:                String(doc.dataObito               || '').trim(),
    relacaoMedicamentoEvento: String(doc.relacaoMedicamentoEvento|| '').trim(),
    problemasAdicionais:      Array.isArray(doc.problemasAdicionais) ? doc.problemasAdicionais : [],
    dum:                      String(doc.dum                     || '').trim(),
    gestante:                 !!doc.gestante,
    lactante:                 !!doc.lactante,
  };
}

// ============================================================
// LEITURA (read-only, sem trava)
// ============================================================

/**
 * Retorna o RESUMO de todos os casos (campos do Kanban/Dashboard),
 * com cache de 45s (P1.1) e field mask (P2) para reduzir tráfego.
 */
function getTodosOsCasos(token) {
  return comAutenticacao_(token, function () {
    try {
      const cache = CacheService.getScriptCache();
      const hit = cache.get(CACHE_CASOS_KEY);
      if (hit) {
        try { return JSON.parse(hit); } catch (e) { /* cache corrompido: relê abaixo */ }
      }

      const docs  = fsListarComMascara_(SCHEMA.FS.CASOS, CAMPOS_RESUMO_CASOS);
      const casos = docs.map(_mapearCasoResumo_).filter(Boolean);

      try {
        cache.put(CACHE_CASOS_KEY, JSON.stringify(casos), CACHE_CASOS_TTL_SEG);
      } catch (e) {
        // Payload pode ultrapassar 100KB do CacheService em bases muito
        // grandes — segue sem cache nesse caso (degradação graciosa).
      }

      return casos;
    } catch (erro) {
      throw new Error('Erro ao consolidar base Kanban: ' + erro.message);
    }
  });
}

/** Remove o cache de resumo — chamar após QUALQUER escrita em casos_ram. */
function invalidarCasosCache_() {
  CacheService.getScriptCache().remove(CACHE_CASOS_KEY);
}

/**
 * P2: Busca o detalhe COMPLETO de um único caso (todos os campos de
 * investigação, Naranjo, PII do notificador). Chamada sob demanda quando
 * o modal de investigação é aberto — não faz parte da sincronização geral.
 */
function getCasoDetalhado(id, token) {
  return comAutenticacao_(token, function () {
    const idLimpo = String(id || '').trim();
    if (!idLimpo) throw new Error('ID do caso não informado.');
    const doc = fsGetDoc_(SCHEMA.FS.CASOS, idLimpo);
    if (!doc) throw new Error('Caso não localizado.');
    return _mapearCasoCompleto_(doc);
  });
}

// ============================================================
// ESCRITAS (todas com transação Firestore + auditoria)
// ============================================================

/**
 * Salva uma nova notificação espontânea (form.html ou notificação interna).
 * RETORNO: { farmaceuticoResponsavel: string } — idêntico ao original.
 */

/**
 * Normaliza valor vindo de <input type="datetime-local"> ("yyyy-MM-ddTHH:mm")
 * para "yyyy-MM-dd HH:mm" antes de persistir — legível no espelho/auditoria.
 * Datas sem hora e strings legadas passam intactas. E2B.gs continua lendo
 * ambos os formatos (_formatarDataE2B_ casa o prefixo yyyy-MM-dd).
 */
function _normalizarDataHoraInput_(v) {
  return String(v == null ? '' : v).trim().replace('T', ' ');
}

const _DE_IDEMP_PREFIXO = 'DE_IDEMP_';
const _DE_IDEMP_TTL_SEG = 21600; // 6h — cobre retries de rede do form

function salvarDemandaEspontanea(formDados) {
  try {
    // IDEMPOTÊNCIA (form.html envia idempotencyKey e REUTILIZA a mesma chave
    // no retry após timeout). A versão anterior IGNORAVA a chave: se o 1º
    // envio gravava mas a resposta se perdia na rede, o retry criava um caso
    // DUPLICADO (idCaso muda porque usa timestamp). Agora a chave é registrada
    // no CacheService e o retry devolve o resultado original sem regravar.
    const chaveIdemp = String(formDados && formDados.idempotencyKey || '').trim();
    const cacheIdemp = CacheService.getScriptCache();
    if (chaveIdemp) {
      const jaProcessado = cacheIdemp.get(_DE_IDEMP_PREFIXO + chaveIdemp);
      if (jaProcessado) {
        try { return JSON.parse(jaProcessado); } catch (e) { /* segue e regrava */ }
      }
    }

    const prontuario  = String(formDados && formDados.prontuario  || '').trim();
    const iniciais    = String(formDados && formDados.iniciais    || '').trim();
    const setor       = String(formDados && formDados.setor       || '').trim();
    const medicamento = String(formDados && formDados.medicamento || '').trim();

    if (!prontuario || !iniciais || !setor || !medicamento) {
      throw new Error('Preencha os campos obrigatórios: prontuário, iniciais, setor e medicamento.');
    }

    const agora  = new Date();
    const idCaso = `ESP-${prontuario}-${agora.getTime().toString().slice(-6)}`;

    const nomeNotif  = String(formDados.notificador           || 'N/I').trim();
    const catNotif   = String(formDados.categoriaProfissional || 'N/I').trim();
    const emailNotif = String(formDados.emailNotificador      || '').trim();

    let farmaceuticoResponsavel = '';
    try {
      const cfg = getConfig_();
      const setorUp = setor.toUpperCase().trim();
      const setorObj = (cfg.setores || []).find(function (s) {
        return s.setor && s.setor.toUpperCase().trim() === setorUp;
      });
      if (setorObj && setorObj.farmaceutico) {
        farmaceuticoResponsavel = setorObj.farmaceutico;
      }
    } catch (e) {
      console.warn('Não foi possível resolver o farmacêutico do setor: ' + e.message);
    }

    // CORREÇÃO (auditoria_qa_datas_tipagem_2026-07-13.md #4): `data` agora é
    // SEMPRE um Date real (Timestamp no Firestore), nunca string pré-formatada.
    // Antes esta função gravava dd/MM/yyyy HH:mm:ss OU yyyy-MM-dd HH:mm
    // dependendo do ramo — os dois formatos escapavam do filtro de período
    // do Kanban/Dashboard (regex só reconhecia dd/MM/yyyy) e do critério
    // "caso de hoje" de Manuntenção.gs. _parseDataFlexivel_ interpreta o
    // valor do <input type="datetime-local"> ("yyyy-MM-ddTHH:mm"); se vier
    // vazio ou não-parseável, cai no timestamp de inclusão (`agora`).
    const dataEventoValida = _parseDataFlexivel_(formDados.dataEvento) || agora;

    const objetoCaso = {
      id: idCaso,
      data: dataEventoValida,
      tipo: 'DE',
      prontuario: prontuario,
      iniciais: iniciais.toUpperCase(),
      nascimento: formDados.nascimento || '',
      setor: setor.toUpperCase(),
      medicamento: medicamento.toUpperCase(),
      status: SCHEMA.STATUS.INVESTIGACAO,
      sla: 'AGUARDANDO SLA',
      farmaceutico: farmaceuticoResponsavel,

      motivoDescarte: '', historiaClinica: '', relato: '', exames: '',
      readministrado: '', evolucao: '', desfecho: '', conclusao: '',
      naranjo: '', gravidade: '', numVigimed: '', dataVigimed: '',
      observacoes: '', naranjoRespostas: '', lote: '', laboratorio: '',

      relatoNotificador: formDados.descricao || '',
      condutaNotificador: formDados.condutas || '',

      notificador: {
        nome: nomeNotif,
        categoria: catNotif,
        email: emailNotif,
        dataNotificacao: agora
      },

      auditoria: {
        atualizadoPor: 'Formulário Assistência',
        atualizadoEm: agora
      }
    };

    fsSetDoc_(SCHEMA.FS.CASOS, idCaso, objetoCaso);
    espelharCasoNoSheets_(idCaso, objetoCaso, 'CRIACAO');
    fsRegistrarLog_('NOTIFICACAO_ESPONTANEA', idCaso, `${setor} / ${medicamento}`);
    invalidarCasosCache_(); // P1.1 — novo caso precisa aparecer na próxima leitura
    notificarNovaDemandaEspontanea_(objetoCaso); // Notify.gs — alerta imediato ao farmacêutico do setor

    const resultado = { farmaceuticoResponsavel: farmaceuticoResponsavel };

    // Registra a chave de idempotência SÓ após sucesso completo — um retry
    // com a mesma chave passa a devolver este mesmo resultado.
    if (chaveIdemp) {
      try {
        cacheIdemp.put(_DE_IDEMP_PREFIXO + chaveIdemp, JSON.stringify(resultado), _DE_IDEMP_TTL_SEG);
      } catch (e) { /* cache indisponível — degrada sem quebrar o envio */ }
    }

    return resultado;

  } catch (erro) {
    throw new Error(`Erro ao salvar demanda espontânea: ${erro.message}`);
  }
}

/**
 * Trilha os casos gerados pelos gatilhos do PowerShell (Busca Ativa).
 *
 * P1.2: retorna o caso ATUALIZADO (resumo) em vez de `true` — permite
 * atualização otimista local no frontend (atualizarCasoLocal).
 */
function registrarTriagem(dados, token) {
  return comAutenticacao_(token, function () {
    try {
      let casoAtualizado = null;
      fsRunTransaction_(function (ctx) {
        const caso = fsTxnGetDoc_(ctx.id, SCHEMA.FS.CASOS, dados.idCaso);
        if (!caso) throw new Error('Caso não localizado.');

        // Regra #7: dataTriagem é carimbo ÚNICO — se o caso já tiver o
        // timestamp (re-triagem/retrabalho), PRESERVA o original em vez de
        // sobrescrever, senão o SLA medido seria falsificado.
        const dataTriagemFinal = caso.dataTriagem || new Date();
        let atualizacao;
        if (dados.houveRam === false) {
          atualizacao = {
            status: SCHEMA.STATUS.DESCARTADO,
            motivoDescarte: dados.motivoDescarte,
            dataTriagem: dataTriagemFinal
          };
        } else {
          atualizacao = {
            medicamento: String(dados.medSuspeito || '').toUpperCase().trim(),
            status: SCHEMA.STATUS.INVESTIGACAO,
            dataTriagem: dataTriagemFinal
          };
        }

        fsTxnUpdateDoc_(ctx, SCHEMA.FS.CASOS, dados.idCaso, atualizacao);
        fsCarimbarAuditoria_(ctx, dados.idCaso);
        // Estado pós-transação montado em memória (pré-imagem + atualização):
        // evita um fsGetDoc_ extra só para devolver o resumo e reflete
        // exatamente o que ESTA transação gravou (não um estado que um writer
        // concorrente possa ter mudado entre o commit e uma releitura).
        casoAtualizado = Object.assign({}, caso, atualizacao);
        return true;
      });

      // FASE 9: triagem é rascunho/estado intermediário — só o Firestore
      // (fonte única) é tocado aqui. O Sheets (append-only) só recebe uma
      // linha de backup na CRIAÇÃO do caso (Ingest.gs/salvarDemandaEspontanea)
      // e no FECHAMENTO da investigação (registrarInvestigacao), nunca em
      // passos intermediários — ver Mirror.gs.
      invalidarCasosCache_(); // P1.1

      // Bug corrigido: a versão anterior chamava fsRegistrarLog_ DUAS vezes
      // com o mesmo evento (log duplicado por triagem). Agora só uma vez.
      if (dados.houveRam === false) {
        fsRegistrarLog_('DESCARTE', dados.idCaso, dados.motivoDescarte);
      } else {
        fsRegistrarLog_('TRIAGEM', dados.idCaso, 'Enviado para investigação');
      }

      return _mapearCasoResumo_(casoAtualizado);

    } catch (erro) {
      throw new Error(`Erro na triagem: ${erro.message}`);
    }
  });
}

/**
 * Persiste a avaliação clínica e a aplicação do Algoritmo de Naranjo.
 *
 * P1.2: retorna o caso ATUALIZADO (resumo) em vez de `true`.
 */
function registrarInvestigacao(dados, token) {
  return comAutenticacao_(token, function () {
    try {
      const novoStatus = dados.encerrar ? SCHEMA.STATUS.CONCLUIDO : SCHEMA.STATUS.INVESTIGACAO;

      fsRunTransaction_(function (ctx) {
        const caso = fsTxnGetDoc_(ctx.id, SCHEMA.FS.CASOS, dados.idCaso);
        if (!caso) throw new Error('Caso não localizado para investigação.');

        // GUARDA SERVER-SIDE: o travamento de campos de caso CONCLUÍDO era
        // enforced só no frontend. Qualquer chamada direta com token válido
        // podia sobrescrever um caso concluído sem reabri-lo — quebrando a
        // integridade regulatória (caso já exportado/importado no VigiMed).
        // Única via de escrita clínica em CONCLUÍDO é reabrirInvestigacao().
        if (caso.status === SCHEMA.STATUS.CONCLUIDO) {
          throw new Error('Caso CONCLUÍDO está travado. Use "Reabrir investigação" antes de editar.');
        }

        fsTxnUpdateDoc_(ctx, SCHEMA.FS.CASOS, dados.idCaso, {
          status: novoStatus,
          // Farmacêutico pode corrigir o nome do medicamento suspeito caso o
          // notificador tenha digitado errado na notificação original.
          medicamento: dados.medicamento
            ? String(dados.medicamento).toUpperCase().trim()
            : caso.medicamento,
          historiaClinica: dados.historiaClinica,
          relato: dados.relatoEvento,
          exames: dados.exames,
          readministrado: dados.readministrado,
          evolucao: dados.evolucao,
          desfecho: dados.desfecho,
          conclusao: dados.conclusao,
          naranjo: dados.naranjo,
          gravidade: dados.gravidade,
          farmaceutico: dados.farmaceutico,
          numVigimed: dados.numVigimed,
          dataVigimed: _normalizarDataHoraInput_(dados.dataVigimed),
          observacoes: dados.observacoes,
          naranjoRespostas: dados.naranjoRespostas,
          lote:        dados.lote        || '',
          laboratorio: dados.laboratorio || '',
          // ── Fase 8 / Exportação E2B(R3) ──────────────────────────────────────
          reacaoTermo:       dados.reacaoTermo      || '',
          doseMedicamento:   dados.doseMedicamento  || '',
          doseUnidade:       dados.doseUnidade      || '',
          viaAdministracao:  dados.viaAdministracao || '',
          dataInicioReacao:  _normalizarDataHoraInput_(dados.dataInicioReacao) || null,
          // idReacaoE2B / idMedicamentoE2B / safetyReportIdE2B NÃO entram aqui —
          // são gerados e persistidos só na hora da exportação, por E2B.gs
          // (ver gerarXmlE2B), não no fluxo de investigação.

          // ── Ajuste E2B (D.2.1 Nascimento editável / G.k.4.r.4 Início Adm.) ────
          nascimento:              dados.nascimento              || caso.nascimento,
          dataInicioAdministracao: _normalizarDataHoraInput_(dados.dataInicioAdministracao) || null,

          // ── Fase 2 (roadmap) — campos novos da tela de investigação ────────
          acaoAdotada:              dados.acaoAdotada              || '',
          indicacaoUso:             dados.indicacaoUso             || '',
          dataFimAdministracao:     _normalizarDataHoraInput_(dados.dataFimAdministracao) || null,
          dataFimReacao:            _normalizarDataHoraInput_(dados.dataFimReacao)         || null,
          // CORREÇÃO (auditoria_qa_datas_tipagem_2026-07-13.md #8): pesoKg/
          // alturaCm/numeroDosesIntervalo agora persistem como Number (não
          // String) — os campos são <input type="number"> (Utilities.gs
          // _paraNumeroOuVazio_ só formaliza o que o browser já garante).
          // Leitores existentes (_mapearCasoCompleto_ abaixo, E2b.gs
          // _normalizarNumeroE2B_) já tratam Number e String igualmente,
          // inclusive o valor 0 — não reintroduz o bug de "zero falsy".
          pesoKg:                   _paraNumeroOuVazio_(dados.pesoKg),
          alturaCm:                 _paraNumeroOuVazio_(dados.alturaCm),
          formaFarmaceutica:        dados.formaFarmaceutica        || '',
          numeroDosesIntervalo:     _paraNumeroOuVazio_(dados.numeroDosesIntervalo),
          unidadeIntervalo:         dados.unidadeIntervalo         || '',
          // F2-09 — array já vem pronto do frontend (subtabela repetível);
          // filtra qualquer linha totalmente vazia antes de persistir.
          examesEstruturados:       Array.isArray(dados.examesEstruturados)
            ? dados.examesEstruturados.filter(function (e) {
                return e && (e.nome || e.valor);
              })
            : [],
          dataObito:                dados.dataObito                || '',
          relacaoMedicamentoEvento: dados.relacaoMedicamentoEvento || '',
          problemasAdicionais:      Array.isArray(dados.problemasAdicionais) ? dados.problemasAdicionais : [],
          dum:                      dados.dum                      || '',
          gestante:                 !!dados.gestante,
          lactante:                 !!dados.lactante
        });
        
        fsCarimbarAuditoria_(ctx, dados.idCaso);
        return true;
      });

      invalidarCasosCache_(); // P1.1
      fsRegistrarLog_(
        dados.encerrar ? 'INVESTIGACAO_FINALIZADA' : 'INVESTIGACAO_RASCUNHO',
        dados.idCaso,
        dados.conclusao || ''
      );

      const docAtualizado = fsGetDoc_(SCHEMA.FS.CASOS, dados.idCaso);
      const resultado      = _mapearCasoResumo_(docAtualizado);

      // FASE 9 — Sheets é append-only, "backup histórico de casos
      // investigados": só grava uma linha NOVA (nunca sobrescreve) quando a
      // investigação é de fato FINALIZADA (encerrar=true), nunca em
      // rascunho. Feito por ÚLTIMO, com o payload de retorno já pronto em
      // `resultado` — espelharCasoNoSheets_ tem seu próprio try/catch e, se
      // o Sheets falhar/demorar, cai na fila de retry (Mirror.gs) em vez de
      // atrasar ou quebrar o retorno ao frontend.
      if (novoStatus === SCHEMA.STATUS.CONCLUIDO) {
        espelharCasoNoSheets_(dados.idCaso, docAtualizado, 'FECHAMENTO');
        notificarInvestigacaoConcluida_(docAtualizado); // Notify.gs — alerta ao notificador original (só casos DE)
      }

      return resultado;

    } catch (erro) {
      throw new Error(`Erro ao salvar investigação: ${erro.message}`);
    }
  });
}

/**
 * Reabre um caso CONCLUÍDO — única via de destravar os campos de
 * investigação. Guarda de estado: só aceita partir de CONCLUIDO.
 */
function reabrirInvestigacao(idCaso, token) {
  return comAutenticacao_(token, function () {
    try {
      const idLimpo = String(idCaso || '').trim();
      if (!idLimpo) throw new Error('ID do caso não informado.');

      let casoAtualizado = null;
      fsRunTransaction_(function (ctx) {
        const caso = fsTxnGetDoc_(ctx.id, SCHEMA.FS.CASOS, idLimpo);
        if (!caso) throw new Error('Caso não localizado.');
        if (caso.status !== SCHEMA.STATUS.CONCLUIDO) {
          throw new Error('Somente casos CONCLUÍDOS podem ser reabertos.');
        }

        const atualizacao = { status: SCHEMA.STATUS.INVESTIGACAO };
        fsTxnUpdateDoc_(ctx, SCHEMA.FS.CASOS, idLimpo, atualizacao);
        fsCarimbarAuditoria_(ctx, idLimpo);
        casoAtualizado = Object.assign({}, caso, atualizacao); // ver nota em registrarTriagem
        return true;
      });

      // FASE 9: reabertura é uma correção de estado no Firestore (fonte
      // única) — não gera nova linha de backup no Sheets (append-only só
      // registra criação e fechamento). A auditoria da reabertura já fica
      // registrada via fsRegistrarLog_ abaixo.
      invalidarCasosCache_();
      fsRegistrarLog_('CASO_REABERTO', idLimpo, 'Retornado para investigação pelo farmacêutico');

      return _mapearCasoResumo_(casoAtualizado);

    } catch (erro) {
      throw new Error(`Erro ao reabrir caso: ${erro.message}`);
    }
  });
}

/**
 * Registra nº/data de importação no VigiMed. ÚNICA escrita permitida em
 * caso CONCLUIDO sem reabri-lo (campos clínicos permanecem travados).
 */
function registrarImportacaoVigimed(dados, token) {
  return comAutenticacao_(token, function () {
    try {
      const idLimpo = String(dados && dados.idCaso || '').trim();
      if (!idLimpo) throw new Error('ID do caso não informado.');

      let casoAtualizado = null;
      fsRunTransaction_(function (ctx) {
        const caso = fsTxnGetDoc_(ctx.id, SCHEMA.FS.CASOS, idLimpo);
        if (!caso) throw new Error('Caso não localizado.');
        if (caso.status !== SCHEMA.STATUS.CONCLUIDO) {
          throw new Error('Só é possível registrar importação VigiMed em casos CONCLUÍDOS.');
        }

        const atualizacao = {
          numVigimed:  String(dados.numVigimed  || '').trim(),
          dataVigimed: _normalizarDataHoraInput_(dados.dataVigimed)
        };
        fsTxnUpdateDoc_(ctx, SCHEMA.FS.CASOS, idLimpo, atualizacao);
        fsCarimbarAuditoria_(ctx, idLimpo);
        casoAtualizado = Object.assign({}, caso, atualizacao); // ver nota em registrarTriagem
        return true;
      });

      // FASE 9: registro do nº/data VigiMed é um complemento pós-fechamento
      // no Firestore — não gera nova linha de backup no Sheets (o carimbo
      // definitivo do fechamento já foi gravado por registrarInvestigacao).
      invalidarCasosCache_();
      fsRegistrarLog_('VIGIMED_IMPORTADO', idLimpo, dados.numVigimed || '');

      return _mapearCasoResumo_(casoAtualizado);

    } catch (erro) {
      throw new Error(`Erro ao registrar importação VigiMed: ${erro.message}`);
    }
  });
}
