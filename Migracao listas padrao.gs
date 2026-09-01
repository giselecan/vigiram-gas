/**
 * @fileoverview Migracao_ListasPadrao.gs — repõe no Firestore as opções
 * padronizadas dos dropdowns (coleção `listas`).
 *
 * MOTIVO (09/2026):
 *   A lista `dose_unidade` foi reduzida a ["GOTAS"] por uma edição no painel
 *   admin. lerListasFirestore_ (Config.gs) SUBSTITUI a lista inteira pelo que
 *   está no Firestore — não mescla com DEFAULT_LISTAS —, então todas as outras
 *   unidades sumiram do dropdown da tela de investigação.
 *
 *   Corrigir o DEFAULT_LISTAS no código NÃO resolve sozinho: enquanto existir
 *   o documento `listas/dose_unidade` no Firestore, ele continua vencendo. Daí
 *   esta migração.
 *
 *   O mesmo vale para `forma_farmaceutica`, que passou a ser dropdown fechado
 *   (antes era texto livre) e ainda não tem documento no Firestore.
 *
 * ESTRATÉGIA — UNIÃO, não sobrescrita:
 *   Por padrão o resultado é DEFAULT_LISTAS + o que já estava no Firestore,
 *   sem duplicar. Assim uma opção legítima que o hospital cadastrou (ex.: um
 *   desfecho próprio) NÃO é perdida por causa desta migração. Para descartar
 *   o conteúdo atual e deixar exatamente o padrão do código, rode com
 *   { substituir: true } — e leia o aviso do dry-run antes.
 *
 * TRAVA UCUM (dose_unidade):
 *   G.k.4.r.1b exige token UCUM exato em doseQuantity/@unit. Opção sem
 *   equivalente em SCHEMA.E2B.DOSE_UNIDADE_MAP faz o VigiFlow descartar o
 *   bloco de posologia inteiro. Esta migração NUNCA grava uma unidade órfã:
 *   ela é descartada do resultado e LOGADA nominalmente. Mesma regra que
 *   salvarListas (Config write.gs) aplica na entrada do painel admin.
 *
 * COMO USAR (editor do Apps Script — não é exposto ao front-end):
 *   1. migrarListasPadrao_dryRun()   → só LOGA o antes/depois. Não grava nada.
 *   2. Confira o log em "Execuções".
 *   3. migrarListasPadrao_aplicar()  → grava e invalida o cache de config.
 *
 *   Para mexer só nos dois campos do incidente, sem tocar nos outros dropdowns:
 *      migrarDoseEForma_dryRun() / migrarDoseEForma_aplicar()
 *
 * IDEMPOTENTE: rodar de novo depois de aplicada não muda nada (o log mostra
 * "sem alteração" em cada campo).
 */

/** Campos do incidente 09/2026 — usados pelos wrappers "DoseEForma". */
const _CAMPOS_INCIDENTE_UCUM = ['dose_unidade', 'forma_farmaceutica'];

/**
 * Monta o plano de migração SEM gravar nada — é o que o dry-run imprime e o
 * que o modo aplicar executa, para os dois caminhos nunca divergirem.
 *
 * @param {string[]=} campos  Campos a tratar. Default: todos de DEFAULT_LISTAS.
 * @param {boolean=} substituir  true = ignora o que está no Firestore.
 * @returns {Array<{campo, atual, resultado, adicionadas, preservadas, descartadas, mudou}>}
 */
function _planoListasPadrao_(campos, substituir) {
  const alvos = (campos && campos.length) ? campos : Object.keys(DEFAULT_LISTAS);
  const plano = [];

  alvos.forEach(function (campo) {
    const padrao = DEFAULT_LISTAS[campo];
    if (!Array.isArray(padrao)) {
      Logger.log('IGNORADO: "%s" não existe em DEFAULT_LISTAS (Config.gs).', campo);
      return;
    }

    let atual = [];
    try {
      const doc = fsGetDoc_(SCHEMA.FS.LISTAS, campo);
      if (doc && Array.isArray(doc.opcoes)) atual = doc.opcoes;
    } catch (e) {
      // Propaga: migração é operação manual e supervisionada. Seguir adiante
      // com "atual = []" faria a união virar sobrescrita silenciosa.
      throw new Error('Falha ao ler listas/' + campo + ' no Firestore: ' + e.message);
    }

    // Chave de comparação em MAIÚSCULO: é assim que E2b.gs consulta os mapas
    // *_MAP, então "mg"/"MG" são a MESMA unidade e não podem virar 2 opções.
    // O rótulo que sobrevive é sempre o do DEFAULT_LISTAS (canônico).
    const vistos = {};
    const resultado = [];
    const adicionadas = [];
    const preservadas = [];

    padrao.forEach(function (opt) {
      const chave = String(opt).trim().toUpperCase();
      if (!chave || vistos[chave]) return;
      vistos[chave] = true;
      resultado.push(String(opt).trim());
    });

    if (!substituir) {
      atual.forEach(function (opt) {
        const limpo = String(opt || '').trim();
        const chave = limpo.toUpperCase();
        if (!limpo || vistos[chave]) return;
        vistos[chave] = true;
        resultado.push(limpo);
        preservadas.push(limpo);
      });
    }

    // Trava UCUM — ver cabeçalho. Só se aplica à unidade da dose.
    let descartadas = [];
    let finais = resultado;
    if (campo === 'dose_unidade') {
      descartadas = _unidadesDoseSemMapa_(resultado);
      if (descartadas.length) {
        const fora = {};
        descartadas.forEach(function (d) { fora[String(d).toUpperCase()] = true; });
        finais = resultado.filter(function (o) { return !fora[String(o).toUpperCase()]; });
      }
    }

    const atualChaves = atual.map(function (o) { return String(o || '').trim(); });
    finais.forEach(function (o) {
      if (atualChaves.indexOf(o) === -1 && preservadas.indexOf(o) === -1) adicionadas.push(o);
    });

    plano.push({
      campo:       campo,
      atual:       atualChaves,
      resultado:   finais,
      adicionadas: adicionadas,
      preservadas: preservadas,
      descartadas: descartadas,
      mudou:       JSON.stringify(atualChaves) !== JSON.stringify(finais)
    });
  });

  return plano;
}

/**
 * Repõe as opções padronizadas dos dropdowns no Firestore.
 *
 * @param {boolean=} dryRun     Default TRUE (só loga). Passe false para gravar.
 * @param {{campos?: string[], substituir?: boolean}=} opcoes
 * @returns {{simulado, campos, alterados, detalhes}}
 */
function migrarListasPadrao(dryRun, opcoes) {
  const simular    = dryRun !== false;   // mesma convenção das outras migrações
  const cfg        = opcoes || {};
  const substituir = cfg.substituir === true;

  const plano = _planoListasPadrao_(cfg.campos, substituir);

  Logger.log('===== MIGRACAO DE LISTAS PADRAO (%s | modo: %s) =====',
    simular ? 'DRY-RUN' : 'APLICANDO', substituir ? 'SUBSTITUIR' : 'UNIAO');

  let alterados = 0;

  plano.forEach(function (p) {
    Logger.log('');
    Logger.log('--- %s ---', p.campo);
    Logger.log('  ANTES  (%s): %s', p.atual.length, p.atual.length ? p.atual.join(' | ') : '(documento inexistente)');
    Logger.log('  DEPOIS (%s): %s', p.resultado.length, p.resultado.join(' | '));

    if (p.adicionadas.length) Logger.log('  + adicionadas do padrão: %s', p.adicionadas.join(', '));
    if (p.preservadas.length) Logger.log('  = preservadas do Firestore (customização local): %s', p.preservadas.join(', '));
    if (p.descartadas.length) {
      Logger.log('  ! DESCARTADAS por não terem equivalente UCUM em SCHEMA.E2B.DOSE_UNIDADE_MAP: %s', p.descartadas.join(', '));
      Logger.log('    (gravá-las faria o VigiMed descartar a posologia do caso — cadastre o token');
      Logger.log('     UCUM em Schema.gs primeiro se alguma dessas for realmente necessária.)');
    }

    if (!p.resultado.length) {
      Logger.log('  ABORTADO neste campo: resultado vazio — não se grava lista vazia.');
      return;
    }
    if (!p.mudou) {
      Logger.log('  sem alteração.');
      return;
    }

    if (simular) {
      Logger.log('  [DRY-RUN] gravaria listas/%s', p.campo);
    } else {
      fsSetDoc_(SCHEMA.FS.LISTAS, p.campo, { campo: p.campo, opcoes: p.resultado });
      Logger.log('  GRAVADO em listas/%s', p.campo);
    }
    alterados++;
  });

  if (!simular && alterados > 0) {
    // Sem isto o getConfig_ segue servindo a lista velha por até 10 min
    // (CONFIG_CACHE_SEG) e o farmacêutico jura que a migração não funcionou.
    invalidarConfig();
    try {
      fsRegistrarLog_('LISTAS_PADRAO_MIGRADAS', 'listas',
        alterados + ' lista(s) repostas | modo: ' + (substituir ? 'SUBSTITUIR' : 'UNIAO') +
        ' | campos: ' + plano.filter(function (p) { return p.mudou; })
                             .map(function (p) { return p.campo; }).join(', '));
    } catch (e) { /* log é best-effort, nunca derruba a migração */ }
  }

  Logger.log('');
  Logger.log('===== %s — %s campo(s) com alteração de %s analisado(s) =====',
    simular ? 'DRY-RUN (nada gravado)' : 'APLICADO', alterados, plano.length);

  if (simular && alterados > 0) {
    Logger.log('Para gravar de verdade, rode: migrarListasPadrao_aplicar()');
  }

  return {
    simulado:  simular,
    campos:    plano.length,
    alterados: alterados,
    detalhes:  plano
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WRAPPERS — o editor do Apps Script só roda função sem argumento
// ─────────────────────────────────────────────────────────────────────────────

/** TODOS os dropdowns · só loga o que faria. Comece por aqui. */
function migrarListasPadrao_dryRun() {
  return migrarListasPadrao(true);
}

/** TODOS os dropdowns · grava (união: preserva customizações do hospital). */
function migrarListasPadrao_aplicar() {
  return migrarListasPadrao(false);
}

/** Só dose_unidade + forma_farmaceutica · só loga. */
function migrarDoseEForma_dryRun() {
  return migrarListasPadrao(true, { campos: _CAMPOS_INCIDENTE_UCUM });
}

/** Só dose_unidade + forma_farmaceutica · grava. Resolve o incidente 09/2026. */
function migrarDoseEForma_aplicar() {
  return migrarListasPadrao(false, { campos: _CAMPOS_INCIDENTE_UCUM });
}

/**
 * Reset duro: descarta o que está no Firestore e deixa EXATAMENTE o
 * DEFAULT_LISTAS do código. Só loga — não existe wrapper "aplicar" de
 * propósito: para executar, chame
 *     migrarListasPadrao(false, { substituir: true })
 * conscientemente, depois de ler este dry-run. Toda opção listada em
 * "preservadas" no modo união será PERDIDA aqui.
 */
function migrarListasPadrao_resetDuro_dryRun() {
  return migrarListasPadrao(true, { substituir: true });
}
