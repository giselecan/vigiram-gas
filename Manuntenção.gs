/**
 * @fileoverview Manutencao.gs — utilitários administrativos de uso pontual.
 * NÃO é chamado pelo frontend. Rodar manualmente pelo editor do Apps Script.
 *
 * limparCasosAntigos_dryRun_() — lista o que SERIA apagado, sem apagar nada.
 * limparCasosAntigos_(confirmar) — apaga de fato. Exige DUAS travas (ver abaixo).
 *
 * Critério: mantém casos_ram cujo data_evento é HOJE (fuso do script).
 * Todo o resto (Firestore + linha espelhada em DB_Casos_RAM) é removido.
 * log_auditoria NÃO é tocado — trilha LGPD/Vigimed preservada.
 *
 * zerarBaseCasosParaProducao_dryRun_() / zerarBaseCasosParaProducao_(confirmar)
 *   — reset ÚNICO pré go-live (ver bloco dedicado mais abaixo): apaga TODOS
 *   os casos de teste (casos_ram + DB_Casos_RAM), sem exceção de data.
 *   Mantém usuários, setores, listas, Naranjo, gatilhos, config_geral e
 *   log_auditoria intactos — o sistema continua utilizável no dia seguinte
 *   sem precisar reconfigurar nada.
 *
 * SEGURANÇA (crítico — este arquivo APAGA histórico regulatório):
 *   1) Todas as funções deste arquivo terminam em "_": sem o sufixo, ficariam
 *      expostas a google.script.run e um anônimo poderia chamar
 *      EXECUTAR_LIMPEZA_DE_FATO_() pela URL do Web App e zerar a base. O "_"
 *      as remove do google.script.run; continuam executáveis pelo editor.
 *   2) Trava de ambiente: a exclusão real só roda se a Script Property
 *      correspondente estiver = 'SIM'. Assim, um clique acidental no editor
 *      em produção falha em vez de apagar tudo. Para rodar de propósito:
 *      Configurações do projeto → Propriedades do script → adicione a
 *      propriedade, execute, e REMOVA a propriedade depois.
 */
const _PROP_PERMITIR_LIMPEZA = 'PERMITIR_LIMPEZA_MASSA';

function _hojeDDMMAAAA_() {
  const hoje = new Date();
  const dd = String(hoje.getDate()).padStart(2, '0');
  const mm = String(hoje.getMonth() + 1).padStart(2, '0');
  const aaaa = hoje.getFullYear();
  return `${dd}/${mm}/${aaaa}`;
}

function _casosForaDeHoje_() {
  const hojeStr = _hojeDDMMAAAA_();
  const todos = fsListarTodos_(SCHEMA.FS.CASOS);
  return todos.filter(c => {
    // CORREÇÃO CRÍTICA: no Firestore o campo chama-se `data` (ver objetoCaso em
    // Cases.gs/Ingest.gs). `data_evento` é apenas o nome MAPEADO para o frontend
    // (_mapearCasoResumo_). A versão anterior lia c.data_evento — sempre
    // undefined — logo TODO caso era classificado como "fora de hoje" e
    // limparCasosAntigos(true) apagaria 100% da base, inclusive os de hoje.
    // O campo pode ser Date (ETL/DE antigos) ou string 'dd/MM/yyyy HH:mm'.
    const bruto = c.data;
    const dataEvento = (bruto instanceof Date)
      ? Utilities.formatDate(bruto, Session.getScriptTimeZone(), 'dd/MM/yyyy')
      : String(bruto || '');
    return !dataEvento.startsWith(hojeStr);
  });
}

/** PASSO 1 — SEMPRE rodar isto primeiro. Só loga, não apaga nada. */
function limparCasosAntigos_dryRun_() {
  const foraDeHoje = _casosForaDeHoje_();
  Logger.log(`Hoje: ${_hojeDDMMAAAA_()}`);
  Logger.log(`Total em casos_ram: ${fsListarTodos_(SCHEMA.FS.CASOS).length}`);
  Logger.log(`Seriam apagados (fora de hoje): ${foraDeHoje.length}`);
  foraDeHoje.forEach(c => {
    Logger.log(`  - ${c._id} | ${c.data_evento} | ${c.prontuario} | ${c.status}`);
  });
  return foraDeHoje.length;
}

/**
 * PASSO 2 — apaga de fato. Precisa chamar com confirmar === true E ter a
 * Script Property PERMITIR_LIMPEZA_MASSA == 'SIM' (ver cabeçalho do arquivo).
 * Remove do Firestore (casos_ram) e a linha correspondente em DB_Casos_RAM
 * (planilha espelho), casando pelo ID_CASO (SCHEMA.COL.ID).
 */
function limparCasosAntigos_(confirmar) {
  const permitido = PropertiesService.getScriptProperties()
    .getProperty(_PROP_PERMITIR_LIMPEZA);
  if (String(permitido).toUpperCase() !== 'SIM') {
    throw new Error('Limpeza de base BLOQUEADA: defina a Script Property ' +
                    'PERMITIR_LIMPEZA_MASSA = SIM antes de executar (e remova-a depois). ' +
                    'Isto evita apagar o histórico regulatório por engano em produção.');
  }
  if (confirmar !== true) {
    throw new Error('Chame limparCasosAntigos_(true) explicitamente para confirmar a exclusão. ' +
                     'Rode limparCasosAntigos_dryRun_() antes para conferir o que será apagado.');
  }

  const foraDeHoje = _casosForaDeHoje_();
  const total = foraDeHoje.length;
  Logger.log(`Iniciando exclusão de ${total} casos (mantendo apenas data_evento = ${_hojeDDMMAAAA_()})`);

  const planilha = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SCHEMA.ABAS.CASOS);
  let apagados = 0;
  let falhas = 0;

  foraDeHoje.forEach(caso => {
    try {
      // 1. Apaga no Firestore
      fsDeleteDoc_(SCHEMA.FS.CASOS, caso._id);

      // 2. Apaga a linha espelho na planilha, se existir
      // CORREÇÃO: localizarLinhaCaso_ retorna -1 quando não encontra, e -1 é
      // truthy — a versão anterior chamava deleteRow(-1) e lançava exceção
      // (contava falha DEPOIS do doc Firestore já ter sido apagado).
      // Também sob comTrava_ (Regra de Ouro #2): deleteRow desloca índices e
      // pode colidir com o Mirror/ETL escrevendo na mesma aba.
      if (planilha) {
        comTrava_(function () {
          const linha = localizarLinhaCaso_(planilha, caso._id); // Utils.gs — TextFinder
          if (linha > 0) planilha.deleteRow(linha);
        });
      }

      apagados++;
    } catch (e) {
      falhas++;
      Logger.log(`FALHA ao apagar ${caso._id}: ${e.message}`);
    }
  });

  invalidarCasosCache_(); // P1.1 — cache do Kanban reflete a limpeza imediatamente

  // Log de auditoria da própria operação de limpeza (log_auditoria preservado)
  fsRegistrarLog_('LIMPEZA_MASSA', 'N/A',
    `Limpeza de base: ${apagados} casos removidos, ${falhas} falhas. Critério: data_evento != ${_hojeDDMMAAAA_()}`);

  Logger.log(`Concluído: ${apagados} apagados, ${falhas} falhas.`);
  return { apagados, falhas };
}

/** * PASSO 3 — Função auxiliar para disparar a limpeza pelo Editor.
 * Selecione esta função no menu superior e clique em Executar.
 */
function EXECUTAR_LIMPEZA_DE_FATO_() {
  // Passa o parâmetro "true" exigido pela trava de segurança
  limparCasosAntigos_(true);
}

// ═════════════════════════════════════════════════════════════════════════
// RESET ÚNICO PRÉ GO-LIVE — zera a base de CASOS de teste para começar a
// produção do zero. NÃO é o mesmo utilitário que limparCasosAntigos_ acima
// (aquele mantém "os de hoje"; este apaga TODOS, sem exceção de data).
//
// O QUE É APAGADO:
//   - Todos os documentos de casos_ram (Firestore).
//   - Todas as linhas de dados de DB_Casos_RAM (Sheets) — o cabeçalho
//     (linha 1) é preservado.
//
// O QUE **NÃO** É TOCADO (continua funcionando amanhã sem reconfigurar):
//   - usuarios (logins/senhas do painel).
//   - setores, listas, naranjo, gatilhos, config_geral (configuração
//     operacional).
//   - log_auditoria / DB_Log (trilha de auditoria — inclusive o registro
//     desta própria operação de reset, gravado ao final).
//
// SEGURANÇA — TRÊS travas (mais que limparCasosAntigos_ de propósito: aqui
// o raio de destruição é 100% da base de casos, não só "os antigos"):
//   1) Sufixo "_" no nome — nunca exposto a google.script.run.
//   2) Script Property PERMITIR_RESET_PRODUCAO == 'SIM' (própria, separada
//      de PERMITIR_LIMPEZA_MASSA — não reaproveita a trava da outra função
//      para não permitir que uma autorização deixada ligada por engano
//      libere as duas operações ao mesmo tempo).
//   3) confirmar precisa ser EXATAMENTE a string 'ZERAR-CASOS-PRODUCAO'
//      (não um boolean) — reduz o risco de disparo acidental por um `true`
//      copiado/colado de outro contexto.
//
// COMO USAR:
//   1. zerarBaseCasosParaProducao_dryRun_() — confira a contagem no log.
//   2. Configurações do projeto → Propriedades do script → adicione
//      PERMITIR_RESET_PRODUCAO = SIM.
//   3. Selecione EXECUTAR_ZERAR_BASE_PRODUCAO_ no editor → Executar.
//   4. REMOVA a Script Property PERMITIR_RESET_PRODUCAO logo depois.
//
// LIMITE DE EXECUÇÃO: o editor do Apps Script encerra a execução manual
// após ~6 minutos. Para uma base de teste muito grande (milhares de casos),
// a exclusão do Firestore (1 chamada por documento) pode não terminar numa
// única execução. É seguro simplesmente rodar EXECUTAR_ZERAR_BASE_PRODUCAO_
// de novo se isso acontecer: a lista de casos é relida do zero a cada
// chamada, então o que já foi apagado não é tocado de novo — só continua
// de onde parou.
// ═════════════════════════════════════════════════════════════════════════
const _PROP_PERMITIR_RESET_PRODUCAO = 'PERMITIR_RESET_PRODUCAO';
const _CONFIRMACAO_RESET_PRODUCAO   = 'ZERAR-CASOS-PRODUCAO';

/** PASSO 1 — SEMPRE rodar isto primeiro. Só loga, não apaga nada. */
function zerarBaseCasosParaProducao_dryRun_() {
  const casos = fsListarTodos_(SCHEMA.FS.CASOS);
  const planilha = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SCHEMA.ABAS.CASOS);
  const linhasSheet = planilha ? Math.max(0, planilha.getLastRow() - 1) : 0; // -1 = exclui cabeçalho

  Logger.log('=== DRY-RUN — zerarBaseCasosParaProducao ===');
  Logger.log(`Documentos em casos_ram (Firestore): ${casos.length}`);
  Logger.log(`Linhas de dados em DB_Casos_RAM (Sheets, exclui cabeçalho): ${linhasSheet}`);
  Logger.log('NÃO SERÃO tocados: usuarios, setores, listas, naranjo, gatilhos, config_geral, log_auditoria.');
  casos.forEach(c => {
    Logger.log(`  - ${c._id} | ${c.prontuario || ''} | ${c.setor || ''} | ${c.status || ''}`);
  });
  return { totalFirestore: casos.length, totalSheetLinhas: linhasSheet };
}

/**
 * PASSO 2 — apaga de fato TODOS os casos. Ver bloco de comentários acima
 * para as três travas exigidas antes de chamar esta função.
 * @param {string} confirmar — precisa ser exatamente 'ZERAR-CASOS-PRODUCAO'.
 */
function zerarBaseCasosParaProducao_(confirmar) {
  const permitido = PropertiesService.getScriptProperties()
    .getProperty(_PROP_PERMITIR_RESET_PRODUCAO);
  if (String(permitido).toUpperCase() !== 'SIM') {
    throw new Error('Reset de produção BLOQUEADO: defina a Script Property ' +
                     'PERMITIR_RESET_PRODUCAO = SIM antes de executar (e remova-a depois). ' +
                     'Isto evita zerar a base de casos por engano.');
  }
  if (confirmar !== _CONFIRMACAO_RESET_PRODUCAO) {
    throw new Error('Chame zerarBaseCasosParaProducao_("' + _CONFIRMACAO_RESET_PRODUCAO + '") ' +
                     'explicitamente para confirmar. Rode zerarBaseCasosParaProducao_dryRun_() ' +
                     'antes para conferir quantos casos serão apagados.');
  }

  const casos = fsListarTodos_(SCHEMA.FS.CASOS);
  const totalFirestore = casos.length;
  Logger.log(`Iniciando reset: apagando ${totalFirestore} caso(s) de casos_ram (Firestore)...`);

  let apagadosFirestore = 0, falhasFirestore = 0;
  casos.forEach(caso => {
    try {
      fsDeleteDoc_(SCHEMA.FS.CASOS, caso._id);
      apagadosFirestore++;
    } catch (e) {
      falhasFirestore++;
      Logger.log(`FALHA ao apagar ${caso._id} do Firestore: ${e.message}`);
    }
  });

  // Sheets: apaga as linhas de dados (2..última) numa tacada só, sob
  // comTrava_ (Regra de Ouro #2 — evita colisão com Mirror/ETL escrevendo
  // na mesma aba enquanto o reset roda). Cabeçalho (linha 1) preservado.
  let linhasApagadasSheet = 0;
  const planilha = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SCHEMA.ABAS.CASOS);
  if (planilha) {
    comTrava_(function () {
      const ultima = planilha.getLastRow();
      if (ultima > 1) {
        linhasApagadasSheet = ultima - 1;
        planilha.deleteRows(2, linhasApagadasSheet);
      }
    });
  }

  invalidarCasosCache_(); // P1.1 — Kanban precisa refletir a base zerada imediatamente

  // Log de auditoria da própria operação — log_auditoria é INTENCIONALMENTE
  // preservado pelo reset (ver cabeçalho do bloco), então este registro fica
  // como o marco divisório entre "dados de teste" e "produção real" a partir
  // de agora.
  fsRegistrarLog_('RESET_PRODUCAO', 'N/A',
    `Base de casos zerada para go-live: ${apagadosFirestore} caso(s) removido(s) do Firestore ` +
    `(${falhasFirestore} falha(s)), ${linhasApagadasSheet} linha(s) removida(s) do Sheets. ` +
    `Por: ${usuarioAtual_()}`);

  Logger.log(`Concluído: ${apagadosFirestore}/${totalFirestore} apagados do Firestore ` +
             `(${falhasFirestore} falha(s)), ${linhasApagadasSheet} linha(s) removida(s) do Sheets.`);
  return { apagadosFirestore, falhasFirestore, linhasApagadasSheet };
}

/**
 * PASSO 3 — Função auxiliar para disparar o reset pelo Editor.
 * Selecione esta função no menu superior e clique em Executar.
 * (Ainda exige a Script Property PERMITIR_RESET_PRODUCAO = SIM — ver acima.)
 */
function EXECUTAR_ZERAR_BASE_PRODUCAO_() {
  zerarBaseCasosParaProducao_(_CONFIRMACAO_RESET_PRODUCAO);
}

