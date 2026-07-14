/**
 * @fileoverview Config_Write.gs — Gravação de configurações no Firestore.
 *
 * Todas as funções exigem token válido + perfil ADMIN via _comAdmin_().
 * Após cada gravação, invalida o CacheService (CONFIG_CACHE_KEY) para que
 * getConfig() releia imediatamente na próxima chamada do frontend.
 *
 * Funções expostas ao frontend (google.script.run):
 *   salvarConfigGeral(dados, token)          → { sucesso, mensagem }
 *   salvarSetores(setores, token)            → { sucesso, mensagem }
 *   diagnosticarSetoresDuplicados(token)     → { totalSetores, totalGrupos, duplicados }
 *   mesclarSetoresDuplicados(grupos, token)  → { sucesso, mensagem }
 *   salvarListas(listas, token)              → { sucesso, mensagem }
 *   listarGatilhos(token)                    → Array<{id, medicamento, ativo, atualizadoEm}>
 *   salvarGatilho(dados, token)              → { sucesso, mensagem }
 *   alternarStatusGatilho(id, ativo, token)  → { sucesso, mensagem }
 *   excluirGatilho(id, token)                → { sucesso, mensagem }
 *
 * FASE 9 — FIRESTORE COMO SINGLE SOURCE OF TRUTH:
 *   Gatilhos deixaram de ler/gravar em DB_Antidotos (Sheets) e passaram a
 *   operar 100% em Firestore (SCHEMA.FS.GATILHOS). O CRUD é linha-a-linha
 *   (cada medicamento é seu próprio documento, ID = nome em SNAKE_CASE),
 *   para alimentar a tabela de dados do painel admin (toggle de status,
 *   editar, excluir individualmente) sem depender mais de um "salvar tudo".
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
 * ID do documento = setor + e-mail do responsável (ver _idDocSetor_ em
 * Utils.gs) — permite MAIS DE UM farmacêutico responsável pelo mesmo setor
 * (ex.: "TODOS") sem que o segundo cadastrado apague o primeiro.
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
      const email = String(s.email || '').trim();
      const id = _idDocSetor_(setor, email);
      idsNovos[id] = true;
      fsSetDoc_(SCHEMA.FS.SETORES, id, {
        setor:                    setor,
        ativo:                    true, // CORREÇÃO #7: boolean a partir de agora, não mais 'SIM'
        farmaceuticoResponsavel:  String(s.farmaceutico || '').trim().toUpperCase(),
        emailResponsavel:         email
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
// DIAGNÓSTICO + MESCLAGEM DE SETORES DUPLICADOS
//
// Duplicata real (mesmo setor físico, mesmo responsável) só surge quando o
// MESMO par (setor, e-mail) foi salvo com grafias levemente diferentes em
// edições distintas — cada grafia gera um ID de documento próprio
// (_idDocSetor_ é determinístico por string exata), então nunca se
// auto-mescla sozinho. Ver painel Admin → Setores → "Verificar Duplicados".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agrupa os documentos de `setores` por (nome normalizado para comparação +
 * e-mail do responsável) e devolve só os grupos com MAIS DE UMA grafia —
 * candidatos a duplicata. Só leitura, não altera nada.
 * @returns {{ totalSetores: number, totalGrupos: number, duplicados: Array<Array<object>> }}
 */
function diagnosticarSetoresDuplicados(token) {
  return _comAdmin_(token, function () {
    const docs = fsListarTodos_(SCHEMA.FS.SETORES);
    const grupos = {};

    docs.forEach(function (doc) {
      const chave = _normalizarSetorComparacao_(doc.setor) + '__' + String(doc.emailResponsavel || '').trim().toLowerCase();
      if (!grupos[chave]) grupos[chave] = [];
      grupos[chave].push({
        id:           doc._id,
        setor:        String(doc.setor || '').trim(),
        farmaceutico: String(doc.farmaceuticoResponsavel || '').trim(),
        email:        String(doc.emailResponsavel || '').trim(),
        ativo:        doc.ativo
      });
    });

    const duplicados = Object.keys(grupos)
      .map(function (chave) { return grupos[chave]; })
      .filter(function (grupo) { return grupo.length > 1; })
      .sort(function (a, b) { return b.length - a.length; });

    return {
      totalSetores: docs.length,
      totalGrupos:  Object.keys(grupos).length,
      duplicados:   duplicados
    };
  });
}

/**
 * Mescla grupos de setores duplicados já revisados pelo admin no painel.
 * Para cada grupo: upsert do documento canônico (grafia escolhida), remove
 * as demais grafias, e atualiza usuarios.setores que ainda apontem pra
 * grafia antiga — sem isso, a próxima edição desse usuário recriaria a
 * duplicata (_sincronizarSetoresUsuario_ usa usuarios.setores como base).
 * NÃO toca em casos_ram — histórico de casos já normaliza (maiúsculo/trim)
 * toda vez que lê pra agrupar por setor, então não quebra com grafia antiga.
 * @param {Array<{email, farmaceutico, nomeCanonico, idsAntigos: string[], grafias: string[]}>} grupos
 */
function mesclarSetoresDuplicados(grupos, token) {
  return _comAdmin_(token, function () {
    if (!Array.isArray(grupos) || !grupos.length) {
      return { sucesso: false, mensagem: 'Nenhum grupo para mesclar.' };
    }

    let mesclados = 0, removidos = 0, usuariosAtualizados = 0;

    grupos.forEach(function (g) {
      const email        = String(g.email || '').trim();
      const nomeCanonico = String(g.nomeCanonico || '').trim().toUpperCase();
      const idsAntigos    = Array.isArray(g.idsAntigos) ? g.idsAntigos : [];
      const farmaceutico  = String(g.farmaceutico || '').trim();
      if (!email || !nomeCanonico || !idsAntigos.length) return;

      const idCanonico = _idDocSetor_(nomeCanonico, email);

      fsSetDoc_(SCHEMA.FS.SETORES, idCanonico, {
        setor:                    nomeCanonico,
        ativo:                    true,
        farmaceuticoResponsavel:  farmaceutico,
        emailResponsavel:         email
      });
      mesclados++;

      idsAntigos.forEach(function (id) {
        if (id === idCanonico) return; // já é o canônico, acabou de ser upsertado
        fsDeleteDoc_(SCHEMA.FS.SETORES, id);
        removidos++;
      });

      const grafiasAntigas = Array.isArray(g.grafias) && g.grafias.length ? g.grafias : [nomeCanonico];
      usuariosAtualizados += _atualizarUsuariosParaSetorCanonico_(grafiasAntigas, nomeCanonico);
    });

    invalidarConfig();
    fsRegistrarLog_('SETORES_MESCLADOS', 'setores',
      mesclados + ' grupo(s) mesclado(s), ' + removidos + ' documento(s) removido(s), ' +
      usuariosAtualizados + ' usuário(s) atualizado(s) | Por: ' + __emailSessaoAtual);

    return {
      sucesso: true,
      mensagem: mesclados + ' setor(es) mesclado(s), ' + removidos + ' duplicata(s) removida(s)' +
        (usuariosAtualizados ? ', ' + usuariosAtualizados + ' usuário(s) realinhado(s).' : '.')
    };
  });
}

/**
 * Troca, no array `setores` de cada usuário, qualquer grafia antiga (após
 * normalizar maiúsculo/trim) pela grafia canônica — e dedup o array
 * resultante (dois nomes antigos do mesmo grupo podiam coexistir no mesmo
 * usuário). Só grava (fsUpdateDoc_) os usuários que realmente mudaram.
 * @returns {number} quantidade de usuários atualizados
 */
function _atualizarUsuariosParaSetorCanonico_(grafiasAntigas, nomeCanonico) {
  const antigasNormalizadas = {};
  grafiasAntigas.forEach(function (s) {
    const up = String(s || '').trim().toUpperCase();
    if (up && up !== nomeCanonico) antigasNormalizadas[up] = true;
  });
  if (!Object.keys(antigasNormalizadas).length) return 0;

  const usuarios = fsListarTodos_(SCHEMA.FS.USUARIOS);
  let atualizados = 0;

  usuarios.forEach(function (u) {
    const atuais = Array.isArray(u.setores) ? u.setores : [];
    if (!atuais.length) return;

    let mudou = false;
    const vistos = {};
    const novo = [];
    atuais.forEach(function (s) {
      const up = String(s || '').trim().toUpperCase();
      const final = antigasNormalizadas[up] ? nomeCanonico : up;
      if (antigasNormalizadas[up]) mudou = true;
      if (!vistos[final]) { vistos[final] = true; novo.push(final); }
    });

    if (mudou) {
      fsUpdateDoc_(SCHEMA.FS.USUARIOS, u._id, { setores: novo });
      atualizados++;
    }
  });

  return atualizados;
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
 * Lê a lista completa de gatilhos (ativos e inativos) direto da coleção
 * Firestore SCHEMA.FS.GATILHOS, para alimentar a tabela de dados do painel
 * admin. DB_Antidotos (Sheets) não é lido aqui — ver handleGetTriggers()
 * em Ingest.gs para a rota equivalente consumida pelo robô PowerShell
 * (que continua vendo só os ativos).
 * Retorna array de objetos { id, medicamento, ativo, atualizadoEm }.
 */
function listarGatilhos(token) {
  return comAutenticacao_(token, function () {
    try {
      const docs = fsListarTodos_(SCHEMA.FS.GATILHOS);
      return docs
        // Antes filtrava por `d.medicamento && d._id`, o que ESCONDIA qualquer
        // doc sem o campo `medicamento` (campo ausente/renomeado por migração ou
        // versão antiga). Isso causava o sintoma "salvar diz que já existe, mas
        // não aparece na lista": fsGetDoc_ enxerga o doc, mas listarGatilhos o
        // descartava. Agora só exigimos o _id e derivamos o nome do próprio ID
        // (medicamento em SNAKE_CASE) quando o campo faltar — nada é ocultado.
        .filter(function (d) { return d._id; })
        .map(function (d) {
          const semMedicamento = d.medicamento == null || !String(d.medicamento).trim();
          const nome = semMedicamento
            ? String(d._id).replace(/_/g, ' ')
            : String(d.medicamento);
          const medicamento = nome.trim().toUpperCase();

          // Auto-cura: grava o `medicamento` derivado de volta no doc. Sem
          // isso, o doc continua sem esse campo e handleGetTriggers() (Ingest.gs
          // — a rota consumida pelo robô PowerShell) segue ignorando esse
          // gatilho para sempre, mesmo aparecendo ativo aqui no painel. Best
          // effort: falha na escrita não deve impedir a listagem.
          if (semMedicamento) {
            try {
              fsUpdateDoc_(SCHEMA.FS.GATILHOS, d._id, { medicamento: medicamento });
            } catch (e) {
              console.error('listarGatilhos: falha ao auto-curar medicamento do doc ' + d._id + ': ' + e.message);
            }
          }

          return {
            id:           d._id,
            medicamento:  medicamento,
            ativo:        d.ativo !== false,
            atualizadoEm: dataParaIsoSegura_(d.atualizadoEm)
          };
        })
        .sort(function (a, b) { return a.medicamento.localeCompare(b.medicamento); });
    } catch (erro) {
      throw new Error('Não foi possível carregar os gatilhos do Firestore: ' + erro.message);
    }
  });
}

/**
 * Cria ou edita um único gatilho (linha da tabela do painel admin).
 * ID do documento = nome do medicamento em SNAKE_CASE. Se `dados.id` for
 * informado e o nome mudar, o documento é recriado sob o novo ID e o
 * antigo é removido (mesma lógica de "upsert + delete do órfão").
 * @param {{id?: string, medicamento: string, ativo: boolean}} dados
 */
function salvarGatilho(dados, token) {
  return _comAdmin_(token, function () {
    const idOriginal = String((dados && dados.id) || '').trim();
    const nome        = String((dados && dados.medicamento) || '').trim().toUpperCase();
    const ativo        = !dados || dados.ativo !== false;

    if (!nome) return { sucesso: false, mensagem: 'Informe o nome do medicamento.' };

    const idNovo = nome.replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');
    if (!idNovo) return { sucesso: false, mensagem: 'Nome de medicamento inválido.' };

    if (idNovo !== idOriginal) {
      const existente = fsGetDoc_(SCHEMA.FS.GATILHOS, idNovo);
      if (existente) return { sucesso: false, mensagem: 'Já existe um gatilho com esse nome.' };
    }

    fsSetDoc_(SCHEMA.FS.GATILHOS, idNovo, {
      medicamento:  nome,
      ativo:        ativo,
      atualizadoEm: new Date()
    });

    if (idOriginal && idOriginal !== idNovo) {
      fsDeleteDoc_(SCHEMA.FS.GATILHOS, idOriginal);
    }

    fsRegistrarLog_(idOriginal ? 'GATILHO_ATUALIZADO' : 'GATILHO_CRIADO', 'N/A',
      nome + ' | Por: ' + __emailSessaoAtual);

    return { sucesso: true, mensagem: 'Gatilho "' + nome + '" salvo com sucesso.' };
  });
}

/**
 * Alterna o status ativo/inativo de um gatilho (toggle switch da tabela).
 * @param {string} id - ID do documento (nome em SNAKE_CASE)
 * @param {boolean} ativo
 */
function alternarStatusGatilho(id, ativo, token) {
  return _comAdmin_(token, function () {
    const docId = String(id || '').trim();
    if (!docId) return { sucesso: false, mensagem: 'Gatilho inválido.' };

    const existente = fsGetDoc_(SCHEMA.FS.GATILHOS, docId);
    if (!existente) return { sucesso: false, mensagem: 'Gatilho não encontrado.' };

    fsUpdateDoc_(SCHEMA.FS.GATILHOS, docId, { ativo: !!ativo, atualizadoEm: new Date() });

    fsRegistrarLog_(ativo ? 'GATILHO_ATIVADO' : 'GATILHO_DESATIVADO', 'N/A',
      (existente.medicamento || docId) + ' | Por: ' + __emailSessaoAtual);

    return { sucesso: true, mensagem: 'Status atualizado.' };
  });
}

/**
 * Exclui definitivamente um gatilho.
 * @param {string} id - ID do documento (nome em SNAKE_CASE)
 */
function excluirGatilho(id, token) {
  return _comAdmin_(token, function () {
    const docId = String(id || '').trim();
    if (!docId) return { sucesso: false, mensagem: 'Gatilho inválido.' };

    const existente = fsGetDoc_(SCHEMA.FS.GATILHOS, docId);
    if (!existente) return { sucesso: false, mensagem: 'Gatilho não encontrado.' };

    fsDeleteDoc_(SCHEMA.FS.GATILHOS, docId);

    fsRegistrarLog_('GATILHO_EXCLUIDO', 'N/A',
      (existente.medicamento || docId) + ' | Por: ' + __emailSessaoAtual);

    return { sucesso: true, mensagem: 'Gatilho excluído com sucesso.' };
  });
}
