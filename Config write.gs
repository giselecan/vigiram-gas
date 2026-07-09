/**
 * @fileoverview Config_Write.gs — Gravação de configurações no Firestore.
 *
 * Todas as funções exigem token válido + perfil ADMIN via _comAdmin_().
 * Após cada gravação, invalida o CacheService (CONFIG_CACHE_KEY) para que
 * getConfig() releia imediatamente na próxima chamada do frontend.
 *
 * Funções expostas ao frontend (google.script.run):
 *   salvarConfigGeral(dados, token)   → { sucesso, mensagem }
 *   salvarSetores(setores, token)     → { sucesso, mensagem }
 *   salvarListas(listas, token)       → { sucesso, mensagem }
 *   salvarGatilhos(gatilhos, token)   → { sucesso, mensagem }
 *   listarGatilhos(token)             → Array<{medicamento}>
 *
 * FASE 9 — FIRESTORE COMO SINGLE SOURCE OF TRUTH:
 *   listarGatilhos/salvarGatilhos deixaram de ler/gravar em DB_Antidotos
 *   (Sheets) e passaram a operar 100% em Firestore (SCHEMA.FS.GATILHOS),
 *   com a mesma estratégia "upsert + delete-de-órfãos" de salvarSetores —
 *   nunca há uma janela em que a coleção fica vazia/parcial em caso de falha
 *   no meio da operação.
 *
 *   Toda função aqui trocou o log Sheets-only registrarLog_() (Audit.gs) por
 *   fsRegistrarLog_() (Firestore.gs) — grava a auditoria no Firestore (fonte
 *   única) e, de forma best-effort/não bloqueante, espelha em Sheets via
 *   appendRow (ver Mirror.gs). Nenhuma função do sistema volta a LER esses
 *   logs do Sheets para funcionar — é só trilha de auditoria.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG GERAL (SLA, e-mail coordenação, alertas)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Salva pares chave/valor na coleção config_geral do Firestore.
 * Cada chave vira um documento { chave, valor } — mesmo formato
 * que lerConfigGeralFirestore_() já lê.
 * @param {{ [chave: string]: string }} dados
 */
function salvarConfigGeral(dados, token) {
  return _comAdmin_(token, function () {
    if (!dados || typeof dados !== 'object') {
      return { sucesso: false, mensagem: 'Dados inválidos.' };
    }

    Object.entries(dados).forEach(function (par) {
      const chave = String(par[0] || '').trim();
      const valor = String(par[1] || '').trim();
      if (!chave) return;
      // ID do documento = própria chave (ex: 'SLA_PADRAO_HORAS')
      fsSetDoc_(SCHEMA.FS.GERAL, chave, { chave: chave, valor: valor });
    });

    invalidarConfig();
    fsRegistrarLog_('CONFIG_GERAL_ATUALIZADA', 'config_geral',
      'Campos: ' + Object.keys(dados).join(', ') + ' | Por: ' + __emailSessaoAtual);

    return { sucesso: true, mensagem: 'Configurações salvas com sucesso.' };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SETORES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Substitui todos os documentos da coleção setores.
 * Estratégia: exclui todos os docs existentes e reinsere.
 * ID do documento = setor em SNAKE_CASE para evitar caracteres inválidos.
 * @param {Array<{setor, farmaceutico, email}>} setores
 */
function salvarSetores(setores, token) {
  return _comAdmin_(token, function () {
    if (!Array.isArray(setores) || setores.length === 0) {
      return { sucesso: false, mensagem: 'Lista de setores vazia.' };
    }

    // [M7 — atomicidade] Versão anterior: delete-all + reinsert. Entre os dois
    // loops, getConfig()/getSetoresPublico() (inclusive do form ANÔNIMO) podia
    // ler a coleção vazia/parcial → notificação DE resolvia farmacêutico
    // errado/nenhum; falha no meio deixava a coleção mutilada sem rollback.
    // Nova ordem, sempre segura:
    //   1. UPSERT de todos os setores novos (coleção nunca fica menor que o
    //      conjunto final durante a operação);
    //   2. DELETE apenas dos órfãos (IDs que saíram da lista).
    // Falha no passo 1 → estado antigo + parte do novo (superset, form segue
    // funcionando). Falha no passo 2 → sobra órfão, corrigido no próximo save.

    // 1) Upsert
    const idsNovos = {};
    let upserts = 0;
    setores.forEach(function (s) {
      const setor = String(s.setor || '').trim().toUpperCase();
      if (!setor) return;
      const id = setor.replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');
      idsNovos[id] = true;
      fsSetDoc_(SCHEMA.FS.SETORES, id, {
        setor:                    setor,
        ativo:                    'SIM',
        farmaceuticoResponsavel:  String(s.farmaceutico || '').trim(),
        emailResponsavel:         String(s.email        || '').trim()
      });
      upserts++;
    });

    if (upserts === 0) {
      return { sucesso: false, mensagem: 'Nenhum setor válido na lista.' };
    }

    // 2) Delete só dos órfãos
    let removidos = 0;
    const existentes = fsListarTodos_(SCHEMA.FS.SETORES);
    existentes.forEach(function (doc) {
      if (doc._id && !idsNovos[doc._id]) {
        fsDeleteDoc_(SCHEMA.FS.SETORES, doc._id);
        removidos++;
      }
    });

    invalidarConfig(); // limpa também o cache público do form (ver Config.gs)
    fsRegistrarLog_('SETORES_ATUALIZADOS', 'setores',
      upserts + ' setor(es) salvos, ' + removidos + ' removido(s) | Por: ' + __emailSessaoAtual);

    return { sucesso: true, mensagem: upserts + ' setor(es) salvos com sucesso.' };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LISTAS / DROPDOWNS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Salva as opções de cada dropdown na coleção listas.
 * ID do documento = nome do campo (ex: 'gravidade').
 * @param {{ [campo: string]: string[] }} listas
 */
function salvarListas(listas, token) {
  return _comAdmin_(token, function () {
    if (!listas || typeof listas !== 'object') {
      return { sucesso: false, mensagem: 'Dados inválidos.' };
    }

    const camposValidos = ['gravidade', 'desfecho', 'conclusao',
                           'motivo_descarte', 'readministrado', 'evolucao',
                           // Fase 2 (roadmap) — dropdowns novos da tela de investigação
                           'acao_adotada', 'relacao_medicamento_evento',
                           'problemas_adicionais', 'unidade_intervalo'];

    let salvos = 0;
    Object.entries(listas).forEach(function (par) {
      const campo  = String(par[0] || '').trim();
      const opcoes = par[1];
      if (!camposValidos.includes(campo)) return;
      if (!Array.isArray(opcoes))         return;

      const opcoesLimpas = opcoes.map(function (o) { return String(o || '').trim(); })
                                 .filter(Boolean);
      fsSetDoc_(SCHEMA.FS.LISTAS, campo, { campo: campo, opcoes: opcoesLimpas });
      salvos++;
    });

    invalidarConfig();
    fsRegistrarLog_('LISTAS_ATUALIZADAS', 'listas',
      salvos + ' lista(s) salvas | Por: ' + __emailSessaoAtual);

    return { sucesso: true, mensagem: salvos + ' lista(s) salvas com sucesso.' };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GATILHOS (medicamentos monitorados pelo ETL) — Firestore SOMENTE (Fase 9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lê a lista de gatilhos direto da coleção Firestore SCHEMA.FS.GATILHOS.
 * DB_Antidotos (Sheets) não é mais lido aqui — ver handleGetTriggers()
 * em Ingest.gs para a rota equivalente consumida pelo robô PowerShell.
 * Retorna array de objetos { medicamento }.
 */
function listarGatilhos(token) {
  return comAutenticacao_(token, function () {
    try {
      const docs = fsListarTodos_(SCHEMA.FS.GATILHOS);
      return docs
        .filter(function (d) { return d.medicamento && d.ativo !== false; })
        .map(function (d) { return { medicamento: String(d.medicamento).trim().toUpperCase() }; })
        .sort(function (a, b) { return a.medicamento.localeCompare(b.medicamento); });
    } catch (erro) {
      throw new Error('Não foi possível carregar os gatilhos do Firestore: ' + erro.message);
    }
  });
}

/**
 * Substitui a lista de gatilhos na coleção Firestore SCHEMA.FS.GATILHOS.
 * Mesma estratégia "upsert + delete-de-órfãos" de salvarSetores — nunca há
 * uma janela em que a coleção fica vazia/parcial em caso de falha no meio
 * da operação. ID do documento = nome do medicamento em SNAKE_CASE.
 * @param {string[]} gatilhos — lista de nomes de medicamentos (strings)
 */
function salvarGatilhos(gatilhos, token) {
  return _comAdmin_(token, function () {
    if (!Array.isArray(gatilhos)) {
      return { sucesso: false, mensagem: 'Lista inválida.' };
    }

    const nomesFiltrados = gatilhos
      .map(function (g) { return String(g || '').trim().toUpperCase(); })
      .filter(Boolean);

    if (nomesFiltrados.length === 0) {
      return { sucesso: false, mensagem: 'Adicione ao menos um medicamento.' };
    }

    // 1) Upsert — coleção nunca fica menor que o conjunto final durante a operação
    const idsNovos = {};
    let upserts = 0;
    nomesFiltrados.forEach(function (nome) {
      const id = nome.replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');
      if (!id) return;
      idsNovos[id] = true;
      fsSetDoc_(SCHEMA.FS.GATILHOS, id, { medicamento: nome, ativo: true });
      upserts++;
    });

    if (upserts === 0) {
      return { sucesso: false, mensagem: 'Nenhum medicamento válido na lista.' };
    }

    // 2) Delete só dos órfãos (IDs que saíram da lista)
    let removidos = 0;
    const existentes = fsListarTodos_(SCHEMA.FS.GATILHOS);
    existentes.forEach(function (doc) {
      if (doc._id && !idsNovos[doc._id]) {
        fsDeleteDoc_(SCHEMA.FS.GATILHOS, doc._id);
        removidos++;
      }
    });

    fsRegistrarLog_('GATILHOS_ATUALIZADOS', 'N/A',
      upserts + ' gatilho(s) salvos, ' + removidos + ' removido(s) | Por: ' + __emailSessaoAtual);

    return { sucesso: true, mensagem: upserts + ' gatilho(s) salvo(s) com sucesso.' };
  });
}
