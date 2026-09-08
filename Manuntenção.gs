/**
 * @fileoverview Manutencao.gs — utilitários administrativos de uso pontual.
 * NÃO é chamado pelo frontend. Rodar manualmente pelo editor do Apps Script.
 *
 * limparCasosAntigos_dryRun_() — lista o que SERIA apagado, sem apagar nada.
 * limparCasosAntigos_(confirmar) — apaga de fato. Exige DUAS travas (ver abaixo).
 *
 * limparGatilhosNaoTriadosAntigos_dryRun_(dataCorte) — lista gatilhos não triados
 *   anteriores à data limite (ex.: 01/09/2026), sem apagar nada.
 * limparGatilhosNaoTriadosAntigos_(confirmar, dataCorte) — apaga de fato os gatilhos
 *   não triados anteriores à data de corte (Firestore + Sheets + lápide CASOS_EXCLUIDOS).
 * EXECUTAR_DRY_RUN_GATILHOS_ANTERIORES_01_09_() — Dry-run de 01/09 para o editor.
 * EXECUTAR_LIMPEZA_GATILHOS_ANTERIORES_01_09_() — Exclusão real de 01/09 para o editor.
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

  const planilha = getSheet_(SCHEMA.ABAS.CASOS);
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
  const planilha = getSheet_(SCHEMA.ABAS.CASOS);
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
  const planilha = getSheet_(SCHEMA.ABAS.CASOS);
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

// ═════════════════════════════════════════════════════════════════════════
// LIMPEZA DE GATILHOS NÃO TRIADOS (Busca Ativa / ETL) ANTERIORES A UMA DATA
//
// O QUE É APAGADO:
//   - Casos em casos_ram (Firestore) cujo status seja 'PENDENTE TRIAGEM'
//     (SCHEMA.STATUS.TRIAGEM), com tipo != 'DE' (apenas gatilhos de Busca
//     Ativa / ETL), cuja data_evento (ou criadoEm) seja estritamente ANTERIOR
//     à data de corte (padrão: 01/09/2026).
//   - As linhas correspondentes em DB_Casos_RAM (Sheets).
//
// O QUE É PRESERVADO:
//   - Todos os casos que já passaram por triagem (EM INVESTIGAÇÃO, DESCARTADO,
//     CONCLUÍDO), mesmo que anteriores a 01/09.
//   - Todos os casos de Demanda Espontânea (tipo 'DE').
//   - Gatilhos com data igual ou posterior à data de corte (ex.: a partir de 01/09).
//   - usuarios, setores, listas, naranjo, gatilhos (antídotos), config_geral e log_auditoria.
//
// SEGURANÇA E LÁPIDE ANTI-RESSURREIÇÃO:
//   - Grava lápides na coleção casos_excluidos (SCHEMA.FS.CASOS_EXCLUIDOS)
//     para impedir que o robô ETL/Pentaho reenvie e recrie esses gatilhos
//     antigos no próximo ciclo de dispensação.
//   - Exige a Script Property PERMITIR_LIMPEZA_GATILHOS = 'SIM'
//     (ou PERMITIR_LIMPEZA_MASSA = 'SIM').
//   - Todas as funções têm sufixo "_" (não expostas a google.script.run).
// ═════════════════════════════════════════════════════════════════════════
const _PROP_PERMITIR_LIMPEZA_GATILHOS = 'PERMITIR_LIMPEZA_GATILHOS';

/** Normaliza a data de corte (dd/MM/yyyy ou ISO ou Date). Padrão: 01/09/2026 00:00:00. */
function _normalizarDataCorte_(dataCorte) {
  if (dataCorte instanceof Date) {
    if (isNaN(dataCorte.getTime())) throw new Error('Data de corte inválida.');
    return new Date(dataCorte.getFullYear(), dataCorte.getMonth(), dataCorte.getDate(), 0, 0, 0, 0);
  }
  let s = String(dataCorte || '').trim();
  if (!s) s = '01/09/2026';

  // Se passou apenas "01/09"
  if (/^\d{1,2}\/\d{1,2}$/.test(s)) {
    const anoAtual = new Date().getFullYear();
    s = s + '/' + anoAtual;
  }

  // dd/MM/yyyy
  const mBR = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mBR) {
    const d = parseInt(mBR[1], 10);
    const m = parseInt(mBR[2], 10) - 1;
    const y = parseInt(mBR[3], 10);
    return new Date(y, m, d, 0, 0, 0, 0);
  }

  // yyyy-MM-dd
  const mISO = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (mISO) {
    const y = parseInt(mISO[1], 10);
    const m = parseInt(mISO[2], 10) - 1;
    const d = parseInt(mISO[3], 10);
    return new Date(y, m, d, 0, 0, 0, 0);
  }

  const parsed = _parseDataFlexivel_(s);
  if (parsed) {
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 0, 0, 0, 0);
  }

  throw new Error('Data de corte "' + dataCorte + '" inválida. Use o formato dd/MM/yyyy (ex.: 01/09/2026).');
}

/** Extrai a data do caso com tolerância a múltiplos formatos legados. */
function _extrairDataCaso_(c) {
  if (!c) return null;
  let d = _parseDataFlexivel_(c.data);
  if (d) return d;
  d = _parseDataFlexivel_(c.criadoEm);
  if (d) return d;
  if (c.data) {
    const dt = new Date(c.data);
    if (!isNaN(dt.getTime())) return dt;
  }
  if (c.criadoEm) {
    const dt = new Date(c.criadoEm);
    if (!isNaN(dt.getTime())) return dt;
  }
  return null;
}

/** Verifica se um caso é gatilho de Busca Ativa ainda não triado. */
function _isGatilhoNaoTriado_(c) {
  if (!c) return false;
  // Status: deve ser 'PENDENTE TRIAGEM' (SCHEMA.STATUS.TRIAGEM)
  const st = String(c.status || '').trim().toUpperCase();
  const pendenteTriagem = (st === String(SCHEMA.STATUS.TRIAGEM).toUpperCase()) || (st === 'PENDENTE TRIAGEM');
  if (!pendenteTriagem) return false;

  // Tipo: DE (Demanda Espontânea) nunca é gatilho. BA ou ausente é gatilho (Busca Ativa)
  const tp = String(c.tipo || '').trim().toUpperCase();
  if (tp === 'DE') return false;

  return true;
}

/** Filtra gatilhos não triados cuja data seja estritamente anterior à data de corte. */
function _gatilhosNaoTriadosAnterioresA_(dataCorteObj) {
  const todos = fsListarTodos_(SCHEMA.FS.CASOS);
  const corteTime = dataCorteObj.getTime();

  return todos.filter(function (c) {
    if (!_isGatilhoNaoTriado_(c)) return false;
    const d = _extrairDataCaso_(c);
    if (!d) {
      Logger.log('[AVISO] Caso ' + (c._id || c.id) + ' ignorado na limpeza por não possuir data válida.');
      return false;
    }
    return d.getTime() < corteTime;
  });
}

/**
 * PASSO 1 (Gatilhos): DRY-RUN — lista e conta quantos gatilhos não triados
 * anteriores à data limite seriam excluídos. Não faz nenhuma alteração.
 * @param {string|Date=} dataCorte — padrão '01/09/2026'
 */
function limparGatilhosNaoTriadosAntigos_dryRun_(dataCorte) {
  const corteObj = _normalizarDataCorte_(dataCorte);
  const tz = Session.getScriptTimeZone();
  const dataFormatada = Utilities.formatDate(corteObj, tz, 'dd/MM/yyyy HH:mm:ss');

  Logger.log('=== DRY-RUN: Limpeza de Gatilhos Não Triados ===');
  Logger.log('Data de corte: ' + dataFormatada + ' (serão considerados casos anteriores a este momento)');

  const todos = fsListarTodos_(SCHEMA.FS.CASOS);
  const alvo = _gatilhosNaoTriadosAnterioresA_(corteObj);

  Logger.log('Total geral de casos em casos_ram: ' + todos.length);
  Logger.log('Total de gatilhos não triados anteriores a ' + dataFormatada.split(' ')[0] + ': ' + alvo.length);

  const porSetor = {};
  const porMed = {};

  alvo.forEach(function (c) {
    const id = c._id || c.id;
    const d = _extrairDataCaso_(c);
    const dStr = d ? Utilities.formatDate(d, tz, 'dd/MM/yyyy HH:mm') : 'SEM DATA';
    const st = c.setor || 'N/I';
    const med = c.medicamento || 'N/I';

    porSetor[st] = (porSetor[st] || 0) + 1;
    porMed[med] = (porMed[med] || 0) + 1;

    Logger.log('  - ID: ' + id + ' | Data: ' + dStr + ' | Paciente: ' + (c.iniciais || 'N/I') + ' | Prontuário: ' + (c.prontuario || 'N/I') + ' | Med: ' + med + ' | Setor: ' + st);
  });

  Logger.log('--- Resumo por Setor ---');
  Object.keys(porSetor).sort().forEach(function (s) { Logger.log('  ' + s + ': ' + porSetor[s]); });

  Logger.log('--- Resumo por Medicamento ---');
  Object.keys(porMed).sort().forEach(function (m) { Logger.log('  ' + m + ': ' + porMed[m]); });

  Logger.log('Fim do Dry-Run. NENHUM DADO FOI APAGADO.');
  return alvo.length;
}

/**
 * PASSO 2 (Gatilhos): Executa a exclusão de gatilhos não triados anteriores à data de corte.
 *
 * Trava de segurança:
 *   1) Script Property PERMITIR_LIMPEZA_GATILHOS = 'SIM' ou PERMITIR_LIMPEZA_MASSA = 'SIM'
 *   2) Parâmetro confirmar === true
 *
 * Ações:
 *   1. Grava lápide em SCHEMA.FS.CASOS_EXCLUIDOS para impedir recriação pelo robô ETL.
 *   2. Remove documentos do Firestore (SCHEMA.FS.CASOS).
 *   3. Remove linhas correspondentes da planilha SCHEMA.ABAS.CASOS (DB_Casos_RAM).
 *   4. Invalida o cache de casos.
 *   5. Registra trilha de auditoria em SCHEMA.FS.LOG.
 *
 * @param {boolean} confirmar — deve ser true
 * @param {string|Date=} dataCorte — padrão '01/09/2026'
 */
function limparGatilhosNaoTriadosAntigos_(confirmar, dataCorte) {
  const props = PropertiesService.getScriptProperties();
  const permitido = props.getProperty(_PROP_PERMITIR_LIMPEZA_GATILHOS) ||
                    props.getProperty(_PROP_PERMITIR_LIMPEZA);

  if (String(permitido).toUpperCase() !== 'SIM') {
    throw new Error(
      'Limpeza de gatilhos BLOQUEADA: defina a Script Property ' +
      'PERMITIR_LIMPEZA_GATILHOS = SIM (ou PERMITIR_LIMPEZA_MASSA = SIM) antes de executar. ' +
      'Isto evita exclusão acidental de casos em produção.'
    );
  }

  if (confirmar !== true) {
    throw new Error(
      'Chame limparGatilhosNaoTriadosAntigos_(true) para confirmar a exclusão. ' +
      'Rode limparGatilhosNaoTriadosAntigos_dryRun_() antes para conferir o que será apagado.'
    );
  }

  const corteObj = _normalizarDataCorte_(dataCorte);
  const tz = Session.getScriptTimeZone();
  const dataCorteDia = Utilities.formatDate(corteObj, tz, 'dd/MM/yyyy');
  const alvo = _gatilhosNaoTriadosAnterioresA_(corteObj);
  const total = alvo.length;

  Logger.log('Iniciando exclusão de ' + total + ' gatilho(s) não triado(s) anteriores a ' + dataCorteDia);

  if (total === 0) {
    Logger.log('Nenhum gatilho para excluir. Operação finalizada.');
    return { apagadosFs: 0, falhasFs: 0, linhasApagadasSheet: 0 };
  }

  const idsAlvo = alvo.map(function (c) { return String(c._id || c.id).trim(); });

  // 1. Grava lápides anti-ressurreição no Firestore (CASOS_EXCLUIDOS)
  const lapides = alvo.map(function (c) {
    const id = String(c._id || c.id).trim();
    return {
      id: id,
      dados: {
        id: id,
        motivo: 'Limpeza em massa: gatilho não triado anterior a ' + dataCorteDia,
        excluidoPor: usuarioAtual_() || 'SISTEMA_MANUTENCAO',
        excluidoEm: new Date(),
        tipoOriginal: String(c.tipo || 'BA'),
        statusOriginal: String(c.status || SCHEMA.STATUS.TRIAGEM)
      }
    };
  });

  try {
    fsBatchSet_(SCHEMA.FS.CASOS_EXCLUIDOS, lapides);
    Logger.log('Lápides gravadas em ' + SCHEMA.FS.CASOS_EXCLUIDOS + ': ' + lapides.length);
  } catch (eLapide) {
    Logger.log('[AVISO] Falha ao gravar lápides em lote: ' + eLapide.message);
  }

  // 2. Apaga do Firestore (SCHEMA.FS.CASOS)
  let apagadosFs = 0;
  let falhasFs = 0;

  try {
    fsBatchDelete_(SCHEMA.FS.CASOS, idsAlvo);
    apagadosFs = idsAlvo.length;
    Logger.log('Documentos excluídos do Firestore em lote: ' + apagadosFs);
  } catch (eBatch) {
    Logger.log('fsBatchDelete_ falhou (' + eBatch.message + '). Tentando exclusão unitária...');
    idsAlvo.forEach(function (id) {
      try {
        fsDeleteDoc_(SCHEMA.FS.CASOS, id);
        apagadosFs++;
      } catch (eUnit) {
        falhasFs++;
        Logger.log('Falha ao excluir doc ' + id + ' do Firestore: ' + eUnit.message);
      }
    });
  }

  // 3. Remove as linhas espelho da planilha Sheets (DB_Casos_RAM)
  let linhasApagadasSheet = 0;
  try {
    const planilha = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SCHEMA.ABAS.CASOS);
    if (planilha) {
      const idsSet = new Set(idsAlvo);
      linhasApagadasSheet = _removerLinhasPlanilhaPorIds_(planilha, idsSet);
      Logger.log('Linhas removidas do Sheets (' + SCHEMA.ABAS.CASOS + '): ' + linhasApagadasSheet);
    }
  } catch (eSheet) {
    Logger.log('[AVISO] Falha ao remover linhas do espelho Sheets: ' + eSheet.message);
  }

  // 4. Invalida o cache do Kanban
  invalidarCasosCache_();

  // 5. Trilha de auditoria LGPD/regulatório
  fsRegistrarLog_('LIMPEZA_GATILHOS_NAO_TRIADOS', 'N/A',
    'Limpeza de gatilhos não triados anteriores a ' + dataCorteDia + ': ' +
    apagadosFs + ' caso(s) removido(s) do Firestore (' + falhasFs + ' falhas), ' +
    linhasApagadasSheet + ' linha(s) removida(s) do Sheets. ' +
    'Por: ' + usuarioAtual_());

  Logger.log('=== Limpeza concluída: ' + apagadosFs + ' apagados no Firestore (' + falhasFs + ' falhas), ' +
             linhasApagadasSheet + ' linhas apagadas no Sheets. ===');

  return { apagadosFs: apagadosFs, falhasFs: falhasFs, linhasApagadasSheet: linhasApagadasSheet };
}

/**
 * PASSO 3 (Gatilhos): Função auxiliar para disparar a limpeza de gatilhos não triados
 * anteriores a 01/09/2026 diretamente pelo Editor do Apps Script.
 * Selecione esta função no menu superior e clique em Executar.
 * Requer Script Property PERMITIR_LIMPEZA_GATILHOS = SIM (ou PERMITIR_LIMPEZA_MASSA = SIM).
 */
function EXECUTAR_LIMPEZA_GATILHOS_ANTERIORES_01_09_() {
  limparGatilhosNaoTriadosAntigos_(true, '01/09/2026');
}

/**
 * Função auxiliar para rodar o Dry-Run de 01/09/2026 pelo Editor do Apps Script (sem apagar nada).
 * Selecione esta função no menu superior e clique em Executar.
 */
function EXECUTAR_DRY_RUN_GATILHOS_ANTERIORES_01_09_() {
  limparGatilhosNaoTriadosAntigos_dryRun_('01/09/2026');
}

// ═════════════════════════════════════════════════════════════════════════
// MAPEAMENTO DE SETORES DOS GATILHOS & LIMPEZA POR SETOR (EDITOR)
// ═════════════════════════════════════════════════════════════════════════

/**
 * Mapeia todos os setores que já receberam gatilhos e lista quais estão
 * cadastrados e quais estão faltantes em SCHEMA.FS.SETORES. Apenas loga.
 */
function mapearSetoresDosGatilhos_dryRun_() {
  Logger.log('=== DRY-RUN: Mapeamento de Setores da Busca Ativa ===');
  const todosCasos = fsListarTodos_(SCHEMA.FS.CASOS);
  const docsSetores = fsListarTodos_(SCHEMA.FS.SETORES);

  const cadastradosPorChave = {};
  docsSetores.forEach(function (d) {
    const s = String(d.setor || '').trim();
    if (!s) return;
    cadastradosPorChave[_normalizarSetorComparacao_(s)] = s;
  });

  const setoresGatilhos = {};
  todosCasos.forEach(function (c) {
    const s = String(c.setor || '').trim();
    if (!s) return;
    const chave = _normalizarSetorComparacao_(s);
    if (!setoresGatilhos[chave]) {
      setoresGatilhos[chave] = {
        nome: s.toUpperCase(),
        total: 0,
        pendentes: 0,
        jaCadastrado: !!cadastradosPorChave[chave]
      };
    }
    setoresGatilhos[chave].total++;
    const isGatilho = String(c.tipo || '').trim().toUpperCase() !== 'DE';
    const st = String(c.status || '').trim().toUpperCase();
    if (isGatilho && (st === String(SCHEMA.STATUS.TRIAGEM).toUpperCase() || st === 'PENDENTE TRIAGEM')) {
      setoresGatilhos[chave].pendentes++;
    }
  });

  const lista = Object.values(setoresGatilhos).sort(function (a, b) {
    return a.nome.localeCompare(b.nome);
  });

  const faltantes = lista.filter(function (s) { return !s.jaCadastrado; });
  const cadastrados = lista.filter(function (s) { return s.jaCadastrado; });

  Logger.log('Total de casos analisados: ' + todosCasos.length);
  Logger.log('Total de setores distintos encontrados nos casos: ' + lista.length);
  Logger.log('Setores já cadastrados: ' + cadastrados.length);
  Logger.log('Setores FALTANTES (não cadastrados): ' + faltantes.length);

  if (faltantes.length > 0) {
    Logger.log('--- SETORES FALTANTES ---');
    faltantes.forEach(function (f) {
      Logger.log('  [FALTANTE] ' + f.nome + ' | Total de casos: ' + f.total + ' | Pendentes de triagem: ' + f.pendentes);
    });
  } else {
    Logger.log('Todos os setores encontrados já constam no cadastro.');
  }

  return { total: lista.length, faltantes: faltantes.length };
}

/**
 * Importa todos os setores encontrados nos casos que ainda não estão cadastrados em SCHEMA.FS.SETORES.
 * @param {boolean} confirmar — deve ser true
 */
function importarSetoresFaltantesDosGatilhos_(confirmar) {
  if (confirmar !== true) {
    throw new Error('Chame importarSetoresFaltantesDosGatilhos_(true) para confirmar a importação.');
  }
  return importarSetoresDosGatilhos(null, null);
}

/**
 * Limpa retroativamente os gatilhos não triados (status TRIAGEM / tipo BA) de um setor específico.
 * @param {string} nomeSetor
 * @param {boolean} confirmar — deve ser true
 */
function limparGatilhosNaoTriadosPorSetor_(nomeSetor, confirmar) {
  const props = PropertiesService.getScriptProperties();
  const permitido = props.getProperty(_PROP_PERMITIR_LIMPEZA_GATILHOS) ||
                    props.getProperty(_PROP_PERMITIR_LIMPEZA);
  if (String(permitido).toUpperCase() !== 'SIM') {
    throw new Error('Limpeza bloqueada: defina PERMITIR_LIMPEZA_GATILHOS = SIM nas propriedades do script.');
  }
  if (confirmar !== true) {
    throw new Error('Chame limparGatilhosNaoTriadosPorSetor_("' + nomeSetor + '", true) para confirmar.');
  }

  const res = alternarStatusSetorComLimpeza(nomeSetor, false, true, null);
  Logger.log('Resultado: ' + res.mensagem);
  return res;
}

function EXECUTAR_MAPEAR_SETORES_GATILHOS_DRY_RUN_() {
  mapearSetoresDosGatilhos_dryRun_();
}

/**
 * Executa o diagnóstico de harmonização e similaridade de setores no Editor do Apps Script.
 * Apenas analisa e exibe o log dos grupos divergentes encontrados, sem alterar nada.
 */
function harmonizarSetores_dryRun_() {
  Logger.log('=== DRY-RUN: Diagnóstico de Harmonização Geral de Setores ===');
  const diag = diagnosticarHarmonizacaoGeralSetores(null);
  Logger.log('Total de setores distintos no sistema: ' + diag.totalDistintos);
  Logger.log('Total de grupos com grafias divergentes: ' + diag.totalGruposDivergentes);

  if (!diag.grupos || !diag.grupos.length) {
    Logger.log('Parabéns! Todos os setores no sistema estão unificados e padronizados.');
    return diag;
  }

  diag.grupos.forEach(function (g, idx) {
    Logger.log('---------------------------------------------------------');
    Logger.log(`GRUPO ${idx + 1} -> Sugestão Canônica: [${g.sugestaoCanonica}] (${g.totalCasosGrupo} caso(s), ${g.totalUsuariosGrupo} usuário(s))`);
    g.variantes.forEach(function (v) {
      const matchInfo = v.similaridade ? ` (Similaridade: ${v.similaridade.porcentagem}% - ${v.similaridade.motivo})` : '';
      Logger.log(`   • "${v.nome}" | Casos: ${v.totalCasos} | Usuários: ${v.totalUsuarios} | Cadastrado: ${v.jaCadastrado ? 'SIM' : 'NÃO'}${matchInfo}`);
    });
  });

  return diag;
}

function EXECUTAR_HARMONIZACAO_SETORES_DRY_RUN_() {
  harmonizarSetores_dryRun_();
}

/**
 * Executa simulação (Dry Run) da normalização de todos os casos antigos do sistema.
 */
function normalizarGatilhosECasosExistentes_dryRun_() {
  Logger.log('=== DRY-RUN: Normalização de Casos e Gatilhos de Ponta a Ponta ===');
  const mapaSinonimos = _mapaSinonimosSetores_();
  const mapaGatilhos  = _mapaGatilhosCadastrados_();
  const todosCasos    = fsListarTodos_(SCHEMA.FS.CASOS);

  Logger.log('Total de casos analisados: ' + todosCasos.length);
  let paraAlterar = 0;

  todosCasos.forEach(function (c) {
    const setorAtual = String(c.setor || '').trim();
    const medAtual   = String(c.medicamento || '').trim();
    const setorCanonico = _resolverSetorCanonico_(setorAtual, mapaSinonimos);
    const gatilhoInfo   = _resolverGatilhoCanonico_(medAtual, mapaGatilhos);

    const mudouSetor = setorAtual && setorCanonico && setorAtual !== setorCanonico;
    const mudouMed   = medAtual && gatilhoInfo.medicamento && medAtual !== gatilhoInfo.medicamento;

    if (mudouSetor || mudouMed) {
      paraAlterar++;
      Logger.log(`[CASO ${c.id}]`);
      if (mudouSetor) Logger.log(`   • Setor: "${setorAtual}" -> "${setorCanonico}"`);
      if (mudouMed) Logger.log(`   • Medicamento: "${medAtual}" -> "${gatilhoInfo.medicamento}" (Dose: ${gatilhoInfo.dose} ${gatilhoInfo.unidade})`);
    }
  });

  Logger.log('---------------------------------------------------------');
  Logger.log(`Total de casos que seriam normalizados: ${paraAlterar} de ${todosCasos.length}`);
  return { total: todosCasos.length, alterados: paraAlterar };
}

function EXECUTAR_NORMALIZACAO_GATILHOS_CASOS_() {
  const prop = PropertiesService.getScriptProperties().getProperty('PERMITIR_NORMALIZACAO_MASSA');
  if (prop !== 'SIM') {
    Logger.log('Para executar de fato, adicione a Propriedade do Script PERMITIR_NORMALIZACAO_MASSA=SIM');
    return normalizarGatilhosECasosExistentes_dryRun_();
  }
  return normalizarCasosAntigosDePontaAPonta(null);
}

/**
 * Executa IMEDIATAMENTE a normalização completa de todos os gatilhos, setores UTI Adulto e casos do banco.
 * Pode ser selecionada e executada diretamente pelo editor do Google Apps Script sem exigir propriedades manuais.
 */
function EXECUTAR_NORMALIZACAO_BANCO_COMPLETA_() {
  Logger.log('=== INICIANDO NORMALIZACAO COMPLETA DO BANCO (GATILHOS, SETORES E CASOS) ===');
  
  // 1. Garante os 3 setores de UTI Adulto
  Logger.log('1. Verificando e cadastrando setores de UTI ADULTO I, II e III...');
  const resUtis = garantirSetoresUtiAdultoCadastrados(null);
  Logger.log(`   • Setores UTI Adulto: ${resUtis.criados} criados, ${resUtis.jaExistiam} já existiam.`);

  // 2. Normaliza gatilhos
  Logger.log('2. Normalizando coleção de gatilhos...');
  const resGatilhos = normalizarColecaoGatilhos(null);
  Logger.log(`   • Gatilhos: ${resGatilhos.alterados} alterados de ${resGatilhos.total}.`);

  // 3. Normaliza casos e notificações
  Logger.log('3. Normalizando todos os casos e notificações do banco...');
  const resCasos = normalizarCasosAntigosDePontaAPonta(null);
  Logger.log(`   • Casos/Notificações: ${resCasos.alterados} alterados de ${resCasos.totalCasos} (${resCasos.casosSheetsAtualizados} linhas no Sheets).`);

  Logger.log('=== NORMALIZACAO COMPLETA CONCLUIDA COM SUCESSO ===');
  return {
    utis: resUtis,
    gatilhos: resGatilhos,
    casos: resCasos
  };
}
