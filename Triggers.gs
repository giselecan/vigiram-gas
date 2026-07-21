/**
 * @fileoverview Triggers.gs — instalação/remoção/verificação dos triggers
 * de tempo e os handlers que eles disparam.
 *
 * Precisa viver AQUI (projeto institucional), não na library Backend:
 * um trigger instalável não pode apontar para uma função de library, só
 * para uma função do próprio projeto. Os handlers abaixo são só um repasse
 * de 1 linha; toda a lógica real está em Mirror.gs/Notify.gs do backend
 * (github.com/giselecan/vigiram-backend).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Espelho Firestore → Sheets (Mirror.gs no backend)
// ─────────────────────────────────────────────────────────────────────────────

function processarFilaEspelho() {
  return Backend.processarFilaEspelho();
}

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

/** Confirma se o trigger de retry está instalado. */
function verificarTriggerEspelho() {
  const instalado = ScriptApp.getProjectTriggers()
    .some(function (t) { return t.getHandlerFunction() === 'processarFilaEspelho'; });
  Logger.log(instalado
    ? '✅ Trigger processarFilaEspelho está instalado.'
    : '⚠️ Trigger processarFilaEspelho NÃO está instalado — rode instalarTriggerEspelho().');
  return instalado;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fila de notificações por e-mail (Notify.gs no backend)
// ─────────────────────────────────────────────────────────────────────────────

function processarFilaNotificacoes() {
  return Backend.processarFilaNotificacoes();
}

/**
 * Instala o trigger que roda processarFilaNotificacoes() a cada 1 minuto.
 * Rode manualmente no editor do Apps Script: selecione esta função → Executar.
 * Idempotente: não cria duplicatas se já existir.
 */
function instalarTriggerNotificacoes() {
  const existentes = ScriptApp.getProjectTriggers();
  const jaExiste = existentes.some(function (t) {
    return t.getHandlerFunction() === 'processarFilaNotificacoes';
  });

  if (jaExiste) {
    Logger.log('Trigger processarFilaNotificacoes já instalado — nenhuma ação necessária.');
    return;
  }

  ScriptApp.newTrigger('processarFilaNotificacoes')
    .timeBased()
    .everyMinutes(1)
    .create();

  Logger.log('✅ Trigger instalado: processarFilaNotificacoes a cada 1 minuto.');
}

/** Remove o trigger (use para manutenção ou desativação da fila de e-mail). */
function removerTriggerNotificacoes() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'processarFilaNotificacoes'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('Trigger processarFilaNotificacoes removido.');
}

/** Confirma se o trigger da fila de e-mail está instalado. */
function verificarTriggerNotificacoes() {
  const instalado = ScriptApp.getProjectTriggers()
    .some(function (t) { return t.getHandlerFunction() === 'processarFilaNotificacoes'; });
  Logger.log(instalado
    ? '✅ Trigger processarFilaNotificacoes está instalado.'
    : '⚠️ Trigger processarFilaNotificacoes NÃO está instalado — rode instalarTriggerNotificacoes().');
  return instalado;
}

// ─────────────────────────────────────────────────────────────────────────────
// Relatório diário de gatilhos (Notify.gs no backend)
// ─────────────────────────────────────────────────────────────────────────────

function enviarRelatorioDiarioGatilhos() {
  return Backend.enviarRelatorioDiarioGatilhos();
}

/**
 * Instala o trigger que roda enviarRelatorioDiarioGatilhos() todo dia às
 * 07:00 (horário do fuso do projeto Apps Script). Rode manualmente no editor:
 * selecione esta função → Executar. Idempotente: não cria duplicatas.
 */
function instalarTriggerRelatorioDiario() {
  const existentes = ScriptApp.getProjectTriggers();
  const jaExiste = existentes.some(function (t) {
    return t.getHandlerFunction() === 'enviarRelatorioDiarioGatilhos';
  });

  if (jaExiste) {
    Logger.log('Trigger enviarRelatorioDiarioGatilhos já instalado — nenhuma ação necessária.');
    return;
  }

  ScriptApp.newTrigger('enviarRelatorioDiarioGatilhos')
    .timeBased()
    .atHour(7)
    .everyDays(1)
    .create();

  Logger.log('✅ Trigger instalado: enviarRelatorioDiarioGatilhos todo dia às 07:00.');
}

/** Remove o trigger diário (use para manutenção ou desativação do relatório). */
function removerTriggerRelatorioDiario() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'enviarRelatorioDiarioGatilhos'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('Trigger enviarRelatorioDiarioGatilhos removido.');
}

/** Confirma se o trigger do relatório diário está instalado. */
function verificarTriggerRelatorioDiario() {
  const instalado = ScriptApp.getProjectTriggers()
    .some(function (t) { return t.getHandlerFunction() === 'enviarRelatorioDiarioGatilhos'; });
  Logger.log(instalado
    ? '✅ Trigger enviarRelatorioDiarioGatilhos está instalado.'
    : '⚠️ Trigger enviarRelatorioDiarioGatilhos NÃO está instalado — rode instalarTriggerRelatorioDiario().');
  return instalado;
}
