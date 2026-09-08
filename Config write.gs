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
 * Lista os setores para o painel admin — INCLUSIVE os desativados.
 *
 * getConfig().setores não serve aqui: lerSetoresFirestore_ (Config.gs) filtra
 * os inativos, que é o certo para dropdowns e para o envio do relatório
 * diário, mas na tela de administração faria o setor SUMIR ao ser desativado,
 * sem nenhum caminho de volta para reativá-lo.
 *
 * Mesmo formato de lerSetoresFirestore_ + o campo `ativo`.
 * @returns {Array<{setor, email, farmaceutico, ativo}>}
 */
function listarSetoresAdmin(token) {
  return _comAdmin_(token, function () {
    const docs = fsListarTodos_(SCHEMA.FS.SETORES);
    const lista = [];
    docs.forEach(function (doc) {
      const setor = String(doc.setor || '').trim();
      if (!setor) return;
      lista.push({
        setor:        setor,
        email:        String(doc.emailResponsavel || '').trim(),
        farmaceutico: String(doc.farmaceuticoResponsavel || '').trim(),
        ativo:        _ativoComoBooleano_(doc.ativo)
      });
    });
    return lista;
  });
}

/**
 * Substitui todos os documentos da coleção setores.
 * Estratégia: exclui todos os docs existentes e reinsere.
 * ID do documento = setor + e-mail do responsável (ver _idDocSetor_ em
 * Utils.gs) — permite MAIS DE UM farmacêutico responsável pelo mesmo setor
 * (ex.: "TODOS") sem que o segundo cadastrado apague o primeiro.
 *
 * `ativo` (opcional, default true) desliga o setor: some dos dropdowns e do
 * relatório diário (lerSetoresFirestore_) e, principalmente, faz o
 * handleInsertDB DESCARTAR os gatilhos que o robô varrer nele
 * (_setoresInativosMapa_, Config.gs). Como o toggle da tela é por setor, o
 * mesmo valor precisa vir em todas as linhas do setor.
 * @param {Array<{setor, farmaceutico, email, ativo?}>} setores
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

    // 1) Upsert em lote — PERF: a versão anterior fazia 1 fsSetDoc_ (1
    // round-trip HTTP síncrono) por setor; com dezenas de setores/
    // farmacêuticos, "Salvar Setores" travava por vários segundos.
    // fsBatchSet_ resolve tudo em ceil(N/400) chamadas via :commit — mesmo
    // padrão já usado pelo ETL (Ingest.gs).
    const idsNovos = {};
    const itensBatch = [];
    setores.forEach(function (s) {
      const setor = String(s.setor || '').trim().toUpperCase();
      if (!setor) return;
      const email = String(s.email || '').trim();
      const id = _idDocSetor_(setor, email);
      if (idsNovos[id]) return; // mesmo setor+e-mail repetido na lista — dedup defensivo
      idsNovos[id] = true;
      itensBatch.push({
        id: id,
        dados: {
          setor:                   setor,
          // CORREÇÃO #7: boolean a partir de agora, não mais 'SIM'.
          // Antes era `true` fixo: qualquer "Salvar Setores" REATIVAVA todos
          // os setores, então desativar um setor era impossível na prática.
          // _ativoComoBooleano_ mantém a compatibilidade com quem não manda o
          // campo (undefined ⇒ ativo) e com o legado em texto ('SIM'/'NAO').
          ativo:                   _ativoComoBooleano_(s.ativo),
          farmaceuticoResponsavel: String(s.farmaceutico || '').trim().toUpperCase(),
          emailResponsavel:        email
        }
      });
    });

    if (!itensBatch.length) {
      return { sucesso: false, mensagem: 'Nenhum setor válido na lista.' };
    }
    fsBatchSet_(SCHEMA.FS.SETORES, itensBatch);

    // 2) Delete só dos órfãos, também em lote
    const existentes = fsListarTodos_(SCHEMA.FS.SETORES);
    const idsOrfaos = existentes
      .filter(function (doc) { return doc._id && !idsNovos[doc._id]; })
      .map(function (doc) { return doc._id; });
    if (idsOrfaos.length) fsBatchDelete_(SCHEMA.FS.SETORES, idsOrfaos);

    invalidarConfig(); // limpa também o cache público do form (ver Config.gs)
    fsRegistrarLog_('SETORES_ATUALIZADOS', 'setores',
      itensBatch.length + ' setor(es) salvos, ' + idsOrfaos.length + ' removido(s) | Por: ' + __emailSessaoAtual);

    return { sucesso: true, mensagem: itensBatch.length + ' setor(es) salvos com sucesso.' };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAPEAMENTO E SINCRONIZAÇÃO DE SETORES DOS GATILHOS (BUSCA ATIVA)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mapeia todos os setores que já receberam gatilhos/casos na Busca Ativa (casos_ram)
 * e compara com a coleção de setores cadastrados (SCHEMA.FS.SETORES).
 * Identifica setores faltantes para que o admin possa gerenciar a varredura deles.
 * @returns {{ sucesso: boolean, totalCasosAnalisados: number, totalSetoresGatilhos: number, totalSetoresCadastrados: number, setores: Array<object>, faltantes: Array<object> }}
 */
function mapearSetoresDosGatilhos(token) {
  return _comAdmin_(token, function () {
    const todosCasos = fsListarTodos_(SCHEMA.FS.CASOS);
    const docsSetores = fsListarTodos_(SCHEMA.FS.SETORES);

    // 1) Mapa dos setores já cadastrados
    const cadastradosPorChave = {};
    docsSetores.forEach(function (d) {
      const s = String(d.setor || '').trim();
      if (!s) return;
      const chave = _normalizarSetorComparacao_(s);
      if (!cadastradosPorChave[chave]) {
        cadastradosPorChave[chave] = {
          nome: s,
          ativo: _ativoComoBooleano_(d.ativo),
          responsaveis: []
        };
      }
      if (d.farmaceuticoResponsavel) {
        cadastradosPorChave[chave].responsaveis.push(d.farmaceuticoResponsavel);
      }
    });

    // 2) Mapeia setores encontrados nos casos/gatilhos
    const setoresGatilhos = {};
    todosCasos.forEach(function (c) {
      const s = String(c.setor || '').trim();
      if (!s) return;
      const chave = _normalizarSetorComparacao_(s);
      if (!setoresGatilhos[chave]) {
        setoresGatilhos[chave] = {
          chave: chave,
          nomeExibicao: s.toUpperCase(),
          totalCasos: 0,
          totalGatilhos: 0,
          totalPendentes: 0,
          jaCadastrado: !!cadastradosPorChave[chave],
          ativo: cadastradosPorChave[chave] ? cadastradosPorChave[chave].ativo : true
        };
      }

      setoresGatilhos[chave].totalCasos++;
      const isGatilho = String(c.tipo || '').trim().toUpperCase() !== 'DE';
      if (isGatilho) {
        setoresGatilhos[chave].totalGatilhos++;
        const st = String(c.status || '').trim().toUpperCase();
        if (st === String(SCHEMA.STATUS.TRIAGEM).toUpperCase() || st === 'PENDENTE TRIAGEM') {
          setoresGatilhos[chave].totalPendentes++;
        }
      }
    });

    const listaSetoresGatilhos = Object.values(setoresGatilhos).sort(function (a, b) {
      return a.nomeExibicao.localeCompare(b.nomeExibicao);
    });

    const faltantes = listaSetoresGatilhos.filter(function (s) {
      return !s.jaCadastrado;
    });

    return {
      sucesso: true,
      totalCasosAnalisados: todosCasos.length,
      totalSetoresGatilhos: listaSetoresGatilhos.length,
      totalSetoresCadastrados: Object.keys(cadastradosPorChave).length,
      setores: listaSetoresGatilhos,
      faltantes: faltantes
    };
  });
}

/**
 * Importa para SCHEMA.FS.SETORES os setores encontrados nos gatilhos que ainda
 * não estavam cadastrados, permitindo ativar/desativar a varredura de cada um.
 * @param {string[]=} setoresNomes — array de nomes de setor (se vazio, importa todos os faltantes)
 */
function importarSetoresDosGatilhos(setoresNomes, token) {
  return _comAdmin_(token, function () {
    let nomes = Array.isArray(setoresNomes) ? setoresNomes : null;

    if (!nomes || nomes.length === 0) {
      const mapa = mapearSetoresDosGatilhos(token);
      nomes = (mapa.faltantes || []).map(function (f) { return f.nomeExibicao; });
    }

    if (!nomes.length) {
      return { sucesso: true, adicionados: 0, mensagem: 'Nenhum setor novo para importar.' };
    }

    const docsExistentes = fsListarTodos_(SCHEMA.FS.SETORES);
    const existentesChaves = {};
    docsExistentes.forEach(function (d) {
      if (d.setor) existentesChaves[_normalizarSetorComparacao_(d.setor)] = true;
    });

    const itensBatch = [];
    const nomesAdicionados = [];

    nomes.forEach(function (nome) {
      const limpo = String(nome || '').trim().toUpperCase();
      if (!limpo) return;
      const chave = _normalizarSetorComparacao_(limpo);
      if (existentesChaves[chave]) return;

      existentesChaves[chave] = true;
      const id = _idDocSetor_(limpo, '');
      itensBatch.push({
        id: id,
        dados: {
          setor:                   limpo,
          ativo:                   true, // Já nasce ativo para varredura
          farmaceuticoResponsavel: '',
          emailResponsavel:        ''
        }
      });
      nomesAdicionados.push(limpo);
    });

    if (itensBatch.length > 0) {
      fsBatchSet_(SCHEMA.FS.SETORES, itensBatch);
      invalidarConfig();
      fsRegistrarLog_('SETORES_IMPORTADOS_GATILHOS', 'setores',
        itensBatch.length + ' setor(es) importados dos gatilhos: ' + nomesAdicionados.join(', ') + ' | Por: ' + __emailSessaoAtual);
    }

    return {
      sucesso: true,
      adicionados: itensBatch.length,
      nomes: nomesAdicionados,
      mensagem: itensBatch.length + ' setor(es) importado(s) dos gatilhos com sucesso.'
    };
  });
}

/**
 * Alterna o status ativo/inativo da varredura de um setor. Se desativado E limparRetroativo === true,
 * remove retroativamente todos os gatilhos não triados (pendentes) pertencentes àquele setor,
 * gravando lápides em CASOS_EXCLUIDOS para impedir que o robô ETL os recrie.
 *
 * @param {string} nomeSetor
 * @param {boolean} ativo
 * @param {boolean} limparRetroativo — se true e ativo === false, limpa casos pendentes do setor
 * @param {string} token
 */
function alternarStatusSetorComLimpeza(nomeSetor, ativo, limparRetroativo, token) {
  return _comAdmin_(token, function () {
    const setorLimpo = String(nomeSetor || '').trim();
    if (!setorLimpo) throw new Error('Nome do setor não informado.');

    const chaveAlvo = _normalizarSetorComparacao_(setorLimpo);
    const docs = fsListarTodos_(SCHEMA.FS.SETORES);
    const docsSetor = docs.filter(function (d) {
      return _normalizarSetorComparacao_(d.setor) === chaveAlvo;
    });

    if (docsSetor.length === 0) {
      // Se não existia no cadastro, cria-o com o status solicitado
      const idNovo = _idDocSetor_(setorLimpo.toUpperCase(), '');
      fsSetDoc_(SCHEMA.FS.SETORES, idNovo, {
        setor: setorLimpo.toUpperCase(),
        ativo: !!ativo,
        farmaceuticoResponsavel: '',
        emailResponsavel: ''
      });
    } else {
      // Atualiza o flag ativo em todos os documentos correspondentes do setor
      docsSetor.forEach(function (d) {
        fsUpdateDoc_(SCHEMA.FS.SETORES, d._id, {
          ativo: !!ativo
        });
      });
    }

    invalidarConfig();

    let apagadosFs = 0;
    let falhasFs = 0;
    let linhasSheet = 0;

    // Se foi desativado E o usuário confirmou a limpeza retroativa
    if (!ativo && limparRetroativo) {
      const todosCasos = fsListarTodos_(SCHEMA.FS.CASOS);
      const casosAlvo = todosCasos.filter(function (c) {
        if (!c.setor) return false;
        if (_normalizarSetorComparacao_(c.setor) !== chaveAlvo) return false;
        // Apenas não triados (PENDENTE TRIAGEM)
        const st = String(c.status || '').trim().toUpperCase();
        const pendente = (st === String(SCHEMA.STATUS.TRIAGEM).toUpperCase()) || (st === 'PENDENTE TRIAGEM');
        if (!pendente) return false;
        // Apenas gatilhos de Busca Ativa (preserva Demanda Espontânea)
        if (String(c.tipo || '').trim().toUpperCase() === 'DE') return false;
        return true;
      });

      if (casosAlvo.length > 0) {
        const idsAlvo = casosAlvo.map(function (c) { return String(c._id || c.id).trim(); });

        // 1. Grava lápides anti-ressurreição em CASOS_EXCLUIDOS
        const lapides = casosAlvo.map(function (c) {
          const id = String(c._id || c.id).trim();
          return {
            id: id,
            dados: {
              id: id,
              motivo: 'Limpeza retroativa: setor "' + setorLimpo + '" desativado',
              excluidoPor: __emailSessaoAtual || 'ADMIN',
              excluidoEm: new Date(),
              tipoOriginal: String(c.tipo || 'BA'),
              statusOriginal: String(c.status || SCHEMA.STATUS.TRIAGEM)
            }
          };
        });

        try {
          fsBatchSet_(SCHEMA.FS.CASOS_EXCLUIDOS, lapides);
        } catch (eLapide) {
          console.warn('Falha ao gravar lápides em lote: ' + eLapide.message);
        }

        // 2. Apaga do Firestore
        try {
          fsBatchDelete_(SCHEMA.FS.CASOS, idsAlvo);
          apagadosFs = idsAlvo.length;
        } catch (eBatch) {
          idsAlvo.forEach(function (id) {
            try {
              fsDeleteDoc_(SCHEMA.FS.CASOS, id);
              apagadosFs++;
            } catch (eUnit) {
              falhasFs++;
            }
          });
        }

        // 3. Remove linhas espelho do Sheets
        try {
          const planilha = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SCHEMA.ABAS.CASOS);
          if (planilha) {
            linhasSheet = _removerLinhasPlanilhaPorIds_(planilha, new Set(idsAlvo));
          }
        } catch (eSheet) {
          console.warn('Falha ao remover linhas do espelho Sheets: ' + eSheet.message);
        }

        // 4. Invalida cache do Kanban
        invalidarCasosCache_();

        fsRegistrarLog_('SETOR_DESATIVADO_COM_LIMPEZA', setorLimpo,
          'Setor desativado e ' + apagadosFs + ' gatilho(s) não triado(s) removidos retroativamente (' +
          falhasFs + ' falhas, ' + linhasSheet + ' linhas Sheets) | Por: ' + __emailSessaoAtual);
      } else {
        fsRegistrarLog_('SETOR_DESATIVADO', setorLimpo,
          'Setor desativado com limpeza retroativa, porém nenhum gatilho não triado foi encontrado | Por: ' + __emailSessaoAtual);
      }
    } else if (!ativo) {
      fsRegistrarLog_('SETOR_DESATIVADO', setorLimpo,
        'Setor desativado (gatilhos existentes preservados) | Por: ' + __emailSessaoAtual);
    } else {
      fsRegistrarLog_('SETOR_ATIVADO', setorLimpo,
        'Varredura do setor ativada | Por: ' + __emailSessaoAtual);
    }

    let mensagem = ativo
      ? ('Varredura do setor "' + setorLimpo + '" ativada.')
      : (limparRetroativo
          ? (apagadosFs > 0
              ? ('Setor "' + setorLimpo + '" desativado. ' + apagadosFs + ' gatilho(s) não triado(s) removido(s) retroativamente.')
              : ('Setor "' + setorLimpo + '" desativado. Não havia gatilhos não triados pendentes neste setor.'))
          : ('Setor "' + setorLimpo + '" desativado. Gatilhos existentes foram mantidos.'));

    return {
      sucesso: true,
      ativo: !!ativo,
      setor: setorLimpo,
      apagados: apagadosFs,
      falhas: falhasFs,
      linhasSheet: linhasSheet,
      mensagem: mensagem
    };
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
                           'problemas_adicionais', 'unidade_intervalo',
                           // Melhoria UCUM/VigiFlow
                           'dose_unidade',
                           // G.k.4.r.9.1 — apresentação (era texto livre)
                           'forma_farmaceutica'];

    let salvos = 0;
    const recusadas = [];
    Object.entries(listas).forEach(function (par) {
      const campo  = String(par[0] || '').trim();
      const opcoes = par[1];
      if (!camposValidos.includes(campo)) return;
      if (!Array.isArray(opcoes))         return;

      const opcoesLimpas = opcoes.map(function (o) { return String(o || '').trim(); })
                                 .filter(Boolean);

      // Unidade da Dose alimenta doseQuantity/@unit (PQ, UCUM estrito). Uma
      // opção sem tradução no DOSE_UNIDADE_MAP vaza como token inválido para
      // o XML e o VigiFlow descarta a posologia — silenciosamente, porque o
      // E2b.gs por decisão de projeto não fabrica fallback. Foi exatamente
      // assim que "GOTAS" entrou. Recusa aqui, na origem, em vez de deixar
      // quebrar meses depois na importação do VigiMed.
      if (campo === 'dose_unidade') {
        const semMapa = _unidadesDoseSemMapa_(opcoesLimpas);
        if (semMapa.length) {
          recusadas.push('dose_unidade (sem equivalente UCUM: ' + semMapa.join(', ') + ')');
          return;
        }
      }

      fsSetDoc_(SCHEMA.FS.LISTAS, campo, { campo: campo, opcoes: opcoesLimpas });
      salvos++;
    });

    if (recusadas.length) {
      invalidarConfig();
      fsRegistrarLog_('LISTAS_RECUSADAS', 'listas',
        recusadas.join(' | ') + ' | Por: ' + __emailSessaoAtual);
      return {
        sucesso: false,
        mensagem: 'Lista recusada — ' + recusadas.join(' | ') +
                  '. Cadastre o equivalente UCUM em SCHEMA.E2B.DOSE_UNIDADE_MAP ' +
                  '(Schema.gs) antes de adicionar a unidade aqui, senão o ' +
                  'VigiMed descarta a posologia do caso.'
      };
    }

    invalidarConfig();
    fsRegistrarLog_('LISTAS_ATUALIZADAS', 'listas',
      salvos + ' lista(s) salvas | Por: ' + __emailSessaoAtual);

    return { sucesso: true, mensagem: salvos + ' lista(s) salvas com sucesso.' };
  });
}

/**
 * Devolve as opções de Unidade da Dose que NÃO têm equivalente UCUM em
 * SCHEMA.E2B.DOSE_UNIDADE_MAP. O lookup em E2b.gs faz .toUpperCase() antes de
 * consultar o mapa, então a comparação aqui usa a mesma chave — o que também
 * significa que diferença só de caixa ("ML" vs "mL") não é problema.
 * @param {string[]} opcoes
 * @returns {string[]} opções órfãs (vazio = tudo mapeado)
 */
function _unidadesDoseSemMapa_(opcoes) {
  const mapa = (SCHEMA.E2B && SCHEMA.E2B.DOSE_UNIDADE_MAP) || {};
  return opcoes.filter(function (o) {
    return !Object.prototype.hasOwnProperty.call(mapa, String(o).toUpperCase());
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GATILHOS (medicamentos monitorados pelo ETL) — Firestore SOMENTE (Fase 9)
// ─────────────────────────────────────────────────────────────────────────────

// PERF: mesmo raciocínio de USUARIOS_CACHE_KEY (Admin.gs) — a aba Gatilhos e
// a Visão Geral do painel Admin relistam a coleção inteira a cada abertura.
// TTL curto, invalidado nas próprias mutações abaixo.
const GATILHOS_CACHE_KEY = 'ADMIN_GATILHOS_V1';
const GATILHOS_CACHE_SEG = 30;

function _invalidarCacheGatilhos_() {
  CacheService.getScriptCache().remove(GATILHOS_CACHE_KEY);
}

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
    const cache = CacheService.getScriptCache();
    const hit = cache.get(GATILHOS_CACHE_KEY);
    if (hit) {
      try { return JSON.parse(hit); } catch (e) { /* cache corrompido: relê abaixo */ }
    }

    try {
      const docs = fsListarTodos_(SCHEMA.FS.GATILHOS);
      const resultado = docs
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

      try { cache.put(GATILHOS_CACHE_KEY, JSON.stringify(resultado), GATILHOS_CACHE_SEG); } catch (e) {}
      return resultado;
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
    _invalidarCacheGatilhos_();

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
    _invalidarCacheGatilhos_();

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
    _invalidarCacheGatilhos_();

    fsRegistrarLog_('GATILHO_EXCLUIDO', 'N/A',
      (existente.medicamento || docId) + ' | Por: ' + __emailSessaoAtual);

    return { sucesso: true, mensagem: 'Gatilho excluído com sucesso.' };
  });
}
