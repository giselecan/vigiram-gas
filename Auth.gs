/**
 * @fileoverview Auth.gs — Autenticação, sessão e identidade (Fase 4: Firestore).
 *
 * MIGRAÇÃO: fonte de dados de DB_Usuarios trocada de Sheets para Firestore
 * (coleção SCHEMA.FS.USUARIOS, ID do documento = e-mail em minúsculas).
 * A ASSINATURA PÚBLICA NÃO MUDA: autenticarUsuario(), encerrarSessao(),
 * comAutenticacao_(), listarUsuarios(), criarUsuario() etc. continuam com
 * os mesmos parâmetros e retornos. Frontend (js_core.html) não muda nada.
 *
 * O QUE NÃO MUDA (continua exatamente igual):
 *   - Sessão/token via CacheService (não depende de Sheets nem Firestore).
 *   - Hash salgado SHA-256, upgrade transparente de senha legada em texto puro.
 *   - comparacaoSegura_ (tempo constante) — depende de Security.gs, inalterado.
 *   - __emailSessaoAtual e toda a cadeia de auditoria.
 *
 * ROLLBACK: DB_Usuarios no Sheets não foi alterada pela migração (Fase 3 só
 * copiou os dados) — restaurar a versão anterior deste arquivo é suficiente.
 *
 * Depende de Security.gs (comparacaoSegura_, bytesParaHex_) e Firestore.gs
 * (fsGetDoc_, fsUpdateDoc_, fsSetDoc_, fsListarTodos_).
 */

// Contexto da requisição: e-mail do usuário autenticado via token.
var __emailSessaoAtual = null;

const _SESSAO_PREFIXO  = 'VIGI_SESSAO_';
const _SESSAO_TTL_SEG  = 21600; // 6h (máximo do GAS) — inalterado

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────────────────────────────────────
function autenticarUsuario(email, senha) {
  const emailNormalizado = String(email || '').trim().toLowerCase();
  try {
    _hashSecurityGISELE_();
    const usuario = fsGetDoc_(SCHEMA.FS.USUARIOS, emailNormalizado);

    if (!usuario) {
      _registrarLogin_(emailNormalizado, false, 'Usuário não encontrado');
      return { sucesso: false, erro: 'Credenciais inválidas.' };
    }

    const senhaDb = String(usuario.senhaHash || '').trim();

    const res = verificarSenha_(senha, senhaDb);
    if (!res.ok) {
      _registrarLogin_(emailNormalizado, false, 'Senha incorreta');
      return { sucesso: false, erro: 'Credenciais inválidas.' };
    }

    // CORREÇÃO (auditoria_qa_datas_tipagem_2026-07-13.md #7): usuarios.ativo
    // está em transição de string ('SIM'/'NÃO') para boolean — _ativoComoBooleano_
    // (Utils.gs) aceita os dois formatos, então o login continua funcionando
    // para contas gravadas antes OU depois da correção, sem precisar migrar
    // nada primeiro.
    if (!_ativoComoBooleano_(usuario.ativo)) {
      _registrarLogin_(emailNormalizado, false, 'Usuário inativo');
      return { sucesso: false, erro: 'Usuário inativo. Contate o administrador.' };
    }

    // Upgrade transparente de senha legada (texto puro → hash) — mesma lógica,
    // agora gravando via fsUpdateDoc_ em vez de planilha.getRange().setValue().
    if (res.precisaUpgrade) {
      try {
        fsUpdateDoc_(SCHEMA.FS.USUARIOS, emailNormalizado, {
          senhaHash: gerarHashArmazenavel_(senha)
        });
      } catch (e) {
        console.warn('Falha ao migrar senha para hash: ' + e.message);
      }
    }

    const token  = Utilities.getUuid();
    const nome   = String(usuario.nome || '').trim();
    const perfil = String(usuario.perfil || 'FARMACEUTICO').trim().toUpperCase();

    CacheService.getScriptCache().put(_SESSAO_PREFIXO + token, emailNormalizado, _SESSAO_TTL_SEG);

    // Log de login feito por ÚLTIMO, com o payload de sucesso já pronto para
    // retorno — fsRegistrarLog_ é best-effort (try/catch próprio + fila de
    // retry no Mirror.gs), então nunca atrasa/bloqueia a resposta do login.
    _registrarLogin_(emailNormalizado, true, 'Login bem-sucedido');
    return { sucesso: true, token: token, nome: nome, perfil: perfil };

} catch (erro) {
    const msg = String(erro && erro.message || erro);
    console.error('autenticarUsuario falhou:', msg, 'Stack:', erro && erro.stack);
    _registrarLogin_(emailNormalizado, false, 'Erro: ' + msg);

    // Distingue falha de infraestrutura (Firestore/Service Account/config
    // ausente) de erro de negócio comum — evita expor stack cru ao usuário
    // e dá pista acionável de diagnóstico.
    if (msg.indexOf('Firestore.gs') !== -1 || msg.indexOf('OAuth2') !== -1 || msg.indexOf('Script Properties') !== -1) {
      return {
        sucesso: false,
        erro: 'Sistema de autenticação indisponível no momento. Contate o administrador (falha de conexão com o banco de identidade).'
      };
    }
    // Mensagem genérica ao usuário — o detalhe técnico (msg/stack) já foi
    // logado acima (console.error) e no log de auditoria (_registrarLogin_),
    // então nada se perde para diagnóstico; só não vaza para a tela de login.
    return { sucesso: false, erro: 'Não foi possível concluir o login. Tente novamente ou contate o administrador.' };
  }
}

/**
 * Log de tentativa de login (sucesso ou falha) — Firestore (fonte da
 * verdade) + appendRow best-effort em Sheets (ver fsRegistrarLog_/Mirror.gs).
 * Nunca lança: uma falha ao registrar o log não pode derrubar o login.
 */
function _registrarLogin_(email, sucesso, detalhe) {
  try {
    // Passa o e-mail explicitamente como usuarioOverride: login não passa por
    // comAutenticacao_ (ainda não há sessão), então usuarioAtual_() cairia na
    // global __emailSessaoAtual, que pode estar carimbada por OUTRA execução
    // concorrente (ex.: uma ação autenticada de outro usuário em andamento) —
    // era esse o bug de logins aparecendo registrados sob a conta errada.
    fsRegistrarLog_(sucesso ? 'LOGIN_SUCESSO' : 'LOGIN_FALHA', 'N/A',
      (email || 'e-mail não informado') + ' — ' + detalhe,
      email || 'e-mail não informado');
  } catch (e) {
    console.error('_registrarLogin_: falha ao registrar log de login — ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSÃO / TOKEN — inalterado (CacheService, não depende de Sheets/Firestore)
// ─────────────────────────────────────────────────────────────────────────────

/** Retorna o e-mail vinculado ao token, ou null se inválido/expirado. */
function getEmailDoToken_(token) {
  if (!token) return null;
  return CacheService.getScriptCache().get(_SESSAO_PREFIXO + token) || null;
}

/** True se o token é válido e ativo. */
function validarToken_(token) {
  return !!getEmailDoToken_(token);
}

/**
 * Middleware de rotas privadas. Publica o e-mail do usuário em
 * __emailSessaoAtual durante a execução da operação (para a auditoria).
 */
function comAutenticacao_(token, operacao) {
  const email = getEmailDoToken_(token);
  if (!email) {
    throw new Error('Sessão expirada ou não autorizada. Por favor, faça login novamente.');
  }
  const anterior = __emailSessaoAtual;
  __emailSessaoAtual = email;
  try {
    return operacao();
  } finally {
    __emailSessaoAtual = anterior;
  }
}

/** Invalida a sessão no servidor (chamado pelo logout do frontend). */
function encerrarSessao(token) {
  if (token) CacheService.getScriptCache().remove(_SESSAO_PREFIXO + token);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// SENHAS — HASH SALGADO — inalterado (depende só de Utilities/Security.gs)
// ─────────────────────────────────────────────────────────────────────────────

/** Gera salt hex de 128 bits a partir de UUID. */
function gerarSaltHex_() {
  return Utilities.getUuid().replace(/-/g, '');
}

/** SHA-256 de (saltHex + ":" + senha) → hex. */
function hashSenha_(senha, saltHex) {
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    saltHex + ':' + String(senha),
    Utilities.Charset.UTF_8
  );
  return bytesParaHex_(raw); // Security.gs
}

/** Monta o valor armazenável: "sha256$<salt>$<hash>". */
function gerarHashArmazenavel_(senha) {
  const salt = gerarSaltHex_();
  return 'sha256$' + salt + '$' + hashSenha_(senha, salt);
}

/**
 * Verifica a senha contra o valor armazenado.
 * @returns {{ok:boolean, precisaUpgrade:boolean}}
 */
function verificarSenha_(senhaDigitada, armazenado) {
  const valor = String(armazenado || '');

  if (valor.indexOf('sha256$') === 0) {
    const partes = valor.split('$');
    if (partes.length !== 3) return { ok: false, precisaUpgrade: false };
    const salt      = partes[1];
    const hashArmaz = partes[2];
    const hashCalc  = hashSenha_(senhaDigitada, salt);
    return { ok: comparacaoSegura_(hashCalc, hashArmaz), precisaUpgrade: false };
  }

  // Legado: texto puro (será migrado no login bem-sucedido)
  const ok = comparacaoSegura_(String(senhaDigitada), valor);
  return { ok: ok, precisaUpgrade: ok };
}


// ─────────────────────────────────────────────────────────────────────────────
// [REMOVIDO — deduplicação com Admin.gs]
// listarUsuarios / criarUsuario / trocarSenhaUsuario / alterarStatusUsuario
// existiam DUPLICADAS aqui e em Admin.gs. No GAS todos os .gs compartilham o
// mesmo escopo global: a declaração carregada por último vence SILENCIOSAMENTE
// (ordem de arquivos). Qualquer edição futura numa das cópias podia ser
// sombreada pela outra sem erro nem aviso. As versões canônicas vivem em
// Admin.gs (que já possui o guard _comAdmin_). Nada muda para o frontend.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * [NOVO] Wrapper PÚBLICO de validação de sessão para o frontend.
 *
 * BUG CORRIGIDO: js_core.html chamava google.script.run.validarToken_(token).
 * Funções com sufixo "_" NÃO são invocáveis via google.script.run (restrição
 * documentada do GAS) — a chamada caía SEMPRE no withFailureHandler, que
 * limpava o token do sessionStorage e forçava novo login a cada reload da
 * página, mesmo com sessão válida no CacheService.
 *
 * js_core.html deve passar a chamar: google.script.run.validarSessao(token)
 */
function validarSessao(token) {
  return validarToken_(token);
}
