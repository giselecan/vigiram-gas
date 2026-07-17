/**
 * @fileoverview Admin.gs — Gerenciamento de usuários (somente ADMIN). Fase 4: Firestore.
 *
 * Todas as funções exigem token válido + perfil ADMIN verificado server-side.
 * A senha nunca trafega em texto puro para o frontend — só o hash é armazenado.
 * MIGRAÇÃO: fonte de dados unificada com Auth.gs — 100% Firestore (SCHEMA.FS.USUARIOS).
 * Elimina a divergência anterior em que este arquivo ainda gravava em DB_Usuarios
 * (Sheets) enquanto Auth.gs já lia de Firestore — causa raiz de login falhando
 * para usuários criados/alterados via painel Admin após a Fase 4.
 *
 * CORREÇÃO (auditoria_qa_datas_tipagem_2026-07-13.md #6): a auditoria das
 * ações deste arquivo usava registrarLog_() (Audit.gs — grava só no Sheets,
 * com Date real). Todo o resto do sistema já usa fsRegistrarLog_()
 * (Firestore.gs — grava no Firestore e espelha no Sheets como string
 * formatada via Mirror.gs). Isso fazia a coluna de data de DB_Log misturar
 * dois tipos diferentes (Date real vs. string) dependendo de quem escreveu
 * a linha. Trocado para fsRegistrarLog_() — mesmo padrão do resto do sistema.
 *
 * Funções expostas ao frontend (google.script.run):
 *   listarUsuarios(token)                        → array de objetos (sem senha)
 *   criarUsuario(dados, token)                   → { sucesso, mensagem }
 *   editarUsuario(dados, token)                  → { sucesso, mensagem }
 *   trocarSenhaUsuario(email, novaSenha, token)  → { sucesso, mensagem }
 *   alterarStatusUsuario(email, ativo, token)    → { sucesso, mensagem }
 *   listarLogsAuditoria(token, limite)           → array de { data, usuario, acao, idCaso, detalhe }
 *
 * SETORES DO USUÁRIO (cadastro/edição):
 *   `dados.setores` (array de nomes de setor) grava a lista no próprio
 *   documento do usuário E espelha em SCHEMA.FS.SETORES (farmaceuticoResponsavel/
 *   emailResponsavel = nome/e-mail do usuário), via _sincronizarSetoresUsuario_.
 *   Isso elimina a digitação manual e duplicada do nome do farmacêutico na
 *   aba "Setores" — o nome migra automaticamente a partir do cadastro do
 *   usuário. Como o ID do documento em SETORES é setor+e-mail (_idDocSetor_,
 *   Utils.gs), múltiplos usuários podem ser responsáveis pelo mesmo setor
 *   sem que um sobrescreva o outro.
 */

// ─────────────────────────────────────────────────────────────────────────────
// GUARD — verifica token E perfil ADMIN antes de qualquer operação
// ─────────────────────────────────────────────────────────────────────────────
function _comAdmin_(token, operacao) {
  return comAutenticacao_(token, function () {
    const usuario = fsGetDoc_(SCHEMA.FS.USUARIOS, __emailSessaoAtual);
    const perfil = usuario ? String(usuario.perfil || '').trim().toUpperCase() : '';
    if (perfil !== 'ADMIN') {
      throw new Error('Acesso negado. Apenas administradores podem executar esta ação.');
    }
    return operacao();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LEITURA
// ─────────────────────────────────────────────────────────────────────────────

// PERF: painel Admin relista os usuários a cada abertura da aba "Usuários"
// (e da "Visão Geral", que também consome listarUsuarios) — sem cache, cada
// uma dessas aberturas refazia um fsListarTodos_ (varredura completa da
// coleção) mesmo que ninguém tenha mexido em nenhum usuário nesse meio-tempo.
// TTL curto (30s, bem menor que o de getConfig_) porque a lista muda mais
// (criar/editar/ativar-desativar) — invalidado nas próprias mutações abaixo,
// então nunca fica visivelmente desatualizado após uma ação do próprio admin.
const USUARIOS_CACHE_KEY = 'ADMIN_USUARIOS_V1';
const USUARIOS_CACHE_SEG = 30;

function _invalidarCacheUsuarios_() {
  CacheService.getScriptCache().remove(USUARIOS_CACHE_KEY);
}

/**
 * Lista todos os usuários sem expor a coluna de senha.
 * @returns {Array<{email,nome,ativo,perfil}>}
 */
function listarUsuarios(token) {
  return _comAdmin_(token, function () {
    const cache = CacheService.getScriptCache();
    const hit = cache.get(USUARIOS_CACHE_KEY);
    if (hit) {
      try { return JSON.parse(hit); } catch (e) { /* cache corrompido: relê abaixo */ }
    }

    const docs = fsListarTodos_(SCHEMA.FS.USUARIOS);
    const usuarios = docs
      .filter(function (u) { return u.email; })
      .map(function (u) {
        return {
          email:  String(u.email || '').trim(),
          nome:   String(u.nome || '').trim(),
          // CORREÇÃO (auditoria_qa_datas_tipagem_2026-07-13.md #7): u.ativo
          // pode vir como boolean (novo padrão) ou string legada — normaliza
          // via _ativoComoBooleano_ antes de reconverter para o contrato
          // 'SIM'/'NÃO' que o frontend (js_admin.html) já consome.
          ativo:  _ativoComoBooleano_(u.ativo) ? 'SIM' : 'NÃO',
          perfil: String(u.perfil || '').trim().toUpperCase(),
          setores: Array.isArray(u.setores) ? u.setores : []
        };
      });

    try { cache.put(USUARIOS_CACHE_KEY, JSON.stringify(usuarios), USUARIOS_CACHE_SEG); } catch (e) {}
    return usuarios;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CRIAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cria um novo usuário já com senha em hash.
 * @param {{email,nome,senha,perfil,setores?}} dados
 */
function criarUsuario(dados, token) {
  return _comAdmin_(token, function () {
    const email  = String(dados.email  || '').trim().toLowerCase();
    const nome   = String(dados.nome   || '').trim().toUpperCase();
    const senha  = String(dados.senha  || '').trim();
    const perfil = String(dados.perfil || 'FARMACEUTICO').trim().toUpperCase();
    const setores = _normalizarSetoresLista_(dados.setores);

    if (!email || !nome || !senha) {
      return { sucesso: false, mensagem: 'E-mail, nome e senha são obrigatórios.' };
    }
    // Defesa em profundidade: e-mail vira ID do documento (usado depois em
    // atributos data-* no admin) e chave de e-mails automáticos — bloqueia
    // formato inválido/anômalo na origem, além do fix de XSS no front-end.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { sucesso: false, mensagem: 'E-mail em formato inválido.' };
    }
    if (senha.length < 8) {
      return { sucesso: false, mensagem: 'Senha deve ter ao menos 8 caracteres.' };
    }

    // Leitura direta por ID — O(1) no Firestore, sem varredura de coleção.
    const existente = fsGetDoc_(SCHEMA.FS.USUARIOS, email);
    if (existente) {
      return { sucesso: false, mensagem: 'E-mail já cadastrado.' };
    }

    const hashSenha = gerarHashArmazenavel_(senha);
    fsSetDoc_(SCHEMA.FS.USUARIOS, email, {
      email: email,
      senhaHash: hashSenha,
      nome: nome,
      ativo: true, // CORREÇÃO #7: boolean a partir de agora, não mais 'SIM'
      perfil: perfil,
      setores: setores
    });

    _sincronizarSetoresUsuario_(email, nome, [], setores);
    _invalidarCacheUsuarios_();

    fsRegistrarLog_('ADMIN_CRIAR_USUARIO', email, `Criado por ${__emailSessaoAtual} — perfil: ${perfil}`);
    return { sucesso: true, mensagem: `Usuário "${nome}" criado com sucesso.` };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EDIÇÃO (ADMIN)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Edita nome, perfil e/ou setores de um usuário já cadastrado. E-mail não
 * pode ser alterado (é o ID do documento). Senha é trocada só por
 * trocarSenhaUsuario().
 * @param {{email,nome,perfil,setores?}} dados
 */
function editarUsuario(dados, token) {
  return _comAdmin_(token, function () {
    const email = String((dados && dados.email) || '').trim().toLowerCase();
    const nome  = String((dados && dados.nome)   || '').trim().toUpperCase();
    const perfil = String((dados && dados.perfil) || '').trim().toUpperCase();
    const setores = _normalizarSetoresLista_(dados && dados.setores);

    if (!email || !nome || !perfil) {
      return { sucesso: false, mensagem: 'Nome e perfil são obrigatórios.' };
    }

    const existente = fsGetDoc_(SCHEMA.FS.USUARIOS, email);
    if (!existente) return { sucesso: false, mensagem: 'Usuário não encontrado.' };

    const setoresAntigos = Array.isArray(existente.setores) ? existente.setores : [];

    fsUpdateDoc_(SCHEMA.FS.USUARIOS, email, {
      nome: nome,
      perfil: perfil,
      setores: setores
    });

    _sincronizarSetoresUsuario_(email, nome, setoresAntigos, setores);
    _invalidarCacheUsuarios_();

    fsRegistrarLog_('ADMIN_EDITAR_USUARIO', email, `Alterado por ${__emailSessaoAtual} — perfil: ${perfil}`);
    return { sucesso: true, mensagem: `Usuário "${nome}" atualizado com sucesso.` };
  });
}

/** Limpa/dedup a lista de nomes de setor recebida do frontend. */
function _normalizarSetoresLista_(setores) {
  if (!Array.isArray(setores)) return [];
  const vistos = {};
  const limpos = [];
  setores.forEach(function (s) {
    const nome = String(s || '').trim().toUpperCase();
    if (!nome || vistos[nome]) return;
    vistos[nome] = true;
    limpos.push(nome);
  });
  return limpos;
}

/**
 * Mantém a coleção SCHEMA.FS.SETORES em sincronia com os setores atribuídos
 * a um usuário: cria/atualiza um documento (setor+e-mail deste usuário) para
 * cada setor atribuído, com farmaceuticoResponsavel/emailResponsavel = dados
 * do usuário — e remove só os documentos deste MESMO usuário para setores
 * que saíram da lista (nunca mexe no documento de outro responsável do
 * mesmo setor, já que o ID inclui o e-mail — ver _idDocSetor_ em Utils.gs).
 * @param {string} email
 * @param {string} nome
 * @param {string[]} setoresAntigos
 * @param {string[]} setoresNovos
 */
function _sincronizarSetoresUsuario_(email, nome, setoresAntigos, setoresNovos) {
  const novosSet = {};
  setoresNovos.forEach(function (setor) {
    novosSet[setor] = true;
    fsSetDoc_(SCHEMA.FS.SETORES, _idDocSetor_(setor, email), {
      setor: setor,
      ativo: true,
      farmaceuticoResponsavel: nome,
      emailResponsavel: email
    });
  });

  setoresAntigos.forEach(function (setor) {
    if (novosSet[setor]) return; // continua atribuído, não remove
    fsDeleteDoc_(SCHEMA.FS.SETORES, _idDocSetor_(setor, email));
  });

  if (setoresNovos.length || setoresAntigos.length) invalidarConfig();
}

// ─────────────────────────────────────────────────────────────────────────────
// TROCA DE SENHA (ADMIN)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Redefine a senha de qualquer usuário (somente ADMIN).
 * @param {string} email
 * @param {string} novaSenha
 */
function trocarSenhaUsuario(email, novaSenha, token) {
  return _comAdmin_(token, function () {
    const emailAlvo = String(email     || '').trim().toLowerCase();
    const senha      = String(novaSenha || '').trim();

    if (!emailAlvo || !senha) {
      return { sucesso: false, mensagem: 'E-mail e nova senha são obrigatórios.' };
    }
    if (senha.length < 8) {
      return { sucesso: false, mensagem: 'Senha deve ter ao menos 8 caracteres.' };
    }

    const existente = fsGetDoc_(SCHEMA.FS.USUARIOS, emailAlvo);
    if (!existente) return { sucesso: false, mensagem: 'Usuário não encontrado.' };

    fsUpdateDoc_(SCHEMA.FS.USUARIOS, emailAlvo, {
      senhaHash: gerarHashArmazenavel_(senha)
    });

    fsRegistrarLog_('ADMIN_TROCAR_SENHA', emailAlvo, `Alterado por ${__emailSessaoAtual}`);
    return { sucesso: true, mensagem: `Senha de "${emailAlvo}" atualizada.` };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ATIVAR / DESATIVAR (ADMIN)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Alterna o status ATIVO/INATIVO de um usuário.
 * Impede que o ADMIN desative a própria conta.
 * @param {string} email
 * @param {boolean} ativo
 */
function alterarStatusUsuario(email, ativo, token) {
  return _comAdmin_(token, function () {
    const emailAlvo = String(email || '').trim().toLowerCase();

    if (emailAlvo === __emailSessaoAtual.toLowerCase()) {
      return { sucesso: false, mensagem: 'Você não pode desativar sua própria conta.' };
    }

    const existente = fsGetDoc_(SCHEMA.FS.USUARIOS, emailAlvo);
    if (!existente) return { sucesso: false, mensagem: 'Usuário não encontrado.' };

    // CORREÇÃO #7: grava boolean direto, não mais 'SIM'/'NÃO'.
    fsUpdateDoc_(SCHEMA.FS.USUARIOS, emailAlvo, { ativo: !!ativo });
    _invalidarCacheUsuarios_();

    fsRegistrarLog_(
      ativo ? 'ADMIN_ATIVAR_USUARIO' : 'ADMIN_DESATIVAR_USUARIO',
      emailAlvo,
      `Alterado por ${__emailSessaoAtual}`
    );
    return { sucesso: true, mensagem: `Usuário "${emailAlvo}" ${ativo ? 'ativado' : 'desativado'}.` };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGS E AUDITORIA (somente leitura)
// ─────────────────────────────────────────────────────────────────────────────

// PERF: listarLogsAuditoria é chamada toda vez que a "Visão Geral" (limite=6)
// ou a aba "Logs e Auditoria" (limite=300) do painel Admin abre. Sem cache,
// isso também repete o pior caso — o fallback de fsListarTodos_ (varredura
// da coleção INTEIRA de logs, que só cresce, ordenando em memória) sempre
// que a query ordenada não devolver exatamente `max` docs (índice ausente
// ou algum doc sem o campo `data`). TTL curto: é uma trilha de auditoria
// (não precisa ser 100% em tempo real) e o botão "Atualizar" da aba Logs
// ainda funciona — só mostra a mesma foto de até LOGS_CACHE_SEG segundos
// atrás em vez de reprocessar tudo de novo a cada clique. Chave por `max`
// porque Visão Geral e a aba Logs pedem quantidades diferentes.
const LOGS_CACHE_PREFIXO = 'ADMIN_LOGS_';
const LOGS_CACHE_SEG     = 20;

/**
 * Lista os registros mais recentes da coleção Firestore SCHEMA.FS.LOG
 * (trilha de auditoria), ordenados do mais novo para o mais antigo.
 * @param {number=} limite - máximo de registros retornados (padrão 200, teto 500)
 * @returns {Array<{data, usuario, acao, idCaso, detalhe}>}
 */
function listarLogsAuditoria(token, limite) {
  return _comAdmin_(token, function () {
    const max = Math.min(Number(limite) || 200, 500);
    const cache = CacheService.getScriptCache();
    const chaveCache = LOGS_CACHE_PREFIXO + max;
    const hit = cache.get(chaveCache);
    if (hit) {
      try { return JSON.parse(hit); } catch (e) { /* cache corrompido: relê abaixo */ }
    }

    // Caminho rápido: ordena e limita no SERVIDOR (orderBy data desc + limit) —
    // traz só os `max` mais recentes em um round-trip, sem paginar a coleção
    // inteira. PORÉM o orderBy do Firestore (a) EXCLUI docs que não têm o campo
    // `data` e (b) FALHA se o índice do campo não existir. Em qualquer um dos
    // casos os logs sumiam do painel. Fallback: varre a coleção e ordena em
    // memória, garantindo que a auditoria sempre apareça.
    // A query ordenada só é confiável quando devolve exatamente `max` docs —
    // se vier incompleta (menos que o pedido), tanto pode ser porque a
    // coleção tem menos que `max` registros no total, quanto porque o
    // orderBy excluiu docs sem o campo `data` (ver comentário acima); em
    // ambos os casos caímos no fallback, que é barato justamente quando a
    // ordenada devolve poucos resultados.
    let docs = null;
    try {
      docs = fsQuery_(SCHEMA.FS.LOG, null, max, [{ campo: 'data', direcao: 'DESCENDING' }]);
    } catch (e) {
      console.error('listarLogsAuditoria: query ordenada falhou (índice ausente?), usando fallback — ' + e.message);
    }
    if (!docs || docs.length < max) {
      docs = fsListarTodos_(SCHEMA.FS.LOG)
        .sort(function (a, b) {
          const da = a.data ? new Date(a.data).getTime() : 0;
          const db = b.data ? new Date(b.data).getTime() : 0;
          return db - da; // mais recentes primeiro
        })
        .slice(0, max);
    }
    const resultado = docs.map(function (d) {
      return {
        data:    dataParaIsoSegura_(d.data),
        usuario: String(d.usuario || '').trim(),
        acao:    String(d.acao    || '').trim(),
        idCaso:  String(d.idCaso  || '').trim(),
        detalhe: String(d.detalhe || '').trim()
      };
    });

    try { cache.put(chaveCache, JSON.stringify(resultado), LOGS_CACHE_SEG); } catch (e) {}
    return resultado;
  });
}
