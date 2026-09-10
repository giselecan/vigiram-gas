/**
 * @fileoverview Migracao_SchemaE2B.gs — utilitários pontuais de cabeçalho.
 *
 * v2 (07/2026 — reordenação de colunas + LOTE/LABORATORIO + DATA_INICIO_ADM):
 *   A aba DB_Casos_RAM foi fisicamente reordenada (46 colunas). Como o espelho
 *   (Mirror.gs) grava POSICIONALMENTE via SCHEMA.COL, qualquer divergência
 *   entre o cabeçalho físico e o Schema embaralha linhas silenciosamente.
 *
 *   verificarCabecalhosSchema_v2(dryRun):
 *     - DRY-RUN (default): compara célula a célula a linha 1 contra a ordem
 *       canônica derivada de SCHEMA.COL e LOGA toda divergência. NÃO grava nada.
 *     - APLICAR (dryRun=false): reescreve a linha 1 INTEIRA com os nomes
 *       canônicos. Só cabeçalho — NUNCA toca em dados (linha 2+).
 *
 *   ⚠️ PRÉ-REQUISITO CRÍTICO: as COLUNAS DE DADOS já devem ter sido movidas
 *   manualmente para a nova ordem ANTES de aplicar. Este script alinha só o
 *   rótulo — ele não move dados. Se o dry-run apontar divergência, PARE e
 *   confira se é (a) só rótulo errado/espaço extra → pode aplicar, ou
 *   (b) coluna de dados fora de posição → reordene a coluna na planilha primeiro.
 *
 * COMO USAR:
 *   1. Deploy do Schema.gs novo (LARGURA=46) ANTES de rodar.
 *   2. verificarCabecalhos_dryRun()  → confere log em Execuções.
 *   3. Corrija posições físicas se necessário; repita o dry-run até zerar
 *      divergências de DADOS (divergência só de rótulo é ok).
 *   4. verificarCabecalhos_aplicar() → grava os 46 cabeçalhos canônicos.
 *
 * v1 (migrarSchemaE2B_v1) mantida abaixo por histórico — NÃO rodar de novo:
 * as posições 35-42 que ela referenciava não existem mais na ordem atual.
 */

/** Ordem canônica dos cabeçalhos — derivada 1:1 de SCHEMA.COL (Schema.gs). */
function _cabecalhosCanonicos_() {
  const C = SCHEMA.COL;
  const h = {};
  h[C.ID]                  = 'ID_CASO';
  h[C.DATA]                = 'DATA_EVENTO';
  h[C.TIPO]                = 'TIPO';
  h[C.NOTIF_NOME]          = 'NOTIF_NOME';
  h[C.NOTIF_CATEGORIA]     = 'NOTIF_CATEGORIA';
  h[C.DATA_NOTIFICACAO]    = 'DATA_NOTIFICACAO';
  h[C.PRONTUARIO]          = 'PRONTUARIO';
  h[C.INICIAIS]            = 'INICIAIS_PACIENTE';
  h[C.NASCIMENTO]          = 'DATA_NASCIMENTO';
  h[C.SEXO]                = 'SEXO';
  h[C.SETOR]               = 'SETOR';
  h[C.MEDICAMENTO]         = 'MEDICAMENTO_SUSPEITO';
  h[C.DOSE_MEDICAMENTO]    = 'DOSE_MEDICAMENTO';
  h[C.DOSE_UNIDADE]        = 'DOSE_UNIDADE';
  h[C.LOTE]                = 'LOTE';
  h[C.LABORATORIO]         = 'LABORATORIO';
  h[C.VIA_ADMINISTRACAO]   = 'VIA_ADMINISTRACAO';
  h[C.DATA_INICIO_ADM]     = 'DATA_INICIO_ADMINISTRACAO';
  h[C.RELATO_NOTIFICADOR]  = 'RELATO_NOTIFICADOR';
  h[C.CONDUTA_NOTIFICADOR] = 'CONDUTA_NOTIFICADOR';
  h[C.STATUS]              = 'STATUS';
  h[C.SLA]                 = 'PRAZO_SLA';
  h[C.MOTIVO_DESCARTE]     = 'MOTIVO_DESCARTE';
  h[C.HISTORIA]            = 'HISTORIA_CLINICA';
  h[C.RELATO]              = 'RELATO_EVENTO';
  h[C.REACAO_TERMO]        = 'REACAO_TERMO';
  h[C.DATA_INICIO_REACAO]  = 'DATA_INICIO_REACAO';
  h[C.EXAMES]              = 'EXAMES_COMPLEMENTARES';
  h[C.READMINISTRADO]      = 'READMINISTRADO';
  h[C.EVOLUCAO]            = 'EVOLUCAO_POS_CONDUTAS';
  h[C.DESFECHO]            = 'DESFECHO';
  h[C.CONCLUSAO]           = 'CONCLUSAO';
  h[C.NARANJO]             = 'NARANJO';
  h[C.GRAVIDADE]           = 'GRAVIDADE';
  h[C.FARMACEUTICO]        = 'FARMACEUTICO';
  h[C.NUM_VIGIMED]         = 'NUM_VIGIMED';
  h[C.DATA_VIGIMED]        = 'DATA_VIGIMED';
  h[C.OBSERVACOES]         = 'OBSERVACOES';
  h[C.NARANJO_RESP]        = 'NARANJO_RESPOSTAS';
  h[C.ATUALIZADO_POR]      = 'ATUALIZADO_POR';
  h[C.ATUALIZADO_EM]       = 'ATUALIZADO_EM';
  h[C.NOTIF_EMAIL]         = 'NOTIF_EMAIL';
  h[C.ID_REACAO_E2B]       = 'ID_REACAO_E2B';
  h[C.ID_MEDICAMENTO_E2B]  = 'ID_MEDICAMENTO_E2B';
  h[C.SAFETYREPORTID_E2B]  = 'SAFETYREPORTID_E2B';
  h[C.DATA_TRIAGEM]        = 'DATA_TRIAGEM';
  return h;
}

function verificarCabecalhosSchema_v2(dryRun) {
  const simular = dryRun !== false; // default: dry-run
  return comTrava_(function () {
    const planilha = getSheetOuErro_(SCHEMA.ABAS.CASOS);
    const canon = _cabecalhosCanonicos_();

    // Sanidade: todas as posições 1..LARGURA cobertas, sem colisão.
    const esperado = [];
    for (let c = 1; c <= SCHEMA.LARGURA; c++) {
      if (!canon[c]) throw new Error('SCHEMA.COL sem cabeçalho canônico para a coluna ' + c + ' — corrija _cabecalhosCanonicos_().');
      esperado.push(canon[c]);
    }
    if (Object.keys(canon).length !== SCHEMA.LARGURA) {
      throw new Error('Colisão de posição em SCHEMA.COL — duas chaves apontam para a mesma coluna.');
    }

    const atual = planilha.getRange(1, 1, 1, Math.max(SCHEMA.LARGURA, planilha.getLastColumn())).getValues()[0];

    let divergencias = 0;
    for (let c = 1; c <= SCHEMA.LARGURA; c++) {
      const fisico = String(atual[c - 1] || '').trim();
      if (fisico !== esperado[c - 1]) {
        divergencias++;
        Logger.log('DIVERGÊNCIA col %s: físico="%s" | canônico="%s"', c, fisico, esperado[c - 1]);
      }
    }
    // Colunas extras à direita do LARGURA
    for (let c = SCHEMA.LARGURA + 1; c <= atual.length; c++) {
      const sobra = String(atual[c - 1] || '').trim();
      if (sobra) {
        divergencias++;
        Logger.log('COLUNA EXTRA além de LARGURA (%s): col %s = "%s" — remova ou incorpore ao Schema.', SCHEMA.LARGURA, c, sobra);
      }
    }

    if (!simular && divergencias > 0) {
      planilha.getRange(1, 1, 1, SCHEMA.LARGURA).setValues([esperado]);
      fsRegistrarLog_('MIGRACAO_SCHEMA', 'DB_Casos_RAM', 'Cabeçalhos reescritos para layout 46 colunas (v2).');
    }

    Logger.log('%s — verificarCabecalhosSchema_v2: %s divergência(s)%s.',
      simular ? 'DRY-RUN' : 'APLICADO',
      divergencias,
      simular ? '' : (divergencias ? ' — linha 1 reescrita' : ' — nada a fazer'));

    return { simulado: simular, divergencias: divergencias };
  });
}

/** Wrapper para execução manual no editor — DRY RUN */
function verificarCabecalhos_dryRun() {
  return verificarCabecalhosSchema_v2(true);
}

/** Wrapper para execução manual no editor — APLICA de fato (só linha 1) */
function verificarCabecalhos_aplicar() {
  return verificarCabecalhosSchema_v2(false);
}

// ─────────────────────────────────────────────────────────────────────────────
// v1 — HISTÓRICO. NÃO RODAR: escrevia cabeçalhos nas posições antigas (35-42),
// que na ordem atual pertencem a outras colunas. Mantido só como registro.
// ─────────────────────────────────────────────────────────────────────────────
/*
function migrarSchemaE2B_v1(dryRun) { ... versão anterior removida ... }
*/
