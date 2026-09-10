/**
 * @fileoverview Ingest.gs — Camada de ingestão / ETL (Fase 4: Firestore).
 *
 * MIGRAÇÃO: handleInsertDB trocado de Sheets para Firestore (casos_ram).
 *
 * handleUploadRaw NÃO MUDA — grava arquivo bruto no Drive, nunca tocou
 * Sheets/Firestore.
 *
 * handleGetTriggers (Fase 9 — Firestore como Single Source of Truth):
 * agora lê EXCLUSIVAMENTE da coleção Firestore SCHEMA.FS.GATILHOS — não
 * toca mais em DB_Antidotos (Sheets). Essa é a única rota GET pública
 * consumida pelo robô PowerShell a cada execução do pipeline, então uma
 * falha momentânea do Firestore não pode parar a operação crítica do
 * hospital: envolvida em try/catch, com um array HARDCODED de fallback
 * (ver _GATILHOS_FALLBACK_HARDCODED) usado só quando o Firestore falha.
 *
 * SETORES DESATIVADOS: handleInsertDB descarta, na entrada, os casos cujo
 * `unidade_setor` pertence a um setor marcado como inativo no painel admin
 * (Setores → coluna "Varredura"). O robô PowerShell continua varrendo e
 * enviando tudo — o corte é aqui, do lado do GAS, para não exigir uma versão
 * nova do script na máquina do hospital a cada mudança de configuração. Os
 * descartes voltam na resposta em `detalhes` (motivo SETOR_DESATIVADO), que o
 * robô já grava no CSV mensal de auditoria sem precisar de alteração.
 *
 * DEDUPLICAÇÃO: a versão Sheets lia toda a planilha pra montar um Set de
 * IDs existentes antes de inserir (O(n) de leitura). Na versão Firestore,
 * cada caso é verificado individualmente via fsGetDoc_ (lookup O(1) por
 * ID de documento) — mais rápido e sem precisar carregar a base inteira
 * na memória do GAS a cada execução do ETL.
 *
 * AJUSTE E2B (D.5 Sexo): handleInsertDB agora lê caso.sexo do payload do
 * ETL (SCHEMA.COL.SEXO / casos_ram.sexo). O robô PowerShell PRECISA passar
 * a chave "sexo" no JSON de insertDB — confirme o nome exato da coluna no
 * relatório de entradas bruto antes de alterar o lado PowerShell. Sem essa
 * chave, o campo grava vazio e E2B.gs cai no fallback nullFlavor="UNK".
 *
 * CONCORRÊNCIA: como cada inserção usa fsSetDoc_ com ID determinístico
 * (o id_caso vindo do ETL), duas chamadas concorrentes para o MESMO id_caso
 * resultam em upsert idempotente — não há duplicação mesmo sem lock
 * explícito. Isso é uma propriedade mais forte que o comTrava_ original,
 * que serializava TODA escrita (mesmo de casos diferentes).
 */

/**
 * Salva arquivo bruto no Google Drive (Camada Bronze). INALTERADO.
 */
function handleUploadRaw(e) {
  const folderId = e.parameter.folderId;
  const fileName = e.parameter.fileName;

  if (!folderId || !fileName) {
    return createJsonResponse({ status: 'erro', mensagem: 'folderId/fileName ausente.' });
  }
  validarFolderPermitido_(folderId); // Security.gs — lança se não autorizado

  const fileContent = Utilities.base64Decode(e.postData.contents);
  const folder = DriveApp.getFolderById(folderId);
  const blob = Utilities.newBlob(fileContent, MimeType.CSV, fileName);
  folder.createFile(blob);

  return createJsonResponse({ status: 'sucesso', mensagem: `Backup salvo no Drive: ${fileName}` });
}

/**
 * Insere múltiplos casos estruturados na base (Camada Ouro).
 * Anti-duplicação por id_caso (lookup individual no Firestore) e alertas
 * por setor (Notify.gs, inalterado).
 *
 * DEDUP POR PRONTUÁRIO+GATILHO (não mais por dia — ver ETL v3.2): o robô
 * PowerShell manda id_caso = "VIGI-{prontuario}-{gatilho}", estável enquanto
 * o mesmo antídoto continuar sendo dispensado pro mesmo paciente. Isso já
 * elimina caso novo por dia (ver comentário no loop abaixo).
 *
 * JANELA DE REABERTURA (15 dias): se o gatilho disparar de novo para o
 * MESMO prontuário+medicamento depois que o caso anterior já foi ENCERRADO
 * (CONCLUÍDO/DESCARTADO) há mais de 15 dias, trata como um episódio novo
 * (ex.: reinternação) — o caso antigo é ARQUIVADO sob um id separado (cópia
 * integral, nunca é sobrescrito) e o id_caso limpo volta a ficar disponível
 * para um caso novo do zero. Casos ainda ABERTOS (pendente triagem/em
 * investigação) nunca são duplicados, não importa a idade — reabrir um
 * trabalho que já está em andamento não ajuda o farmacêutico.
 */
const JANELA_REABERTURA_DIAS = 15;

function handleInsertDB(e) {
  try {
    const dados = JSON.parse(e.postData.contents);

    // Casos novos (após dedup) são ACUMULADOS e gravados EM LOTE no fim: um
    // único :commit no Firestore (fsBatchSet_), em vez de um PATCH por caso.
    // O espelho no Sheets (espelharCasosEmLote_) só enfileira — quem grava de
    // fato é o trigger de 5 min (processarFilaEspelho, Mirror.gs), fora do
    // caminho de resposta ao robô.
    const paraInserir = [];               // [{ id, objeto }]
    const novosCasosPorSetor = {};
    const agora = new Date();
    const JANELA_REABERTURA_MS = JANELA_REABERTURA_DIAS * 24 * 60 * 60 * 1000;

    // Setores desativados no painel admin não devem gerar caso, mesmo que o
    // robô tenha varrido a dispensação. Lido UMA vez por lote (não por caso):
    // o ETL manda dezenas de casos por ciclo e isso é 1 leitura do Firestore.
    const setoresInativos = _setoresInativosMapa_();
    const mapaSinonimos   = _mapaSinonimosSetores_();
    const descartadosPorSetor = {};
    const bloqueadosPorExclusao = [];

    dados.forEach(function (caso) {
      const idLimpo = String(caso.id_caso).trim();

      // 1. SETOR CANÔNICO: normaliza zeros ("POSTO 01" -> "POSTO 1"), abreviações,
      // sinônimos e similaridade para garantir que o setor já entre 100% padronizado.
      const setorCanonico = _resolverSetorCanonico_(caso.unidade_setor, mapaSinonimos);
      const chaveSetor = _normalizarSetorComparacao_(setorCanonico);

      // Descarte por setor desativado ANTES do lookup de dedup — não faz
      // sentido gastar uma leitura do Firestore por caso que já vai fora.
      if (setoresInativos[chaveSetor]) {
        const nome = setoresInativos[chaveSetor];
        descartadosPorSetor[nome] = (descartadosPorSetor[nome] || 0) + 1;
        return;
      }

      // 2. MEDICAMENTO: preserva a nomenclatura original exata sem limpeza
      const medPrescrito = String(caso.medicamento_suspeito || caso.medicamento || caso.gatilho || '').trim();

      // 3. DEMAIS DADOS NORMALIZADOS: iniciais padrão com pontos e sexo M/F
      const iniciaisNorm = _normalizarIniciaisPaciente_(caso.iniciais_paciente);
      const sexoNorm     = _normalizarSexo_(caso.sexo);
      const prontuario   = String(caso.prontuario || '').trim();

      // Anti-duplicação: lookup direto O(1), não precisa carregar a base inteira.
      const existente = fsGetDoc_(SCHEMA.FS.CASOS, idLimpo);

      // Caso apagado de propósito pelo admin (excluirCaso, Cases.gs) não pode
      // voltar. A dedup acima é por EXISTÊNCIA do documento — apagar o caso o
      // torna "novo" de novo, e o robô o recriaria no ciclo seguinte. A lápide
      // em casos_excluidos é o que segura. Consultada só quando NÃO existe
      // caso (ou seja, no exato momento em que iríamos inserir): 1 leitura a
      // mais apenas para os ids realmente novos, nada no caminho comum.
      if (!existente) {
        const lapide = fsGetDoc_(SCHEMA.FS.CASOS_EXCLUIDOS, idLimpo);
        if (lapide) {
          bloqueadosPorExclusao.push(idLimpo);
          return;
        }
      }

      if (existente) {
        const terminal = existente.status === SCHEMA.STATUS.CONCLUIDO ||
                          existente.status === SCHEMA.STATUS.DESCARTADO;
        if (!terminal) return; // ainda em aberto — não duplica, não reabre

        const criadoEm = existente.criadoEm ? new Date(existente.criadoEm) : null;
        const dentroDaJanela = criadoEm && ((agora.getTime() - criadoEm.getTime()) <= JANELA_REABERTURA_MS);
        if (dentroDaJanela) return; // encerrado recentemente — mesmo contexto, não reabre

        // Passou a janela de 15 dias com o caso já encerrado: ARQUIVA o caso
        // antigo inteiro sob um id próprio (fsSetDoc_ é PATCH/upsert — nunca
        // perde dado) antes de liberar o id_caso limpo para o episódio novo.
        // NUNCA reaproveita o doc antigo diretamente: fsBatchSet_/fsSetDoc_
        // fazem overwrite por id, e sobrescrever destruiria a investigação/
        // E2B/VigiMed do caso anterior.
        const idArquivo = idLimpo + '-ARQ-' + Utilities.formatDate(criadoEm, Session.getScriptTimeZone(), 'yyyyMMddHHmmss');
        fsSetDoc_(SCHEMA.FS.CASOS, idArquivo, existente);
      }

      // CORREÇÃO (auditoria_qa_datas_tipagem_2026-07-13.md #5): grava `data`
      // como Date real sempre que o robô PowerShell mandar um formato
      // reconhecível (BR ou ISO — ver _parseDataFlexivel_, Utils.gs), em vez
      // da string bruta. Fallback para a string original se o formato não
      // for reconhecido: nunca bloqueia/descarta a inserção do ETL por causa
      // disso, só perde a formatação garantida nesse caso raro.
      const dataEventoBA = _parseDataFlexivel_(caso.data_evento) || caso.data_evento;
      const objetoCaso = {
        id: idLimpo,
        data: dataEventoBA,
        tipo: 'BA',
        prontuario: prontuario,
        iniciais: iniciaisNorm,
        nascimento: caso.data_nascimento || '',
        sexo: sexoNorm,
        setor: setorCanonico,
        medicamento: medPrescrito,
        medicamentoBruto: medPrescrito,
        doseMedicamento: caso.dose_medicamento || '',
        doseUnidade: caso.dose_unidade || '',
        status: SCHEMA.STATUS.TRIAGEM,
        sla: caso.prazo_sla || '48',
        motivoDescarte: '', historiaClinica: '', relato: '', exames: '',
        readministrado: '', evolucao: '', desfecho: '', conclusao: '',
        naranjo: '', gravidade: '', farmaceutico: '', numVigimed: '',
        dataVigimed: '', observacoes: '', naranjoRespostas: '',
        lote: '', laboratorio: '', relatoNotificador: '', condutaNotificador: '',
        notificador: { nome: '', categoria: '', email: '', dataNotificacao: '' },
        criadoEm: agora,
        auditoria: { atualizadoPor: 'ETL', atualizadoEm: agora }
      };

      paraInserir.push({ id: idLimpo, objeto: objetoCaso });

      const setor = String(setorCanonico).toUpperCase().trim();
      if (!novosCasosPorSetor[setor]) novosCasosPorSetor[setor] = [];
      novosCasosPorSetor[setor].push(caso);
    });

    const inseridos = paraInserir.length;

    if (inseridos > 0) {
      // 1) Firestore em lote (upsert idempotente por ID — retry do robô é seguro).
      fsBatchSet_(SCHEMA.FS.CASOS, paraInserir.map(function (x) {
        return { id: x.id, dados: x.objeto };
      }));

      // 2) Espelho no Sheets — só enfileira (nunca grava síncrono aqui, ver
      //    Mirror.gs). processarFilaEspelho (trigger 5 min) grava de fato.
      espelharCasosEmLote_(paraInserir);

      // Alerta imediato por inserção foi substituído pelo relatório diário
      // agregado (Notify.gs: enviarRelatorioDiarioGatilhos, trigger 07:00) —
      // evita e-mail a cada lote do robô, farmacêutico recebe 1 resumo/dia.

      // Regra de Ouro #3: escrita sem trilha. Um log por LOTE (não por caso,
      // para não multiplicar chamadas Firestore/Sheets do ETL).
      fsRegistrarLog_('ETL_INSERT_LOTE', 'N/A',
        inseridos + ' caso(s) BA inseridos | setores: ' + Object.keys(novosCasosPorSetor).join(', '));

      // P1.1: sem isto os casos novos do robô só apareciam no Kanban após o
      // TTL de 45s do cache expirar — invalida como toda escrita em casos_ram.
      invalidarCasosCache_();
    }

    // Trilha do que foi descartado por setor desativado. Sem isto o farmacêutico
    // veria "8 gatilhos viraram 0 casos" sem nenhuma explicação — exatamente a
    // falha silenciosa que a auditoria de dedup do ETL v3.4 veio resolver.
    const nomesDescartados = Object.keys(descartadosPorSetor);
    let totalDescartados = 0;
    nomesDescartados.forEach(function (n) { totalDescartados += descartadosPorSetor[n]; });

    if (totalDescartados > 0) {
      fsRegistrarLog_('ETL_DESCARTE_SETOR_INATIVO', 'N/A',
        totalDescartados + ' caso(s) descartados | ' +
        nomesDescartados.map(function (n) { return n + '=' + descartadosPorSetor[n]; }).join(', '));
    }

    if (bloqueadosPorExclusao.length > 0) {
      // Log em nível de LOTE. Recorrente por definição: enquanto a dispensação
      // continuar aparecendo no relatório do Pentaho, o robô reenvia esse id a
      // cada ciclo e a lápide o barra de novo. É o comportamento correto —
      // serve de prova de que a exclusão do admin segue valendo.
      fsRegistrarLog_('ETL_BLOQUEADO_POR_EXCLUSAO', 'N/A',
        bloqueadosPorExclusao.length + ' caso(s) nao recriados (excluidos pelo admin): ' +
        bloqueadosPorExclusao.join(', '));
    }

    // `detalhes` já é consumido pelo robô (Gravar-AuditoriaDedup, Pipeline_v3.ps1):
    // vira linha no CSV mensal de auditoria e sobe pra pasta do Drive sem
    // precisar de nenhuma alteração no lado PowerShell.
    const detalhes = nomesDescartados.map(function (n) {
      return {
        id:          'SETOR:' + n,
        motivo:      'SETOR_DESATIVADO',
        statusAtual: 'DESCARTADO',
        criadoEm:    '',
        diasDesde:   '',
        prontuario:  '',
        medicamento: '',
        setor:       n,
        quantidade:  descartadosPorSetor[n]
      };
    });

    return createJsonResponse({
      status:              'sucesso',
      inseridos:           inseridos,
      descartadosSetor:    totalDescartados,
      bloqueadosExclusao:  bloqueadosPorExclusao.length,
      detalhes:            detalhes
    });
  } catch (erro) {
    // Resposta montada ANTES do log best-effort — nunca atrasa/bloqueia o
    // retorno ao robô PowerShell.
    const resposta = createJsonResponse({ status: 'erro', mensagem: erro.message });
    try { fsRegistrarLog_('ERRO_INSERTDB', 'N/A', erro.message); } catch (e) { /* ignora */ }
    return resposta;
  }
}

/**
 * Fallback de ÚLTIMA INSTÂNCIA — usado SOMENTE quando o Firestore falha ao
 * responder handleGetTriggers(). Mantém o robô PowerShell operante (não gera
 * alertas de RAM para NENHUM medicamento seria pior que gerar com uma lista
 * desatualizada). Ajuste esta lista para refletir os medicamentos-gatilho
 * realmente monitorados pela farmácia — ela não é lida em nenhum outro lugar,
 * só existe para não parar o ETL em caso de indisponibilidade momentânea.
 */
const _GATILHOS_FALLBACK_HARDCODED = [
  'VANCOMICINA', 'GENTAMICINA', 'AMICACINA', 'DIGOXINA',
  'VARFARINA', 'INSULINA', 'HEPARINA', 'AMIODARONA'
];

/**
 * Retorna a lista de gatilhos (medicamentos monitorados) para o robô
 * PowerShell — Fase 9: Firestore é a ÚNICA fonte (coleção SCHEMA.FS.GATILHOS).
 * Se o Firestore falhar, cai no array hardcoded acima em vez de derrubar o
 * pipeline do robô.
 */
function handleGetTriggers() {
  try {
    const docs = fsListarTodos_(SCHEMA.FS.GATILHOS);
    const triggers = docs
      .filter(function (d) { return d.medicamento && d.ativo !== false; })
      .map(function (d) { return String(d.medicamento).trim(); })
      .sort();
    return createJsonResponse(triggers);
  } catch (erro) {
    console.error('handleGetTriggers: Firestore indisponível, usando fallback hardcoded — ' + erro.message);
    // Log best-effort — nunca deve impedir a resposta ao robô.
    try { fsRegistrarLog_('GATILHOS_FALLBACK_HARDCODED', 'N/A', erro.message); } catch (e) { /* ignora */ }
    return createJsonResponse(_GATILHOS_FALLBACK_HARDCODED);
  }
}
