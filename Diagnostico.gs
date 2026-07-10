/**
 * @fileoverview Diagnostico.gs — utilitário de investigação (dev/suporte).
 *
 * COMO USAR:
 *   1. No editor do Apps Script, selecione a função `diagnosticarAdmin`
 *      na barra de funções e clique em Executar.
 *   2. Abra "Execução" / "Logs" (Ctrl+Enter) e copie TODO o texto.
 *   3. Cole aqui no chat.
 *
 * Executar no EDITOR usa sempre o código mais recente (o que o `clasp push`
 * subiu), independente de qual VERSÃO do web app está publicada — por isso
 * este teste isola "bug de código" de "deployment desatualizado".
 *
 * Nenhuma escrita destrutiva: só lê contadores e nomes de campos. Nada é
 * apagado nem alterado.
 */
function diagnosticarAdmin() {
  const out = [];
  const linha = function (s) { out.push(s); };

  linha('===== DIAGNÓSTICO ADMIN — ' + new Date().toISOString() + ' =====');

  // 1) Config / coleções esperadas
  try {
    linha('SCHEMA.FS.GATILHOS = ' + JSON.stringify(SCHEMA.FS.GATILHOS));
    linha('SCHEMA.FS.LOG      = ' + JSON.stringify(SCHEMA.FS.LOG));
    linha('SCHEMA.FS.USUARIOS = ' + JSON.stringify(SCHEMA.FS.USUARIOS));
    linha('URL base Firestore = ' + fsUrlBase_());
  } catch (e) {
    linha('!! Erro lendo config: ' + e.message);
  }

  // 2) GATILHOS — o foco. Lista bruta + amostra de campos de cada doc.
  linha('--- GATILHOS ---');
  try {
    const g = fsListarTodos_(SCHEMA.FS.GATILHOS);
    linha('fsListarTodos_(GATILHOS): ' + g.length + ' documento(s)');
    g.slice(0, 8).forEach(function (d) {
      linha('   _id=' + d._id +
            ' | campos=' + JSON.stringify(Object.keys(d).filter(function (k) { return k !== '_id'; })) +
            ' | medicamento=' + JSON.stringify(d.medicamento) +
            ' | ativo=' + JSON.stringify(d.ativo));
    });
  } catch (e) {
    linha('!! fsListarTodos_(GATILHOS) ERRO: ' + e.message);
  }

  // 3) Controle — USUARIOS lista pela MESMA função. Deve ser > 0.
  linha('--- USUARIOS (controle) ---');
  try {
    const u = fsListarTodos_(SCHEMA.FS.USUARIOS);
    linha('fsListarTodos_(USUARIOS): ' + u.length + ' documento(s)  (esperado > 0)');
  } catch (e) {
    linha('!! fsListarTodos_(USUARIOS) ERRO: ' + e.message);
  }

  // 4) LOG — contagem via listagem bruta + teste da query ordenada.
  linha('--- LOG AUDITORIA ---');
  try {
    const l = fsListarTodos_(SCHEMA.FS.LOG);
    linha('fsListarTodos_(LOG): ' + l.length + ' documento(s)');
    if (l[0]) {
      linha('   log[0] campos=' + JSON.stringify(Object.keys(l[0]).filter(function (k) { return k !== '_id'; })) +
            ' | data=' + JSON.stringify(l[0].data));
    }
  } catch (e) {
    linha('!! fsListarTodos_(LOG) ERRO: ' + e.message);
  }
  try {
    const lq = fsQuery_(SCHEMA.FS.LOG, null, 5, [{ campo: 'data', direcao: 'DESCENDING' }]);
    linha('fsQuery_(LOG, orderBy data desc, limit 5): ' + lq.length + ' documento(s)');
  } catch (e) {
    linha('!! fsQuery_(LOG orderBy data) ERRO (índice ausente?): ' + e.message);
  }

  // 5) DB_Antidotos (planilha) — fonte original dos gatilhos, se ainda existir.
  linha('--- PLANILHA DB_Antidotos (origem da migração) ---');
  try {
    const plan = getSheet_(SCHEMA.ABAS.ANTIDOTOS);
    if (!plan) {
      linha('Aba DB_Antidotos: NÃO existe.');
    } else {
      const vals = plan.getDataRange().getValues();
      linha('Aba DB_Antidotos: ' + Math.max(0, vals.length - 1) + ' linha(s) de dados.');
      for (var i = 1; i < Math.min(vals.length, 6); i++) {
        linha('   linha ' + i + ': ' + JSON.stringify(vals[i].slice(0, 4)));
      }
    }
  } catch (e) {
    linha('!! Leitura DB_Antidotos ERRO: ' + e.message);
  }

  linha('===== FIM =====');

  const texto = out.join('\n');
  Logger.log(texto);
  return texto;
}
