/**
 * @fileoverview Mirror.gs — Backup append-only Firestore → Google Sheets (auditoria LGPD).
 *
 * FASE 9 — ARQUITETURA "FIRESTORE COMO SINGLE SOURCE OF TRUTH":
 *   O Sheets deixou de ser um espelho vivo/bidirecional do Firestore. Ele é
 *   agora um repositório SOMENTE-INSERÇÃO (append-only): toda gravação aqui é
 *   um appendRow — NUNCA um UPDATE/overwrite de linha existente. O antigo
 *   modo "UPDATE via TextFinder" (localizar linha pelo ID e sobrescrevê-la)
 *   foi REMOVIDO: ele fazia o Sheets se comportar como uma segunda fonte da
 *   verdade sincronizada bidirecionalmente, o que a nova diretriz proíbe.
 *   Cada linha gravada em DB_Casos_RAM é um "carimbo" histórico imutável de
 *   um momento do caso (criação ou fechamento) — o mesmo ID pode aparecer em
 *   mais de uma linha ao longo do tempo, e isso é esperado (é um log, não uma
 *   tabela editável). O ESTADO ATUAL de qualquer caso só existe no Firestore.
 *
 * OBJETIVO: manter um livro-razão auditável/backup histórico no Sheets sem
 * depender de acesso ao console do Firebase, e sem que nenhuma função do
 * sistema volte a LER esse livro-razão para decidir comportamento.
 *
 * ARQUITETURA (revisão PERF — fila SEMPRE, nunca gravação síncrona):
 *   1. Pontos de escrita que representam um EVENTO DE AUDITORIA (caso novo
 *      entrando no sistema, ou investigação FINALIZADA) chamam
 *      espelharCasoNoSheets_() logo após a escrita no Firestore.
 *   2. fsRegistrarLog_ chama espelharLogNoSheets_() após gravar no Firestore
 *      — todo evento (erro, login, disparo do robô PowerShell, ação admin)
 *      vira uma linha em DB_Log/"Logs_Auditoria".
 *   3. Nenhuma das duas grava no Sheets na hora — SEMPRE serializam o item em
 *      PropertiesService (fila MIRROR_RETRY_QUEUE) — máx. 50 itens / 9 KB —
 *      e retornam imediatamente. Isso tira o appendRow (I/O do Sheets) E o
 *      comTrava_() (LockService.getScriptLock(), que é do SCRIPT INTEIRO, não
 *      por documento) do caminho de resposta de toda escrita do sistema —
 *      antes, com 22 usuários + robô concorrentes, cada login/triagem/
 *      investigação ficava presa atrás dessa mesma trava global.
 *   4. O trigger processarFilaEspelho() roda a cada 5 minutos, é o ÚNICO
 *      lugar que efetivamente grava no Sheets (sob comTrava_, ok travar ali:
 *      não há usuário esperando essa execução), reprocessa em ordem FIFO com
 *      até 3 tentativas por item. Itens de caso são relidos do Firestore na
 *      hora de gravar (o item só guarda o ID) — garante que o backup reflita
 *      o estado mais atual, não uma foto de minutos atrás. Após 3 falhas o
 *      item é descartado, registrado em console.error e um alerta é enviado
 *      por e-mail à coordenação (ver RETIFICAÇÃO abaixo).
 *
 * INTEGRAÇÃO — pontos de chamada em Cases.gs / Firestore.gs / Ingest.gs:
 *
 *   salvarDemandaEspontanea() / handleInsertDB():
 *     após fsSetDoc_(SCHEMA.FS.CASOS, idCaso, objetoCaso) — caso NOVO entrando
 *     → espelharCasoNoSheets_(idCaso, 'CRIACAO')
 *
 *   registrarInvestigacao() — SOMENTE quando dados.encerrar finaliza o caso:
 *     após fsRunTransaction_() bem-sucedido
 *     → espelharCasoNoSheets_(dados.idCaso, 'FECHAMENTO')
 *     (rascunhos de triagem/investigação NÃO tocam mais o Sheets — só o
 *     Firestore, que é a fonte única durante o trabalho em andamento)
 *
 *   Firestore.gs (fsRegistrarLog_):
 *     após fsSetDoc_() do log
 *     → espelharLogNoSheets_(payload do log)
 *
 * CONFIGURAÇÃO DO TRIGGER:
 *   Rode instalarTriggerEspelho() UMA VEZ no editor do Apps Script.
 *   Para remover: removerTriggerEspelho().
 *   VERIFICAÇÃO: rode verificarTriggerEspelho() a qualquer momento para
 *   confirmar se o trigger está instalado — agora é o ÚNICO caminho que
 *   grava no Sheets, então sem ele o Sheets simplesmente para de receber
 *   linhas novas (a fila só cresce, silenciosamente, até o limite de itens).
 *
 * CONSTRAINT PropertiesService:
 *   Cada valor: máx 9 KB. A fila serializa um array JSON.
 *   Se o payload de um caso ultrapassar 9 KB (improvável para este schema),
 *   o item é descartado imediatamente com console.error.
 *
 * RETIFICAÇÃO [Regra de Ouro #2 — Concorrência]:
 *   _gravarCasoNoSheets/_gravarLogNoSheets gravavam DIRETO no Sheets sem
 *   passar por comTrava_(). Com 22 usuários + robô PowerShell escrevendo
 *   simultâneo, dois appendRow concorrentes podiam duplicar/perder linha.
 *   Agora só processarFilaEspelho grava de fato, sempre sob comTrava_().
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
 * Enfileira o backup/auditoria (appendRow) de um caso em DB_Casos_RAM para o
 * trigger de 5 min (processarFilaEspelho) gravar — NUNCA grava direto no
 * Sheets aqui. Chamado em dois momentos apenas: criação do caso (ETL/DE) e
 * FECHAMENTO da investigação (Cases.gs).
 *
 * PERF: gravar aqui de forma síncrona exigiria comTrava_() — um
 * LockService.getScriptLock() do SCRIPT INTEIRO (não por documento) — mais
 * um appendRow no Sheets, ambos na resposta ao usuário. Como o Sheets é só
 * backup append-only que nenhuma função do sistema volta a ler (ver
 * cabeçalho deste arquivo), alguns minutos de atraso não têm efeito
 * funcional algum, mas evitam serializar TODA escrita do sistema atrás dessa
 * gravação. O item guarda só o ID: processarFilaEspelho relê o Firestore na
 * hora de gravar, garantindo que o backup reflita o estado mais atual (não
 * uma foto tirada minutos antes).
 *
 * @param {string} idCaso
 * @param {'CRIACAO'|'FECHAMENTO'} motivo — só para rastreio/logs.
 */
function espelharCasoNoSheets_(idCaso, motivo) {
  try {
    _enfileirarRetry({ tipo: 'CASO', idCaso: idCaso, tentativas: 0 });
  } catch (e) {
    console.error('Mirror [espelharCasoNoSheets_] falhou ao enfileirar ' + idCaso + ' (' + motivo + '): ' + e.message);
  }
}

/**
 * Espelha VÁRIOS casos novos numa ÚNICA gravação em lote (um setValues sob um
 * único comTrava_), em vez de um appendRow por caso — cada appendRow é a
 * escrita mais lenta do Sheets e ainda pegava/soltava o lock por caso. Usado
 * pelo ETL (handleInsertDB). Semântica de falha idêntica à do caminho único:
 * se a gravação em lote falhar, cada caso volta para a fila de retry
 * (processarFilaEspelho relê o Firestore por ID), sem bloquear a resposta ao robô.
 * @param {Array<{id, objeto}>} itens
 */
function espelharCasosEmLote_(itens) {
  if (!itens || !itens.length) return;
  try {
    // Monta as linhas ANTES de pegar o lock — trabalho de CPU não precisa
    // segurar o LockService, que serializa todas as escritas do sistema.
    const linhas = itens.map(function (it) { return _construirLinhaCaso_(it.id, it.objeto); });

    comTrava_(function () {
      const aba = getSheet_(SCHEMA.ABAS.CASOS);
      if (!aba) throw new Error('Aba ' + SCHEMA.ABAS.CASOS + ' não encontrada.');
      const inicio = aba.getLastRow() + 1;
      aba.getRange(inicio, 1, linhas.length, SCHEMA.LARGURA).setValues(linhas);
    });
  } catch (e) {
    console.error('Mirror [espelharCasosEmLote_] falhou para ' + itens.length + ' caso(s): ' + e.message);
    itens.forEach(function (it) { _enfileirarRetry({ tipo: 'CASO', idCaso: it.id, tentativas: 0 }); });
  }
}

/**
 * Enfileira um evento de log para o Sheets — nunca grava síncrono aqui.
 * Chamado dentro de fsRegistrarLog_() após a escrita no Firestore.
 *
 * PERF: fsRegistrarLog_ roda ao final de PRATICAMENTE TODA escrita do
 * sistema (login, triagem, investigação, ações de admin...). Gravar aqui de
 * forma síncrona sob comTrava_() (lock global do script) serializava todas
 * essas escritas concorrentes atrás de um appendRow de auditoria que ninguém
 * volta a ler — daí este evento (como o de casos, ver espelharCasoNoSheets_)
 * só entrar na fila; quem grava de fato é processarFilaEspelho, a cada 5 min.
 *
 * @param {{ data, usuario, acao, idCaso, detalhe }} payload
 */
function espelharLogNoSheets_(payload) {
  try {
    _enfileirarRetry({ tipo: 'LOG', payload: payload, tentativas: 0 });
  } catch (e) {
    console.error('Mirror [espelharLogNoSheets_] falhou ao enfileirar: ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GRAVAÇÃO NO SHEETS — CASOS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grava uma linha NOVA em DB_Casos_RAM respeitando SCHEMA.COL.* — SEMPRE
 * appendRow, nunca sobrescreve uma linha existente (Sheets é append-only:
 * ver cabeçalho do arquivo). Cada chamada representa um carimbo histórico
 * (criação do caso ou fechamento da investigação), não o estado "atual".
 * IMPORTANTE: já deve ser chamada de dentro de comTrava_() pelo caller
 * (espelharCasoNoSheets_ / processarFilaEspelho) — esta função não trava
 * sozinha para evitar lock aninhado.
 */
function _gravarCasoNoSheets(idCaso, doc) {
  const aba = getSheet_(SCHEMA.ABAS.CASOS);
  if (!aba) throw new Error('Aba ' + SCHEMA.ABAS.CASOS + ' não encontrada.');
  aba.appendRow(_construirLinhaCaso_(idCaso, doc));
}

/**
 * Monta a linha posicional (SCHEMA.COL — 46 colunas) de um caso. Extraído de
 * _gravarCasoNoSheets para que a gravação EM LOTE do ETL (um único setValues,
 * ver espelharCasosEmLote_) reaproveite exatamente o mesmo mapeamento de
 * colunas usado no appendRow por caso (fechamento/retry).
 */
function _construirLinhaCaso_(idCaso, doc) {
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

  return linha;
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
  // Motivo do descarte por capacidade (fila cheia / >9KB), setado dentro do
  // comTrava_ e usado DEPOIS de liberar a trava para disparar o alerta por
  // e-mail (MailApp é chamada de rede — não deve rodar com o lock preso).
  let motivoDescarteCapacidade = null;
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
        motivoDescarteCapacidade = 'Fila de retry do Mirror cheia (' + MIRROR_FILA_MAX_ITENS + ' itens) — item descartado sem tentar novamente.';
        return;
      }

      fila.push(item);
      const serializado = JSON.stringify(fila);

      // PropertiesService: limite de 9 KB por valor
      if (serializado.length > 9000) {
        console.error('Mirror: fila excede 9 KB após adicionar item. Item descartado: ' + JSON.stringify(item));
        motivoDescarteCapacidade = 'Fila de retry do Mirror excedeu 9 KB — item descartado sem tentar novamente.';
        return;
      }

      props.setProperty(MIRROR_RETRY_KEY, serializado);
    });

    // Mesmo alerta por e-mail do caminho "3 tentativas esgotadas" (ver
    // processarFilaEspelho) — sem isso, um pico de falhas do Sheets que lota
    // a fila perdia itens (potencialmente casos de RAM não espelhados) de
    // forma visível só nos logs de execução, nunca na caixa de entrada.
    if (motivoDescarteCapacidade) {
      _alertarDescarteFinal_(item, motivoDescarteCapacidade);
    }
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
          _gravarCasoNoSheets(item.idCaso, doc);
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
    const cfg = getConfig_();
    const destino = (cfg.geral && cfg.geral.EMAIL_COORDENACAO) || 'farmacia.clinica@hospital.com';
    const idRef = item.idCaso || (item.payload && item.payload.idCaso) || '-';

    MailApp.sendEmail({
      to: destino,
      name: 'VigiRAM',
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
 * Exporta um SNAPSHOT append-only de TODOS os casos do Firestore para o
 * Sheets — uma linha nova por caso, no estado em que estiverem agora.
 *
 * FASE 9: NÃO é mais idempotente da forma antiga (o comportamento antigo
 * fazia UPDATE/overwrite via TextFinder; Sheets agora é append-only, então
 * esta função sempre ADICIONA linhas novas). Rodar duas vezes duplica um
 * carimbo de snapshot por caso — isso é aceitável para uma reconciliação
 * pontual (ex: preencher o histórico após instalar o Mirror pela primeira
 * vez), mas NÃO deve virar rotina automática/agendada.
 *
 * @param {boolean} dryRun — true: só loga, não grava (padrão: true)
 */
function sincronizarTodosOsCasosParaSheets(dryRun) {
  const modo = (dryRun !== false);
  Logger.log('=== Snapshot Mirror (append-only): modo ' + (modo ? 'DRY-RUN' : 'APLICADO') + ' ===');

  const docs = fsListarTodos_(SCHEMA.FS.CASOS);
  Logger.log(docs.length + ' caso(s) encontrados no Firestore.');

  let ok = 0, erros = 0;

  docs.forEach(function (doc) {
    const id = doc.id || doc._id;
    if (!id) return;
    try {
      // [RETIFICADO] gravação sob comTrava_ também no snapshot em massa
      if (!modo) comTrava_(function () { _gravarCasoNoSheets(id, doc); });
      ok++;
    } catch (e) {
      erros++;
      console.error('Snapshot Mirror: erro no caso ' + id + ': ' + e.message);
    }
  });

  Logger.log('Resultado: ' + ok + ' OK, ' + erros + ' erro(s).');
  if (modo) Logger.log('Dry-run concluído. Para aplicar, chame sincronizarTodosOsCasosParaSheets(false).');
  else Logger.log('Snapshot gravado (append) em DB_Casos_RAM.');
}

/** Wrapper para execução manual no editor — DRY RUN (só loga, não grava) */
function sincronizarDryRun() {
  sincronizarTodosOsCasosParaSheets(true);
}

/** Wrapper para execução manual no editor — APLICA a sincronização no Sheets */
function sincronizarAplicado() {
  sincronizarTodosOsCasosParaSheets(false);
}
