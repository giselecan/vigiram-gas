/**
 * @fileoverview Mirror.gs — Espelho Firestore → Google Sheets (auditoria LGPD).
 *
 * OBJETIVO: garantir que toda escrita no Firestore (casos_ram, log_auditoria)
 * seja replicada nas abas DB_Casos_RAM e DB_Log do Sheets, mantendo o livro-
 * razão auditável sem depender de acesso ao console do Firebase.
 *
 * ARQUITETURA:
 *   1. Cada ponto de escrita em Cases.gs chama espelharCasoNoSheets_() após
 *      a escrita no Firestore.
 *   2. fsRegistrarLog_ chama espelharLogNoSheets_() após gravar no Firestore.
 *   3. Se a gravação no Sheets falhar, o payload é serializado em
 *      PropertiesService (fila MIRROR_RETRY_QUEUE) — máx. 50 itens / 9 KB.
 *   4. O trigger processarFilaEspelho() roda a cada 5 minutos e reprocessa
 *      os itens com falha em ordem FIFO, com até 3 tentativas por item.
 *      Após 3 falhas o item é descartado, registrado em console.error e
 *      um alerta é enviado por e-mail à coordenação (ver RETIFICAÇÃO abaixo).
 *
 * INTEGRAÇÃO — pontos de chamada já presentes em Cases.gs / Firestore.gs / Ingest.gs:
 *
 *   salvarDemandaEspontanea():
 *     após fsSetDoc_(SCHEMA.FS.CASOS, idCaso, objetoCaso)
 *     → espelharCasoNoSheets_(idCaso, objetoCaso, 'INSERT')
 *
 *   registrarTriagem():
 *     após fsRunTransaction_() bem-sucedido
 *     → espelharCasoNoSheets_(dados.idCaso, null, 'UPDATE')
 *
 *   registrarInvestigacao():
 *     após fsRunTransaction_() bem-sucedido
 *     → espelharCasoNoSheets_(dados.idCaso, null, 'UPDATE')
 *
 *   Ingest.gs (handleInsertDB):
 *     após fsSetDoc_/fsUpdateDoc_ do caso ETL
 *     → espelharCasoNoSheets_(idCaso, objetoCaso, 'INSERT')
 *
 *   Firestore.gs (fsRegistrarLog_):
 *     após fsSetDoc_() do log
 *     → espelharLogNoSheets_(payload do log)
 *
 * CONFIGURAÇÃO DO TRIGGER:
 *   Rode instalarTriggerEspelho() UMA VEZ no editor do Apps Script.
 *   Para remover: removerTriggerEspelho().
 *   VERIFICAÇÃO: rode verificarTriggerEspelho() a qualquer momento para
 *   confirmar se o trigger está instalado (causa raiz nº1 de "fila nunca
 *   reprocessa" é esse trigger nunca ter sido criado).
 *
 * CONSTRAINT PropertiesService:
 *   Cada valor: máx 9 KB. A fila serializa um array JSON.
 *   Se o payload de um caso ultrapassar 9 KB (improvável para este schema),
 *   o item é descartado imediatamente com console.error.
 *
 * RETIFICAÇÃO [Regra de Ouro #2 — Concorrência]:
 *   _gravarCasoNoSheets/_gravarLogNoSheets gravavam DIRETO no Sheets sem
 *   passar por comTrava_(). Com 22 usuários + robô PowerShell escrevendo
 *   simultâneo, TextFinder podia localizar linha desatualizada ou dois
 *   appendRow concorrentes duplicavam/perdiam linha — falha silenciosa que
 *   ia parar na fila de retry e, sem trigger instalado, nunca era
 *   reprocessada. Agora espelharCasoNoSheets_/espelharLogNoSheets_ e o
 *   reprocessamento da fila encapsulam a gravação em comTrava_(), igual ao
 *   resto do sistema.
 *
 * RETIFICAÇÃO [Visibilidade]:
 *   Falha de mirror antes só ia para console.error (ninguém lê). Ao
 *   descartar um item após MIRROR_RETRY_MAX tentativas, agora dispara
 *   e-mail para getConfig().geral.EMAIL_COORDENACAO.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────────────────
const MIRROR_RETRY_KEY      = 'MIRROR_RETRY_QUEUE';
const MIRROR_RETRY_MAX      = 3;   // tentativas antes de descartar
const MIRROR_FILA_MAX_ITENS = 50;  // limite de itens na fila

// ─────────────────────────────────────────────────────────────────────────────
// PONTO DE ENTRADA — CASOS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Espelha um caso no DB_Casos_RAM do Sheets.
 * Chamado após cada escrita no Firestore em Cases.gs e Ingest.gs.
 *
 * @param {string} idCaso
 * @param {Object|null} dadosObjeto — objeto já montado (INSERT) ou null (UPDATE:
 *   relê do Firestore para garantir consistência do espelho).
 * @param {'INSERT'|'UPDATE'} operacao
 */
function espelharCasoNoSheets_(idCaso, dadosObjeto, operacao) {
  try {
    // Para UPDATE relê o documento atual do Firestore — garante que o espelho
    // reflete o estado pós-transação, não dados parciais do caller.
    const doc = dadosObjeto || fsGetDoc_(SCHEMA.FS.CASOS, idCaso);
    if (!doc) {
      console.warn('Mirror: caso não encontrado no Firestore para espelhar — ' + idCaso);
      return;
    }

    // [RETIFICADO] gravação no Sheets agora sob comTrava_ — evita corrida
    // com frontend/ETL escrevendo na mesma aba ao mesmo tempo (Regra de Ouro #2).
    comTrava_(function () {
      _gravarCasoNoSheets(idCaso, doc, operacao);
    });

  } catch (e) {
    console.error('Mirror [espelharCasoNoSheets_] falhou para ' + idCaso + ': ' + e.message);
    _enfileirarRetry({ tipo: 'CASO', idCaso: idCaso, operacao: operacao || 'UPDATE', tentativas: 0 });
  }
}

/**
 * Espelha um evento de log no DB_Log do Sheets.
 * Chamado dentro de fsRegistrarLog_() após a escrita no Firestore.
 *
 * @param {{ data, usuario, acao, idCaso, detalhe }} payload
 */
function espelharLogNoSheets_(payload) {
  try {
    // [RETIFICADO] idem — gravação de log também sob comTrava_.
    comTrava_(function () {
      _gravarLogNoSheets(payload);
    });
  } catch (e) {
    console.error('Mirror [espelharLogNoSheets_] falhou: ' + e.message);
    _enfileirarRetry({ tipo: 'LOG', payload: payload, tentativas: 0 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GRAVAÇÃO NO SHEETS — CASOS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grava ou atualiza uma linha em DB_Casos_RAM respeitando SCHEMA.COL.*.
 * INSERT: appendRow. UPDATE: localiza por ID (coluna 1) via TextFinder e
 * sobrescreve a linha inteira (exceto ID e DATA, imutáveis).
 * IMPORTANTE: já deve ser chamada de dentro de comTrava_() pelo caller
 * (espelharCasoNoSheets_ / processarFilaEspelho) — esta função não trava
 * sozinha para evitar lock aninhado.
 */
function _gravarCasoNoSheets(idCaso, doc, operacao) {
  const aba = getSheet_(SCHEMA.ABAS.CASOS);
  if (!aba) throw new Error('Aba ' + SCHEMA.ABAS.CASOS + ' não encontrada.');

  const tz  = Session.getScriptTimeZone();

  // Formata datas
  const fmtData = function (val) {
    if (!val) return '';
    if (val instanceof Date) return Utilities.formatDate(val, tz, 'dd/MM/yyyy HH:mm');
    return String(val).trim();
  };
  const fmtDataVigi = function (val) {
    if (!val) return '';
    if (val instanceof Date) return Utilities.formatDate(val, tz, 'yyyy-MM-dd');
    return String(val).trim();
  };

  const notif = doc.notificador || {};

  // Monta linha posicional conforme SCHEMA.COL (46 colunas, 1-based → índice 0-based)
  const linha = new Array(SCHEMA.LARGURA).fill('');
  linha[SCHEMA.COL.ID                 - 1] = String(doc.id           || idCaso).trim();
  linha[SCHEMA.COL.DATA               - 1] = fmtData(doc.data);
  linha[SCHEMA.COL.TIPO               - 1] = String(doc.tipo         || 'BA').trim();
  linha[SCHEMA.COL.NOTIF_NOME         - 1] = String(notif.nome       || '').trim();
  linha[SCHEMA.COL.NOTIF_CATEGORIA    - 1] = String(notif.categoria  || '').trim();
  linha[SCHEMA.COL.DATA_NOTIFICACAO   - 1] = fmtData(notif.dataNotificacao);
  linha[SCHEMA.COL.PRONTUARIO         - 1] = String(doc.prontuario   || '').trim();
  linha[SCHEMA.COL.INICIAIS           - 1] = String(doc.iniciais     || '').trim();
  linha[SCHEMA.COL.NASCIMENTO         - 1] = String(doc.nascimento   || '').trim();
  linha[SCHEMA.COL.SEXO               - 1] = String(doc.sexo         || '').trim();
  linha[SCHEMA.COL.SETOR              - 1] = String(doc.setor        || '').trim();
  linha[SCHEMA.COL.MEDICAMENTO        - 1] = String(doc.medicamento  || '').trim();
  linha[SCHEMA.COL.LOTE               - 1] = String(doc.lote != null && doc.lote !== '' ? doc.lote : (doc.loteLaboratorio || '')).trim();
  linha[SCHEMA.COL.LABORATORIO        - 1] = String(doc.laboratorio  || '').trim();
  linha[SCHEMA.COL.RELATO_NOTIFICADOR - 1] = String(doc.relatoNotificador  || '').trim();
  linha[SCHEMA.COL.CONDUTA_NOTIFICADOR- 1] = String(doc.condutaNotificador || '').trim();
  linha[SCHEMA.COL.STATUS             - 1] = String(doc.status        || '').trim();
  linha[SCHEMA.COL.SLA                - 1] = String(doc.sla           || '').trim();
  linha[SCHEMA.COL.MOTIVO_DESCARTE    - 1] = String(doc.motivoDescarte|| '').trim();
  linha[SCHEMA.COL.HISTORIA           - 1] = String(doc.historiaClinica||'').trim();
  linha[SCHEMA.COL.RELATO             - 1] = String(doc.relato        || '').trim();
  linha[SCHEMA.COL.EXAMES             - 1] = String(doc.exames        || '').trim();
  linha[SCHEMA.COL.READMINISTRADO     - 1] = String(doc.readministrado|| '').trim();
  linha[SCHEMA.COL.EVOLUCAO           - 1] = String(doc.evolucao      || '').trim();
  linha[SCHEMA.COL.DESFECHO           - 1] = String(doc.desfecho      || '').trim();
  linha[SCHEMA.COL.CONCLUSAO          - 1] = String(doc.conclusao     || '').trim();
  linha[SCHEMA.COL.NARANJO            - 1] = String(doc.naranjo       || '').trim();
  linha[SCHEMA.COL.GRAVIDADE          - 1] = String(doc.gravidade     || '').trim();
  linha[SCHEMA.COL.FARMACEUTICO       - 1] = String(doc.farmaceutico  || '').trim();
  linha[SCHEMA.COL.NUM_VIGIMED        - 1] = String(doc.numVigimed    || '').trim();
  linha[SCHEMA.COL.DATA_VIGIMED       - 1] = fmtDataVigi(doc.dataVigimed);
  linha[SCHEMA.COL.OBSERVACOES        - 1] = String(doc.observacoes   || '').trim();
  linha[SCHEMA.COL.NARANJO_RESP       - 1] = String(doc.naranjoRespostas || '').trim();
  linha[SCHEMA.COL.ATUALIZADO_POR     - 1] = String(doc.auditoria && doc.auditoria.atualizadoPor || '').trim();
  linha[SCHEMA.COL.ATUALIZADO_EM      - 1] = fmtData(doc.auditoria && doc.auditoria.atualizadoEm);
  linha[SCHEMA.COL.NOTIF_EMAIL        - 1] = String(notif.email || '').trim();
// ── Fase 8 / Exportação E2B(R3) ────────────────────────────────────────
  linha[SCHEMA.COL.REACAO_TERMO       - 1] = String(doc.reacaoTermo       || '').trim();
  linha[SCHEMA.COL.DOSE_MEDICAMENTO   - 1] = String(doc.doseMedicamento   || '').trim();
  linha[SCHEMA.COL.DOSE_UNIDADE       - 1] = String(doc.doseUnidade       || '').trim();
  linha[SCHEMA.COL.VIA_ADMINISTRACAO  - 1] = String(doc.viaAdministracao  || '').trim();
  linha[SCHEMA.COL.DATA_INICIO_REACAO - 1] = fmtData(doc.dataInicioReacao);
  linha[SCHEMA.COL.DATA_INICIO_ADM    - 1] = fmtDataVigi(doc.dataInicioAdministracao);
  linha[SCHEMA.COL.ID_REACAO_E2B      - 1] = String(doc.idReacaoE2B       || '').trim();
  linha[SCHEMA.COL.ID_MEDICAMENTO_E2B - 1] = String(doc.idMedicamentoE2B  || '').trim();
  linha[SCHEMA.COL.SAFETYREPORTID_E2B - 1] = String(doc.safetyReportIdE2B || '').trim();
  // ── Dashboard de Produtividade (revisão 07/2026) ─────────────────────────
  linha[SCHEMA.COL.DATA_TRIAGEM       - 1] = fmtData(doc.dataTriagem);
  if (operacao === 'INSERT') {
    aba.appendRow(linha);
    return;
  }

  // UPDATE — localiza linha existente por ID via TextFinder (O(1) com índice)
  const finder = aba.createTextFinder(idCaso)
    .matchEntireCell(true)
    .matchCase(false);
  const resultado = finder.findNext();

  if (resultado) {
    const numLinha = resultado.getRow();
    aba.getRange(numLinha, 1, 1, SCHEMA.LARGURA).setValues([linha]);
  } else {
    // Caso não existe no Sheets ainda (ex: migrado do Firestore sem espelho)
    // — insere como novo ao invés de perder a atualização.
    console.warn('Mirror: ID ' + idCaso + ' não encontrado no Sheets — inserindo como novo.');
    aba.appendRow(linha);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GRAVAÇÃO NO SHEETS — LOG
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IMPORTANTE: já deve ser chamada de dentro de comTrava_() pelo caller
 * (espelharLogNoSheets_ / processarFilaEspelho) — esta função não trava
 * sozinha para evitar lock aninhado.
 */
function _gravarLogNoSheets(payload) {
  const aba = getSheet_(SCHEMA.ABAS.LOG);
  if (!aba) {
    // DB_Log é opcional — se não existir, não falha nem enfileira
    console.warn('Mirror: aba ' + SCHEMA.ABAS.LOG + ' não existe — log não espelhado.');
    return;
  }

  const tz = Session.getScriptTimeZone();
  const dataStr = payload.data instanceof Date
    ? Utilities.formatDate(payload.data, tz, 'dd/MM/yyyy HH:mm:ss')
    : String(payload.data || new Date()).trim();

  aba.appendRow([
    dataStr,
    String(payload.usuario || '').trim(),
    String(payload.acao    || '').trim(),
    String(payload.idCaso  || '').trim(),
    String(payload.detalhe || '').trim()
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// FILA DE RETRY (PropertiesService)
// ─────────────────────────────────────────────────────────────────────────────

function _enfileirarRetry(item) {
  try {
    // [RETIFICADO — Regra de Ouro #2] o read-modify-write da fila em
    // PropertiesService era feito SEM trava: dois enfileiramentos simultâneos
    // (22 usuários + ETL) liam a mesma fila e o último setProperty vencia,
    // PERDENDO silenciosamente o item do outro. Idem entre _enfileirarRetry
    // e processarFilaEspelho. Agora toda mutação da fila é atômica sob
    // comTrava_ (LockService).
    // ATENÇÃO: _enfileirarRetry só é chamado FORA de um lock ativo
    // (nos catch de espelhar* — o comTrava_ interno já liberou no finally —
    // e no pós-processamento da fila). Não chamar de dentro de comTrava_:
    // LockService não é reentrante.
    comTrava_(function () {
      const props = PropertiesService.getScriptProperties();
      const raw   = props.getProperty(MIRROR_RETRY_KEY);
      const fila  = raw ? JSON.parse(raw) : [];

      if (fila.length >= MIRROR_FILA_MAX_ITENS) {
        console.error('Mirror: fila de retry cheia (' + MIRROR_FILA_MAX_ITENS + ' itens). Item descartado: ' + JSON.stringify(item));
        return;
      }

      fila.push(item);
      const serializado = JSON.stringify(fila);

      // PropertiesService: limite de 9 KB por valor
      if (serializado.length > 9000) {
        console.error('Mirror: fila excede 9 KB após adicionar item. Item descartado: ' + JSON.stringify(item));
        return;
      }

      props.setProperty(MIRROR_RETRY_KEY, serializado);
    });
  } catch (e) {
    console.error('Mirror: falha ao enfileirar retry: ' + e.message + ' | Item: ' + JSON.stringify(item));
  }
}

/**
 * Processa a fila de retry — chamado pelo trigger a cada 5 minutos.
 * Tenta reprocessar cada item; após MIRROR_RETRY_MAX falhas, descarta e
 * alerta a coordenação por e-mail.
 * Itens bem-sucedidos são removidos da fila.
 */
function processarFilaEspelho() {
  const props = PropertiesService.getScriptProperties();

  // [RETIFICADO] SNAPSHOT atômico: lê E ZERA a fila sob trava. A versão
  // anterior lia a fila, processava por minutos e regravava filaRestante no
  // final — qualquer item enfileirado nesse intervalo era SOBRESCRITO e
  // perdido. Agora: itens novos durante o processamento entram numa fila
  // limpa (via _enfileirarRetry, também sob trava) e itens que falharem aqui
  // são re-enfileirados por _enfileirarRetry (merge atômico), nunca por
  // setProperty cego.
  let fila = null;
  comTrava_(function () {
    const raw = props.getProperty(MIRROR_RETRY_KEY);
    if (!raw) return;
    try { fila = JSON.parse(raw); } catch (e) {
      console.error('Mirror: fila corrompida — limpando. Erro: ' + e.message);
    }
    props.deleteProperty(MIRROR_RETRY_KEY);
  });

  if (!fila || !fila.length) return;

  const filaRestante = [];

  fila.forEach(function (item) {
    try {
      if (item.tipo === 'CASO') {
        // Relê do Firestore para garantir estado atual (pode ter mudado desde o enfileiramento)
        const doc = fsGetDoc_(SCHEMA.FS.CASOS, item.idCaso);
        if (!doc) throw new Error('Caso não encontrado no Firestore: ' + item.idCaso);
        // [RETIFICADO] gravação sob comTrava_
        comTrava_(function () {
          _gravarCasoNoSheets(item.idCaso, doc, item.operacao || 'UPDATE');
        });
        console.log('Mirror retry OK: CASO ' + item.idCaso);

      } else if (item.tipo === 'LOG') {
        // [RETIFICADO] gravação sob comTrava_
        comTrava_(function () {
          _gravarLogNoSheets(item.payload);
        });
        console.log('Mirror retry OK: LOG ' + (item.payload && item.payload.acao));

      } else {
        console.warn('Mirror: tipo de item desconhecido na fila — descartado: ' + JSON.stringify(item));
        return; // descarta sem recolocar
      }

    } catch (e) {
      item.tentativas = (item.tentativas || 0) + 1;
      if (item.tentativas >= MIRROR_RETRY_MAX) {
        console.error('Mirror: item descartado após ' + MIRROR_RETRY_MAX + ' tentativas: ' + JSON.stringify(item) + ' | Erro: ' + e.message);
        _alertarDescarteFinal_(item, e.message);
      } else {
        console.warn('Mirror retry falhou (tentativa ' + item.tentativas + '/' + MIRROR_RETRY_MAX + '): ' + e.message);
        filaRestante.push(item);
      }
    }
  });

  // Re-enfileira as falhas via _enfileirarRetry (merge atômico com itens
  // que possam ter chegado durante o processamento) — nunca setProperty cego.
  filaRestante.forEach(function (item) { _enfileirarRetry(item); });
}

/**
 * [NOVO — RETIFICAÇÃO Visibilidade] Alerta por e-mail quando um item é
 * descartado definitivamente da fila de retry. Sem isso a falha do espelho
 * era 100% silenciosa (só console.error, que ninguém consulta).
 * Falha ao enviar o e-mail não deve derrubar o processamento da fila —
 * por isso tem try/catch próprio.
 */
function _alertarDescarteFinal_(item, mensagemErro) {
  try {
    const cfg = getConfig();
    const destino = (cfg.geral && cfg.geral.EMAIL_COORDENACAO) || 'farmacia.clinica@hospital.com';
    const idRef = item.idCaso || (item.payload && item.payload.idCaso) || '-';

    MailApp.sendEmail({
      to: destino,
      subject: '[VigiRAM] Falha permanente no espelho Sheets (' + item.tipo + ')',
      body:
        'Um item foi descartado da fila de retry do Mirror após ' + MIRROR_RETRY_MAX + ' tentativas.\n\n' +
        'Tipo: ' + item.tipo + '\n' +
        'ID do caso: ' + idRef + '\n' +
        'Erro: ' + mensagemErro + '\n\n' +
        'Ação recomendada: verificar manualmente se o caso está correto no Firestore ' +
        'e, se necessário, rodar sincronizarTodosOsCasosParaSheets(false) para reconciliar.'
    });
  } catch (e) {
    console.error('Mirror: falha ao enviar alerta de descarte final: ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INSTALAÇÃO DO TRIGGER (rodar UMA VEZ no editor)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Instala o trigger que roda processarFilaEspelho() a cada 5 minutos.
 * Rode manualmente no editor do Apps Script: selecione esta função → Executar.
 * Idempotente: não cria duplicatas se já existir.
 */
function instalarTriggerEspelho() {
  const existentes = ScriptApp.getProjectTriggers();
  const jaExiste = existentes.some(function (t) {
    return t.getHandlerFunction() === 'processarFilaEspelho';
  });

  if (jaExiste) {
    Logger.log('Trigger processarFilaEspelho já instalado — nenhuma ação necessária.');
    return;
  }

  ScriptApp.newTrigger('processarFilaEspelho')
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log('✅ Trigger instalado: processarFilaEspelho a cada 5 minutos.');
}

/** Remove o trigger (use para manutenção ou desativação do espelho). */
function removerTriggerEspelho() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'processarFilaEspelho'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('Trigger processarFilaEspelho removido.');
}

/**
 * [NOVO] Confirma se o trigger de retry está instalado — rode manualmente
 * no editor sempre que suspeitar que o espelho parou de reprocessar falhas.
 */
function verificarTriggerEspelho() {
  const instalado = ScriptApp.getProjectTriggers()
    .some(function (t) { return t.getHandlerFunction() === 'processarFilaEspelho'; });
  Logger.log(instalado
    ? '✅ Trigger processarFilaEspelho está instalado.'
    : '⚠️ Trigger processarFilaEspelho NÃO está instalado — rode instalarTriggerEspelho().');
  return instalado;
}

// ─────────────────────────────────────────────────────────────────────────────
// SINCRONIZAÇÃO INICIAL (migração retroativa)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sincroniza TODOS os casos do Firestore para o Sheets de uma vez.
 * Use após instalar o Mirror para sincronizar o histórico existente.
 * Seguro de rodar múltiplas vezes — usa UPDATE (TextFinder) que sobrescreve
 * ou insere se não existir.
 *
 * @param {boolean} dryRun — true: só loga, não grava (padrão: true)
 */
function sincronizarTodosOsCasosParaSheets(dryRun) {
  const modo = (dryRun !== false);
  Logger.log('=== Sincronização Mirror: modo ' + (modo ? 'DRY-RUN' : 'APLICADO') + ' ===');

  const docs = fsListarTodos_(SCHEMA.FS.CASOS);
  Logger.log(docs.length + ' caso(s) encontrados no Firestore.');

  let ok = 0, erros = 0;

  docs.forEach(function (doc) {
    const id = doc.id || doc._id;
    if (!id) return;
    try {
      // [RETIFICADO] gravação sob comTrava_ também na sincronização em massa
      if (!modo) comTrava_(function () { _gravarCasoNoSheets(id, doc, 'UPDATE'); });
      ok++;
    } catch (e) {
      erros++;
      console.error('Sincronização: erro no caso ' + id + ': ' + e.message);
    }
  });

  Logger.log('Resultado: ' + ok + ' OK, ' + erros + ' erro(s).');
  if (modo) Logger.log('Dry-run concluído. Para aplicar, chame sincronizarTodosOsCasosParaSheets(false).');
  else Logger.log('Sincronização aplicada ao DB_Casos_RAM.');
}

/** Wrapper para execução manual no editor — DRY RUN (só loga, não grava) */
function sincronizarDryRun() {
  sincronizarTodosOsCasosParaSheets(true);
}

/** Wrapper para execução manual no editor — APLICA a sincronização no Sheets */
function sincronizarAplicado() {
  sincronizarTodosOsCasosParaSheets(false);
}
