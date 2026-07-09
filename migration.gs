/**
 * @fileoverview Migration.gs — Migração ÚNICA da Fase 6.
 *
 * Executar UMA vez, manualmente, pelo editor do Apps Script (selecionar a função
 * e clicar em "Executar"). É idempotente e seguro: pode rodar de novo sem duplicar.
 *
 * O QUE FAZ:
 *  1. Garante os cabeçalhos das colunas novas (29..34) na linha 1 de DB_Casos_RAM.
 *  2. Faz parsing da PII legada que estava concatenada em OBSERVACOES (24) no
 *     formato antigo:
 *        [Notificado por: NOME (CATEGORIA) em DATA] [E-mail para feedback: EMAIL]
 *     e move cada atributo para NOTIF_NOME (31), NOTIF_CATEGORIA (32),
 *     NOTIF_EMAIL (33). Depois REMOVE esse bloco de OBSERVACOES (de-PII do campo
 *     livre, requisito #8 / LGPD). DATA_NOTIFICACAO (34) recebe ATUALIZADO_EM
 *     da linha como melhor aproximação, quando disponível.
 *
 * O QUE NÃO FAZ (e por quê):
 *  - NÃO tenta separar relato/conduta legados de RELATO (13)/EVOLUCAO (16) para
 *    as colunas 29/30. Em casos DE que já passaram por investigação, 13/16 podem
 *    conter texto do farmacêutico, não do notificador — não há como distinguir
 *    com segurança. Casos NOVOS já nascem com o schema correto. Se quiser tentar
 *    o backfill de relato apenas para casos DE ainda não investigados, use a
 *    função opcional migrarRelatoDE_NaoInvestigados() abaixo, ciente do risco.
 *
 * COMO USAR:
 *  1. Rode migrarSchemaNotificador_v1(true)  → DRY-RUN: só relata, não grava.
 *  2. Confira o log (Ver > Registros de execução).
 *  3. Rode migrarSchemaNotificador_v1(false) → aplica de fato.
 *  4. Rode invalidarConfig() para limpar caches, se aplicável.
 */

// Regex do bloco legado de notificador em OBSERVACOES.
const _RX_NOTIF =
  /\[Notificado por:\s*(.*?)\s*\((.*?)\)\s*em\s*(.*?)\]/i;
const _RX_EMAIL_FEEDBACK =
  /\[E-mail para feedback:\s*(.*?)\]/i;

function migrarSchemaNotificador_v1(dryRun) {
  const simular = dryRun !== false; // default: dry-run
  return comTrava_(function () {
    const planilha = getSheetOuErro_(SCHEMA.ABAS.CASOS);
    const C = SCHEMA.COL;

    // 1) Cabeçalhos das colunas novas (linha 1)
    const headers = {
      [C.RELATO_NOTIFICADOR]:  'RELATO_NOTIFICADOR',
      [C.CONDUTA_NOTIFICADOR]: 'CONDUTA_NOTIFICADOR',
      [C.NOTIF_NOME]:          'NOTIF_NOME',
      [C.NOTIF_CATEGORIA]:     'NOTIF_CATEGORIA',
      [C.NOTIF_EMAIL]:         'NOTIF_EMAIL',
      [C.DATA_NOTIFICACAO]:    'DATA_NOTIFICACAO'
    };
    Object.keys(headers).forEach(function (col) {
      const c = Number(col);
      const atual = String(planilha.getRange(1, c).getValue() || '').trim();
      if (!atual) {
        if (simular) Logger.log('CABEÇALHO faltando na col %s → "%s"', c, headers[col]);
        else planilha.getRange(1, c).setValue(headers[col]);
      }
    });

    // 2) Parsing da PII legada em OBSERVACOES
    const ultima = planilha.getLastRow();
    if (ultima < 2) { Logger.log('Sem dados para migrar.'); return { migrados: 0, simulado: simular }; }

    const valores = planilha.getDataRange().getValues();
    let migrados = 0;

    for (let i = 1; i < valores.length; i++) {
      const linha = valores[i];
      if (!cel(linha, C.ID)) continue;

      const jaTem = String(cel(linha, C.NOTIF_NOME) || '').trim();
      if (jaTem) continue; // idempotência: linha já migrada

      const obs = String(cel(linha, C.OBSERVACOES) || '');
      const mNotif = obs.match(_RX_NOTIF);
      if (!mNotif) continue; // nada para extrair

      const nome = (mNotif[1] || 'N/I').trim();
      const cat  = (mNotif[2] || 'N/I').trim();
      const mEmail = obs.match(_RX_EMAIL_FEEDBACK);
      const email = mEmail ? (mEmail[1] || '').trim() : '';

      // Remove os blocos do texto livre → de-PII de OBSERVACOES
      const obsLimpo = obs
        .replace(_RX_NOTIF, '')
        .replace(_RX_EMAIL_FEEDBACK, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

      const rawAtual = cel(linha, C.ATUALIZADO_EM);
      const dataNotif = (rawAtual instanceof Date) ? rawAtual : '';

      const r = i + 1; // linha 1-based na planilha

      if (simular) {
        Logger.log('Linha %s [%s] → nome="%s" cat="%s" email="%s"',
          r, cel(linha, C.ID), nome, cat, email);
      } else {
        planilha.getRange(r, C.NOTIF_NOME)      .setValue(nome);
        planilha.getRange(r, C.NOTIF_CATEGORIA) .setValue(cat);
        planilha.getRange(r, C.NOTIF_EMAIL)     .setValue(email);
        if (dataNotif) planilha.getRange(r, C.DATA_NOTIFICACAO).setValue(dataNotif);
        planilha.getRange(r, C.OBSERVACOES)     .setValue(obsLimpo);
      }
      migrados++;
    }

    Logger.log('%s — linhas afetadas: %s', simular ? 'DRY-RUN' : 'APLICADO', migrados);
    return { migrados: migrados, simulado: simular };
  });
}

/**
 * OPCIONAL — backfill de relato/conduta apenas para casos DE que ainda NÃO foram
 * investigados (sem conclusão e sem naranjo), onde é razoável assumir que
 * RELATO (13)/EVOLUCAO (16) ainda contêm o texto original do notificador.
 * Copia 13→29 e 16→30 (preservando 13/16). NÃO limpa 13/16.
 *
 * Rode em dry-run primeiro. Use por sua conta e risco — revise o log.
 */
function migrarRelatoDE_NaoInvestigados(dryRun) {
  const simular = dryRun !== false;
  return comTrava_(function () {
    const planilha = getSheetOuErro_(SCHEMA.ABAS.CASOS);
    const C = SCHEMA.COL;
    const valores = planilha.getDataRange().getValues();
    let migrados = 0;

    for (let i = 1; i < valores.length; i++) {
      const linha = valores[i];
      if (!cel(linha, C.ID)) continue;

      const tipo      = String(cel(linha, C.TIPO) || '').toUpperCase().trim();
      const conclusao = String(cel(linha, C.CONCLUSAO) || '').trim();
      const naranjo   = String(cel(linha, C.NARANJO) || '').trim();
      const jaTemRel  = String(cel(linha, C.RELATO_NOTIFICADOR) || '').trim();

      if (tipo !== 'DE') continue;
      if (conclusao || naranjo) continue; // já investigado → não confiar em 13/16
      if (jaTemRel) continue;             // idempotência

      const rel  = String(cel(linha, C.RELATO)   || '').trim();
      const cond = String(cel(linha, C.EVOLUCAO) || '').trim();
      if (!rel && !cond) continue;

      const r = i + 1;
      if (simular) {
        Logger.log('DE não investigado linha %s [%s] → 29="%s" 30="%s"',
          r, cel(linha, C.ID), rel, cond);
      } else {
        if (rel)  planilha.getRange(r, C.RELATO_NOTIFICADOR).setValue(rel);
        if (cond) planilha.getRange(r, C.CONDUTA_NOTIFICADOR).setValue(cond);
      }
      migrados++;
    }

    Logger.log('%s (relato DE) — linhas afetadas: %s', simular ? 'DRY-RUN' : 'APLICADO', migrados);
    return { migrados: migrados, simulado: simular };
  });
}
