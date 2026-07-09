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
 * Funções expostas ao frontend (google.script.run):
 *   listarUsuarios(token)                        → array de objetos (sem senha)
 *   criarUsuario(dados, token)                   → { sucesso, mensagem }
 *   trocarSenhaUsuario(email, novaSenha, token)  → { sucesso, mensagem }
 *   alterarStatusUsuario(email, ativo, token)    → { sucesso, mensagem }
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

/**
 * Lista todos os usuários sem expor a coluna de senha.
 * @returns {Array<{email,nome,ativo,perfil}>}
 */
function listarUsuarios(token) {
  return _comAdmin_(token, function () {
    const docs = fsListarTodos_(SCHEMA.FS.USUARIOS);
    return docs
      .filter(function (u) { return u.email; })
      .map(function (u) {
        return {
          email:  String(u.email || '').trim(),
          nome:   String(u.nome || '').trim(),
          ativo:  String(u.ativo || 'SIM').trim().toUpperCase(),
          perfil: String(u.perfil || '').trim().toUpperCase()
        };
      });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CRIAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cria um novo usuário já com senha em hash.
 * @param {{email,nome,senha,perfil}} dados
 */
function criarUsuario(dados, token) {
  return _comAdmin_(token, function () {
    const email  = String(dados.email  || '').trim().toLowerCase();
    const nome   = String(dados.nome   || '').trim();
    const senha  = String(dados.senha  || '').trim();
    const perfil = String(dados.perfil || 'FARMACEUTICO').trim().toUpperCase();

    if (!email || !nome || !senha) {
      return { sucesso: false, mensagem: 'E-mail, nome e senha são obrigatórios.' };
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
      ativo: 'SIM',
      perfil: perfil
    });

    registrarLog_('ADMIN_CRIAR_USUARIO', email, `Criado por ${__emailSessaoAtual} — perfil: ${perfil}`);
    return { sucesso: true, mensagem: `Usuário "${nome}" criado com sucesso.` };
  });
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

    registrarLog_('ADMIN_TROCAR_SENHA', emailAlvo, `Alterado por ${__emailSessaoAtual}`);
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
 * @param {boolean} ativo — true = SIM, false = NÃO
 */
function alterarStatusUsuario(email, ativo, token) {
  return _comAdmin_(token, function () {
    const emailAlvo = String(email || '').trim().toLowerCase();

    if (emailAlvo === __emailSessaoAtual.toLowerCase()) {
      return { sucesso: false, mensagem: 'Você não pode desativar sua própria conta.' };
    }

    const existente = fsGetDoc_(SCHEMA.FS.USUARIOS, emailAlvo);
    if (!existente) return { sucesso: false, mensagem: 'Usuário não encontrado.' };

    const novoStatus = ativo ? 'SIM' : 'NÃO';
    fsUpdateDoc_(SCHEMA.FS.USUARIOS, emailAlvo, { ativo: novoStatus });

    registrarLog_(
      ativo ? 'ADMIN_ATIVAR_USUARIO' : 'ADMIN_DESATIVAR_USUARIO',
      emailAlvo,
      `Alterado por ${__emailSessaoAtual}`
    );
    return { sucesso: true, mensagem: `Usuário "${emailAlvo}" ${ativo ? 'ativado' : 'desativado'}.` };
  });
}
