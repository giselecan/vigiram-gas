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
 */
function handleInsertDB(e) {
  try {
    const dados = JSON.parse(e.postData.contents);

    // Casos novos (após dedup) são ACUMULADOS e gravados EM LOTE no fim: um
    // único :commit no Firestore (fsBatchSet_) e um único setValues no Sheets
    // (espelharCasosEmLote_), em vez de um PATCH + um appendRow-sob-lock por
    // caso. Um lote de 40 casos passa de ~80 round-trips de escrita + 40 ciclos
    // de lock para ~1 commit + 1 gravação em lote.
    const paraInserir = [];               // [{ id, objeto }]
    const novosCasosPorSetor = {};

    dados.forEach(function (caso) {
      const idLimpo = String(caso.id_caso).trim();

      // Anti-duplicação: lookup direto O(1), não precisa carregar a base inteira.
      const existente = fsGetDoc_(SCHEMA.FS.CASOS, idLimpo);
      if (existente) return;

      const agora = new Date();
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
        prontuario: caso.prontuario,
        iniciais: caso.iniciais_paciente,
        nascimento: caso.data_nascimento,
        sexo: caso.sexo || '',
        setor: caso.unidade_setor,
        medicamento: caso.medicamento_suspeito,
        status: SCHEMA.STATUS.TRIAGEM,
        sla: caso.prazo_sla,
        motivoDescarte: '', historiaClinica: '', relato: '', exames: '',
        readministrado: '', evolucao: '', desfecho: '', conclusao: '',
        naranjo: '', gravidade: '', farmaceutico: '', numVigimed: '',
        dataVigimed: '', observacoes: '', naranjoRespostas: '',
        lote: '', laboratorio: '', relatoNotificador: '', condutaNotificador: '',
        notificador: { nome: '', categoria: '', email: '', dataNotificacao: '' },
        auditoria: { atualizadoPor: 'ETL', atualizadoEm: agora }
      };

      paraInserir.push({ id: idLimpo, objeto: objetoCaso });

      const setor = String(caso.unidade_setor).toUpperCase().trim();
      if (!novosCasosPorSetor[setor]) novosCasosPorSetor[setor] = [];
      novosCasosPorSetor[setor].push(caso);
    });

    const inseridos = paraInserir.length;

    if (inseridos > 0) {
      // 1) Firestore em lote (upsert idempotente por ID — retry do robô é seguro).
      fsBatchSet_(SCHEMA.FS.CASOS, paraInserir.map(function (x) {
        return { id: x.id, dados: x.objeto };
      }));

      // 2) Espelho no Sheets em lote (objetos já em memória — sem reler o
      //    Firestore). Se falhar, cada caso cai na fila de retry
      //    (processarFilaEspelho, trigger 5 min), sem bloquear a resposta.
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

    return createJsonResponse({ status: 'sucesso', inseridos: inseridos });
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
