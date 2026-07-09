/**
 * @fileoverview Ingest.gs — Camada de ingestão / ETL (Fase 4: Firestore).
 *
 * MIGRAÇÃO: handleInsertDB trocado de Sheets para Firestore (casos_ram).
 *
 * handleUploadRaw NÃO MUDA — grava arquivo bruto no Drive, nunca tocou
 * Sheets/Firestore.
 *
 * handleGetTriggers NÃO MUDA — continua lendo DB_Antidotos do Sheets.
 * Essa aba (lista de medicamentos-gatilho) NÃO faz parte do escopo de
 * dados sensíveis/operacionais migrados (não tem PII de paciente, é
 * baixíssimo volume e baixa frequência de leitura pelo robô). Migrar
 * essa aba específica é opcional e de baixo risco — pode ser feito depois
 * se desejado, sem pressa.
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

    let inseridos = 0;
    const novosCasosPorSetor = {};

    dados.forEach(function (caso) {
      const idLimpo = String(caso.id_caso).trim();

      // Anti-duplicação: lookup direto O(1), não precisa carregar a base inteira.
      const existente = fsGetDoc_(SCHEMA.FS.CASOS, idLimpo);
      if (existente) return;

      const agora = new Date();
      const objetoCaso = {
        id: idLimpo,
        data: caso.data_evento,
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

      fsSetDoc_(SCHEMA.FS.CASOS, idLimpo, objetoCaso);

      // Espelho síncrono no Sheets — sem reler o Firestore (objeto já em memória)
      // Se falhar, vai para fila de retry (processarFilaEspelho, trigger 5 min)
      espelharCasoNoSheets_(idLimpo, objetoCaso, 'INSERT');

      inseridos++;

      const setor = String(caso.unidade_setor).toUpperCase().trim();
      if (!novosCasosPorSetor[setor]) novosCasosPorSetor[setor] = [];
      novosCasosPorSetor[setor].push(caso);
    });

    if (inseridos > 0) {
      enviarAlertasAgrupados(novosCasosPorSetor); // Notify.gs — inalterado

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
    return createJsonResponse({ status: 'erro', mensagem: erro.message });
  }
}

/**
 * Retorna a lista de gatilhos (DB_Antidotos) para o robô PowerShell.
 * INALTERADO — continua lendo do Sheets. Ver nota no cabeçalho do arquivo.
 */
function handleGetTriggers() {
  const plan = getSheet_(SCHEMA.ABAS.ANTIDOTOS);
  if (!plan) return createJsonResponse([]);
  const dados = plan.getDataRange().getValues();
  const triggers = [];
  for (let i = 1; i < dados.length; i++) {
    const medicamento = dados[i][0];
    const ativo = dados[i][3] != null ? dados[i][3] : true;
    if (medicamento && ativo) triggers.push(String(medicamento).trim());
  }
  return createJsonResponse(triggers);
}
