# RELATÓRIO DE CONSOLIDAÇÃO DE CÓDIGO FONTE

## 📋 Informações do Projeto
- **Sistema/Folha de Cálculo:** VIGIRAM HRN
- **ID do Projeto Script:** `1j-R5Gmu_u7vIWzfdfV3qWVizj6BRu2b_sowoOEdnp4Lk7J5HjLKLzDHR`
- **Compilado em:** 09/07/2026 09:31

---

## 📄 Arquivo [1/32]: Admin.gs

```javascript
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
```

---

## 📄 Arquivo [2/32]: appsscript.json

```json
{
  "timeZone": "America/Sao_Paulo",
  "dependencies": {
    "libraries": [
      {
        "userSymbol": "OAuth2",
        "version": "43",
        "libraryId": "1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF"
      }
    ]
  },
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/script.projects.readonly",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/script.send_mail"
  ],
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE_ANONYMOUS"
  }
}
```

---

## 📄 Arquivo [3/32]: Audit.gs

```javascript
/**
 * @fileoverview Audit.gs — Trilha de auditoria (LGPD).
 *
 * FASE 7 (#1): usuarioAtual_() passou a priorizar o e-mail resolvido do token
 * de sessão (__emailSessaoAtual, publicado por comAutenticacao_ em Auth.gs).
 *
 * Por que isto era necessário: com o Web App em "executar como eu" + acesso
 * anônimo, Session.getActiveUser().getEmail() volta VAZIO para todos. Antes,
 * toda escrita autenticada (triagem/investigação) era carimbada como "sistema",
 * anulando a rastreabilidade. Agora o carimbo reflete o farmacêutico logado.
 *
 * Ordem de prioridade da identidade:
 *   1) e-mail do token (ações do painel autenticado)
 *   2) Session.getActiveUser().getEmail() (caso o deploy o forneça)
 *   3) "sistema" (fallback)
 *
 * Origens explícitas continuam tendo precedência quando passadas diretamente
 * a carimbarAuditoria_(): "ETL" (Ingest) e "Formulário Assistência" (form DE).
 */

/** Retorna o e-mail do usuário atual (token > sessão > "sistema"). */
function usuarioAtual_() {
  if (__emailSessaoAtual) return __emailSessaoAtual;
  try {
    const email = Session.getActiveUser().getEmail();
    return email ? email : 'sistema';
  } catch (e) {
    return 'sistema';
  }
}

/**
 * Carimba auditoria (quem/quando) numa linha do DB_Casos_RAM.
 * @param {Sheet} planilha
 * @param {number} linha - linha 1-based
 * @param {string=} origem - opcional; se ausente, usa usuarioAtual_()
 */
function carimbarAuditoria_(planilha, linha, origem) {
  const quem = origem || usuarioAtual_();
  planilha.getRange(linha, SCHEMA.COL.ATUALIZADO_POR).setValue(quem);
  planilha.getRange(linha, SCHEMA.COL.ATUALIZADO_EM).setValue(new Date());
}

/**
 * Registra um evento na aba de log (se existir). Não interrompe o fluxo
 * principal em caso de erro.
 * @param {string} acao
 * @param {string} idCaso
 * @param {string=} detalhe
 */
function registrarLog_(acao, idCaso, detalhe) {
  try {
    const plan = getSheet_(SCHEMA.ABAS.LOG);
    if (!plan) return; // log é opcional
    plan.appendRow([new Date(), usuarioAtual_(), acao, idCaso || '', detalhe || '']);
  } catch (e) {
    console.error('Falha ao registrar log: ' + e.message);
  }
}
```

---

## 📄 Arquivo [4/32]: Auth.gs

```javascript
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
  try {
    const emailNormalizado = String(email || '').trim().toLowerCase();
    const usuario = fsGetDoc_(SCHEMA.FS.USUARIOS, emailNormalizado);

    if (!usuario) {
      return { sucesso: false, erro: 'Credenciais inválidas.' };
    }

    const senhaDb = String(usuario.senhaHash || '').trim();
    const ativo   = String(usuario.ativo || '').trim().toUpperCase();

    const res = verificarSenha_(senha, senhaDb);
    if (!res.ok) return { sucesso: false, erro: 'Credenciais inválidas.' };

    if (ativo === 'NÃO' || ativo === 'NAO') {
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
    return { sucesso: true, token: token, nome: nome, perfil: perfil };

} catch (erro) {
    const msg = String(erro && erro.message || erro);
    console.error('autenticarUsuario falhou:', msg, 'Stack:', erro && erro.stack);

    // Distingue falha de infraestrutura (Firestore/Service Account/config
    // ausente) de erro de negócio comum — evita expor stack cru ao usuário
    // e dá pista acionável de diagnóstico.
    if (msg.indexOf('Firestore.gs') !== -1 || msg.indexOf('OAuth2') !== -1 || msg.indexOf('Script Properties') !== -1) {
      return {
        sucesso: false,
        erro: 'Sistema de autenticação indisponível no momento. Contate o administrador (falha de conexão com o banco de identidade).'
      };
    }
    return { sucesso: false, erro: 'Erro interno: ' + msg };
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
```

---

## 📄 Arquivo [5/32]: Cases.gs

```javascript
/**
 * @fileoverview Cases.gs — Operações de caso (Fase 4: Firestore).
 *
 * A ASSINATURA PÚBLICA das funções pré-existentes NÃO MUDA — apenas o
 * FORMATO do objeto retornado por getTodosOsCasos() mudou (ver P2 abaixo).
 *
 * CONCORRÊNCIA: comTrava_()/LockService substituído por fsRunTransaction_()
 * (transação nativa do Firestore com retry automático em conflito — ver
 * Firestore.gs).
 *
 * BUSCA DE CASO: localizarLinhaCaso_/TextFinder substituído por
 * fsLocalizarCaso_ — já é O(1) por natureza.
 *
 * AUDITORIA: carimbarAuditoria_/registrarLog_ (Sheets) substituídos por
 * fsCarimbarAuditoria_/fsRegistrarLog_ (Firestore.gs).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * OTIMIZAÇÃO DE PERFORMANCE (revisão 07/2026):
 *   P1.1 — getTodosOsCasos() agora usa CacheService (TTL 45s). Com ~22
 *          usuários simultâneos, várias sincronizações caem na mesma
 *          janela e reaproveitam o cache em vez de repetir o full-scan
 *          no Firestore.
 *   P1.2 — registrarTriagem() e registrarInvestigacao() agora RETORNAM
 *          o caso atualizado (antes retornavam apenas `true`). Isso
 *          permite ao frontend fazer atualização otimista local
 *          (atualizarCasoLocal em js_core.html) em vez de chamar
 *          carregarCasos() e reprocessar a base inteira após CADA ação
 *          pontual de escrita.
 *   P2    — getTodosOsCasos() passa a buscar apenas o RESUMO do caso
 *          (campos usados no Kanban/Dashboard: id, prontuário, setor,
 *          medicamento, status, data, iniciais, gravidade, farmacêutico,
 *          conclusão) via fsListarComMascara_, reduzindo o payload da
 *          sincronização geral. Os campos de investigação completa
 *          (história clínica, Naranjo, PII do notificador etc.) só são
 *          buscados sob demanda por getCasoDetalhado(id, token), chamada
 *          quando o modal de investigação é aberto (ver js_investigacao.html).
 *          IMPORTANTE: casosGlobais no frontend passa a conter objetos
 *          "resumo" — qualquer novo campo de card no Kanban/Dashboard
 *          precisa ser adicionado em CAMPOS_RESUMO_CASOS + _mapearCasoResumo_.
 * ═══════════════════════════════════════════════════════════════════════
 */

// ============================================================
// CONSTANTES — chave de cache e campos do "resumo" (Kanban/Dashboard)
// ============================================================
const CACHE_CASOS_KEY     = 'CASOS_RESUMO_V1';
const CACHE_CASOS_TTL_SEG = 45;

// Nomes de campo no documento Firestore (não os nomes que o frontend usa) —
// mantidos aqui em vez de Schema.gs porque são específicos da leitura em
// lista (fsListarComMascara_), diferente de SCHEMA.FS.* (nome de coleção).
const CAMPOS_RESUMO_CASOS = [
  'id', 'data', 'tipo', 'prontuario', 'iniciais', 'nascimento',
  'setor', 'medicamento', 'status', 'gravidade', 'farmaceutico', 'conclusao',
  'numVigimed', 'dataVigimed', 'dataTriagem'
];
// ============================================================
// MAPEAMENTO — RESUMO (Kanban/Dashboard) vs COMPLETO (modal de investigação)
// ============================================================

/** Mapeia um doc Firestore (já filtrado por CAMPOS_RESUMO_CASOS) para o formato do frontend. */
function _mapearCasoResumo_(doc) {
  if (!doc || !doc.id) return null;
  const tz = Session.getScriptTimeZone();

  const dataTratada = doc.data instanceof Date
    ? Utilities.formatDate(doc.data, tz, 'dd/MM/yyyy HH:mm')
    : (doc.data ? String(doc.data).trim() : 'Data N/I');

  return {
    id:              String(doc.id || '').trim(),
    data_evento:     dataTratada,
    tipo:            String(doc.tipo || 'BA').trim(),
    prontuario:      String(doc.prontuario || 'N/I').trim(),
    paciente:        String(doc.iniciais || 'N/I').trim(),
    data_nascimento: String(doc.nascimento != null ? doc.nascimento : '').trim(),
    setor:           String(doc.setor || 'N/I').trim(),
    medicamento:     String(doc.medicamento || 'N/I').trim(),
    status:          String(doc.status || SCHEMA.STATUS.TRIAGEM).trim(),
    gravidade:       String(doc.gravidade || '').trim(),
    farmaceutico:    String(doc.farmaceutico || '').trim(),
    conclusao:       String(doc.conclusao || '').trim(),
    numVigimed:      String(doc.numVigimed || '').trim(),
    dataVigimed:     doc.dataVigimed instanceof Date
      ? Utilities.formatDate(doc.dataVigimed, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : String(doc.dataVigimed || '').trim(),
    dataTriagem:     doc.dataTriagem instanceof Date
      ? Utilities.formatDate(doc.dataTriagem, tz, "yyyy-MM-dd'T'HH:mm:ss")
      : String(doc.dataTriagem || '').trim()
  };
}

/** Mapeia um doc Firestore COMPLETO (sem field mask) para o formato do frontend — usado pelo modal de investigação. */
function _mapearCasoCompleto_(doc) {
  if (!doc || !doc.id) return null;
  const tz = Session.getScriptTimeZone();

  const dataTratada = doc.data instanceof Date
    ? Utilities.formatDate(doc.data, tz, 'dd/MM/yyyy HH:mm')
    : (doc.data ? String(doc.data).trim() : 'Data N/I');

  const dataVigi = doc.dataVigimed instanceof Date
    ? Utilities.formatDate(doc.dataVigimed, tz, 'yyyy-MM-dd HH:mm')
    : (doc.dataVigimed ? String(doc.dataVigimed).trim() : '');

  const atualizadoEm = (doc.auditoria && doc.auditoria.atualizadoEm instanceof Date)
    ? Utilities.formatDate(doc.auditoria.atualizadoEm, tz, 'dd/MM/yyyy HH:mm')
    : (doc.auditoria && doc.auditoria.atualizadoEm ? String(doc.auditoria.atualizadoEm).trim() : '');

  const notif = doc.notificador || {};
  const dataNotificacao = notif.dataNotificacao instanceof Date
    ? Utilities.formatDate(notif.dataNotificacao, tz, 'dd/MM/yyyy HH:mm')
    : (notif.dataNotificacao ? String(notif.dataNotificacao).trim() : '');

  return {
    id:              String(doc.id || '').trim(),
    data_evento:     dataTratada,
    tipo:            String(doc.tipo || 'BA').trim(),
    prontuario:      String(doc.prontuario || 'N/I').trim(),
    paciente:        String(doc.iniciais || 'N/I').trim(),
    data_nascimento: String(doc.nascimento != null ? doc.nascimento : '').trim(),
    setor:           String(doc.setor || 'N/I').trim(),
    medicamento:     String(doc.medicamento || 'N/I').trim(),
    status:          String(doc.status || SCHEMA.STATUS.TRIAGEM).trim(),
    historiaClinica: String(doc.historiaClinica || '').trim(),
    relatoEvento:    String(doc.relato || '').trim(),
    exames:          String(doc.exames || '').trim(),
    readministrado:  String(doc.readministrado || '').trim(),
    evolucao:        String(doc.evolucao || '').trim(),
    desfecho:        String(doc.desfecho || '').trim(),
    conclusao:       String(doc.conclusao || '').trim(),
    naranjo:         String(doc.naranjo || '').trim(),
    gravidade:       String(doc.gravidade || '').trim(),
    farmaceutico:    String(doc.farmaceutico || '').trim(),
    numVigimed:      String(doc.numVigimed || '').trim(),
    dataVigimed:     dataVigi,
    observacoes:     String(doc.observacoes || '').trim(),
    naranjoRespostas:String(doc.naranjoRespostas || '').trim(),
    atualizadoPor:   String(doc.auditoria && doc.auditoria.atualizadoPor || '').trim(),
    atualizadoEm:    atualizadoEm,
    // LOTE/LABORATORIO separados (07/2026). Fallback lê o campo legado
    // loteLaboratorio de docs antigos ainda não re-salvos pela investigação.
    lote:            String(doc.lote != null && doc.lote !== '' ? doc.lote : (doc.loteLaboratorio || '')).trim(),
    laboratorio:     String(doc.laboratorio || '').trim(),
    relatoNotificador:  String(doc.relatoNotificador  || '').trim(),
    condutaNotificador: String(doc.condutaNotificador || '').trim(),

    notifNome:       String(notif.nome      || '').trim(),
    notifCategoria:  String(notif.categoria || '').trim(),
    notifEmail:      String(notif.email     || '').trim(),
    dataNotificacao: dataNotificacao,
    // ── Fase 8 / Exportação E2B(R3) — adicionar dentro do objeto retornado ──
    reacaoTermo:       String(doc.reacaoTermo      || '').trim(),
    doseMedicamento:   String(doc.doseMedicamento  || '').trim(),
    doseUnidade:       String(doc.doseUnidade      || '').trim(),
    viaAdministracao:  String(doc.viaAdministracao || '').trim(),
    dataInicioReacao:  (doc.dataInicioReacao instanceof Date)
    ? Utilities.formatDate(doc.dataInicioReacao, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
    : String(doc.dataInicioReacao || '').trim(),

    // ── Ajuste E2B (D.5 Sexo / G.k.4.r.4 Início Adm. / D.2.1 Nascimento editável) ──
    sexo:                     String(doc.sexo || '').trim(),
    nascimento:               String(doc.nascimento != null ? doc.nascimento : '').trim(),
    dataInicioAdministracao:  (doc.dataInicioAdministracao instanceof Date)
      ? Utilities.formatDate(doc.dataInicioAdministracao, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
      : String(doc.dataInicioAdministracao || '').trim(),
  };
}

// ============================================================
// LEITURA (read-only, sem trava)
// ============================================================

/**
 * Retorna o RESUMO de todos os casos (campos do Kanban/Dashboard),
 * com cache de 45s (P1.1) e field mask (P2) para reduzir tráfego.
 */
function getTodosOsCasos(token) {
  return comAutenticacao_(token, function () {
    try {
      const cache = CacheService.getScriptCache();
      const hit = cache.get(CACHE_CASOS_KEY);
      if (hit) {
        try { return JSON.parse(hit); } catch (e) { /* cache corrompido: relê abaixo */ }
      }

      const docs  = fsListarComMascara_(SCHEMA.FS.CASOS, CAMPOS_RESUMO_CASOS);
      const casos = docs.map(_mapearCasoResumo_).filter(Boolean);

      try {
        cache.put(CACHE_CASOS_KEY, JSON.stringify(casos), CACHE_CASOS_TTL_SEG);
      } catch (e) {
        // Payload pode ultrapassar 100KB do CacheService em bases muito
        // grandes — segue sem cache nesse caso (degradação graciosa).
      }

      return casos;
    } catch (erro) {
      throw new Error('Erro ao consolidar base Kanban: ' + erro.message);
    }
  });
}

/** Remove o cache de resumo — chamar após QUALQUER escrita em casos_ram. */
function invalidarCasosCache_() {
  CacheService.getScriptCache().remove(CACHE_CASOS_KEY);
}

/**
 * P2: Busca o detalhe COMPLETO de um único caso (todos os campos de
 * investigação, Naranjo, PII do notificador). Chamada sob demanda quando
 * o modal de investigação é aberto — não faz parte da sincronização geral.
 */
function getCasoDetalhado(id, token) {
  return comAutenticacao_(token, function () {
    const idLimpo = String(id || '').trim();
    if (!idLimpo) throw new Error('ID do caso não informado.');
    const doc = fsGetDoc_(SCHEMA.FS.CASOS, idLimpo);
    if (!doc) throw new Error('Caso não localizado.');
    return _mapearCasoCompleto_(doc);
  });
}

// ============================================================
// ESCRITAS (todas com transação Firestore + auditoria)
// ============================================================

/**
 * Salva uma nova notificação espontânea (form.html ou notificação interna).
 * RETORNO: { farmaceuticoResponsavel: string } — idêntico ao original.
 */

/**
 * Normaliza valor vindo de <input type="datetime-local"> ("yyyy-MM-ddTHH:mm")
 * para "yyyy-MM-dd HH:mm" antes de persistir — legível no espelho/auditoria.
 * Datas sem hora e strings legadas passam intactas. E2B.gs continua lendo
 * ambos os formatos (_formatarDataE2B_ casa o prefixo yyyy-MM-dd).
 */
function _normalizarDataHoraInput_(v) {
  return String(v == null ? '' : v).trim().replace('T', ' ');
}

const _DE_IDEMP_PREFIXO = 'DE_IDEMP_';
const _DE_IDEMP_TTL_SEG = 21600; // 6h — cobre retries de rede do form

function salvarDemandaEspontanea(formDados) {
  try {
    // IDEMPOTÊNCIA (form.html envia idempotencyKey e REUTILIZA a mesma chave
    // no retry após timeout). A versão anterior IGNORAVA a chave: se o 1º
    // envio gravava mas a resposta se perdia na rede, o retry criava um caso
    // DUPLICADO (idCaso muda porque usa timestamp). Agora a chave é registrada
    // no CacheService e o retry devolve o resultado original sem regravar.
    const chaveIdemp = String(formDados && formDados.idempotencyKey || '').trim();
    const cacheIdemp = CacheService.getScriptCache();
    if (chaveIdemp) {
      const jaProcessado = cacheIdemp.get(_DE_IDEMP_PREFIXO + chaveIdemp);
      if (jaProcessado) {
        try { return JSON.parse(jaProcessado); } catch (e) { /* segue e regrava */ }
      }
    }

    const prontuario  = String(formDados && formDados.prontuario  || '').trim();
    const iniciais    = String(formDados && formDados.iniciais    || '').trim();
    const setor       = String(formDados && formDados.setor       || '').trim();
    const medicamento = String(formDados && formDados.medicamento || '').trim();

    if (!prontuario || !iniciais || !setor || !medicamento) {
      throw new Error('Preencha os campos obrigatórios: prontuário, iniciais, setor e medicamento.');
    }

    const agora        = new Date();
    const tz           = Session.getScriptTimeZone();
    const dataInclusao = Utilities.formatDate(agora, tz, 'dd/MM/yyyy HH:mm:ss');

    const idCaso = `ESP-${prontuario}-${agora.getTime().toString().slice(-6)}`;

    const nomeNotif  = String(formDados.notificador           || 'N/I').trim();
    const catNotif   = String(formDados.categoriaProfissional || 'N/I').trim();
    const emailNotif = String(formDados.emailNotificador      || '').trim();

    let farmaceuticoResponsavel = '';
    try {
      const cfg = getConfig();
      const setorUp = setor.toUpperCase().trim();
      const setorObj = (cfg.setores || []).find(function (s) {
        return s.setor && s.setor.toUpperCase().trim() === setorUp;
      });
      if (setorObj && setorObj.farmaceutico) {
        farmaceuticoResponsavel = setorObj.farmaceutico;
      }
    } catch (e) {
      console.warn('Não foi possível resolver o farmacêutico do setor: ' + e.message);
    }

    const dataEventoValida = formDados.dataEvento
      ? _normalizarDataHoraInput_(formDados.dataEvento)
      : dataInclusao;

    const objetoCaso = {
      id: idCaso,
      data: dataEventoValida,
      tipo: 'DE',
      prontuario: prontuario,
      iniciais: iniciais.toUpperCase(),
      nascimento: formDados.nascimento || '',
      setor: setor.toUpperCase(),
      medicamento: medicamento.toUpperCase(),
      status: SCHEMA.STATUS.INVESTIGACAO,
      sla: 'AGUARDANDO SLA',
      farmaceutico: farmaceuticoResponsavel,

      motivoDescarte: '', historiaClinica: '', relato: '', exames: '',
      readministrado: '', evolucao: '', desfecho: '', conclusao: '',
      naranjo: '', gravidade: '', numVigimed: '', dataVigimed: '',
      observacoes: '', naranjoRespostas: '', lote: '', laboratorio: '',

      relatoNotificador: formDados.descricao || '',
      condutaNotificador: formDados.condutas || '',

      notificador: {
        nome: nomeNotif,
        categoria: catNotif,
        email: emailNotif,
        dataNotificacao: agora
      },

      auditoria: {
        atualizadoPor: 'Formulário Assistência',
        atualizadoEm: agora
      }
    };

    fsSetDoc_(SCHEMA.FS.CASOS, idCaso, objetoCaso);
    espelharCasoNoSheets_(idCaso, objetoCaso, 'INSERT');
    fsRegistrarLog_('NOTIFICACAO_ESPONTANEA', idCaso, `${setor} / ${medicamento}`);
    invalidarCasosCache_(); // P1.1 — novo caso precisa aparecer na próxima leitura

    const resultado = { farmaceuticoResponsavel: farmaceuticoResponsavel };

    // Registra a chave de idempotência SÓ após sucesso completo — um retry
    // com a mesma chave passa a devolver este mesmo resultado.
    if (chaveIdemp) {
      try {
        cacheIdemp.put(_DE_IDEMP_PREFIXO + chaveIdemp, JSON.stringify(resultado), _DE_IDEMP_TTL_SEG);
      } catch (e) { /* cache indisponível — degrada sem quebrar o envio */ }
    }

    return resultado;

  } catch (erro) {
    throw new Error(`Erro ao salvar demanda espontânea: ${erro.message}`);
  }
}

/**
 * Trilha os casos gerados pelos gatilhos do PowerShell (Busca Ativa).
 *
 * P1.2: retorna o caso ATUALIZADO (resumo) em vez de `true` — permite
 * atualização otimista local no frontend (atualizarCasoLocal).
 */
function registrarTriagem(dados, token) {
  return comAutenticacao_(token, function () {
    try {
      fsRunTransaction_(function (ctx) {
        const caso = fsTxnGetDoc_(ctx.id, SCHEMA.FS.CASOS, dados.idCaso);
        if (!caso) throw new Error('Caso não localizado.');

        // Regra #7: dataTriagem é carimbo ÚNICO — se o caso já tiver o
        // timestamp (re-triagem/retrabalho), PRESERVA o original em vez de
        // sobrescrever, senão o SLA medido seria falsificado.
        const dataTriagemFinal = caso.dataTriagem || new Date();
        let atualizacao;
        if (dados.houveRam === false) {
          atualizacao = {
            status: SCHEMA.STATUS.DESCARTADO,
            motivoDescarte: dados.motivoDescarte,
            dataTriagem: dataTriagemFinal
          };
        } else {
          atualizacao = {
            medicamento: String(dados.medSuspeito || '').toUpperCase().trim(),
            status: SCHEMA.STATUS.INVESTIGACAO,
            dataTriagem: dataTriagemFinal
          };
        }

        fsTxnUpdateDoc_(ctx, SCHEMA.FS.CASOS, dados.idCaso, atualizacao);
        fsCarimbarAuditoria_(ctx, dados.idCaso);
        return true;
      });

      espelharCasoNoSheets_(dados.idCaso, null, 'UPDATE');
      invalidarCasosCache_(); // P1.1

      // Bug corrigido: a versão anterior chamava fsRegistrarLog_ DUAS vezes
      // com o mesmo evento (log duplicado por triagem). Agora só uma vez.
      if (dados.houveRam === false) {
        fsRegistrarLog_('DESCARTE', dados.idCaso, dados.motivoDescarte);
      } else {
        fsRegistrarLog_('TRIAGEM', dados.idCaso, 'Enviado para investigação');
      }

      const docAtualizado = fsGetDoc_(SCHEMA.FS.CASOS, dados.idCaso);
      return _mapearCasoResumo_(docAtualizado);

    } catch (erro) {
      throw new Error(`Erro na triagem: ${erro.message}`);
    }
  });
}

/**
 * Persiste a avaliação clínica e a aplicação do Algoritmo de Naranjo.
 *
 * P1.2: retorna o caso ATUALIZADO (resumo) em vez de `true`.
 */
function registrarInvestigacao(dados, token) {
  return comAutenticacao_(token, function () {
    try {
      const novoStatus = dados.encerrar ? SCHEMA.STATUS.CONCLUIDO : SCHEMA.STATUS.INVESTIGACAO;

      fsRunTransaction_(function (ctx) {
        const caso = fsTxnGetDoc_(ctx.id, SCHEMA.FS.CASOS, dados.idCaso);
        if (!caso) throw new Error('Caso não localizado para investigação.');

        // GUARDA SERVER-SIDE: o travamento de campos de caso CONCLUÍDO era
        // enforced só no frontend. Qualquer chamada direta com token válido
        // podia sobrescrever um caso concluído sem reabri-lo — quebrando a
        // integridade regulatória (caso já exportado/importado no VigiMed).
        // Única via de escrita clínica em CONCLUÍDO é reabrirInvestigacao().
        if (caso.status === SCHEMA.STATUS.CONCLUIDO) {
          throw new Error('Caso CONCLUÍDO está travado. Use "Reabrir investigação" antes de editar.');
        }

        fsTxnUpdateDoc_(ctx, SCHEMA.FS.CASOS, dados.idCaso, {
          status: novoStatus,
          historiaClinica: dados.historiaClinica,
          relato: dados.relatoEvento,
          exames: dados.exames,
          readministrado: dados.readministrado,
          evolucao: dados.evolucao,
          desfecho: dados.desfecho,
          conclusao: dados.conclusao,
          naranjo: dados.naranjo,
          gravidade: dados.gravidade,
          farmaceutico: dados.farmaceutico,
          numVigimed: dados.numVigimed,
          dataVigimed: _normalizarDataHoraInput_(dados.dataVigimed),
          observacoes: dados.observacoes,
          naranjoRespostas: dados.naranjoRespostas,
          lote:        dados.lote        || '',
          laboratorio: dados.laboratorio || '',
          // ── Fase 8 / Exportação E2B(R3) ──────────────────────────────────────
          reacaoTermo:       dados.reacaoTermo      || '',
          doseMedicamento:   dados.doseMedicamento  || '',
          doseUnidade:       dados.doseUnidade      || '',
          viaAdministracao:  dados.viaAdministracao || '',
          dataInicioReacao:  _normalizarDataHoraInput_(dados.dataInicioReacao) || null,
          // idReacaoE2B / idMedicamentoE2B / safetyReportIdE2B NÃO entram aqui —
          // são gerados e persistidos só na hora da exportação, por E2B.gs
          // (ver gerarXmlE2B), não no fluxo de investigação.

          // ── Ajuste E2B (D.2.1 Nascimento editável / G.k.4.r.4 Início Adm.) ────
          nascimento:              dados.nascimento              || caso.nascimento,
          dataInicioAdministracao: _normalizarDataHoraInput_(dados.dataInicioAdministracao) || null
        });
        
        fsCarimbarAuditoria_(ctx, dados.idCaso);
        return true;
      });

      espelharCasoNoSheets_(dados.idCaso, null, 'UPDATE');
      invalidarCasosCache_(); // P1.1
      fsRegistrarLog_(
        dados.encerrar ? 'INVESTIGACAO_FINALIZADA' : 'INVESTIGACAO_RASCUNHO',
        dados.idCaso,
        dados.conclusao || ''
      );

      const docAtualizado = fsGetDoc_(SCHEMA.FS.CASOS, dados.idCaso);
      return _mapearCasoResumo_(docAtualizado);

    } catch (erro) {
      throw new Error(`Erro ao salvar investigação: ${erro.message}`);
    }
  });
}

/**
 * Reabre um caso CONCLUÍDO — única via de destravar os campos de
 * investigação. Guarda de estado: só aceita partir de CONCLUIDO.
 */
function reabrirInvestigacao(idCaso, token) {
  return comAutenticacao_(token, function () {
    try {
      const idLimpo = String(idCaso || '').trim();
      if (!idLimpo) throw new Error('ID do caso não informado.');

      fsRunTransaction_(function (ctx) {
        const caso = fsTxnGetDoc_(ctx.id, SCHEMA.FS.CASOS, idLimpo);
        if (!caso) throw new Error('Caso não localizado.');
        if (caso.status !== SCHEMA.STATUS.CONCLUIDO) {
          throw new Error('Somente casos CONCLUÍDOS podem ser reabertos.');
        }

        fsTxnUpdateDoc_(ctx, SCHEMA.FS.CASOS, idLimpo, {
          status: SCHEMA.STATUS.INVESTIGACAO
        });
        fsCarimbarAuditoria_(ctx, idLimpo);
        return true;
      });

      espelharCasoNoSheets_(idLimpo, null, 'UPDATE');
      invalidarCasosCache_();
      fsRegistrarLog_('CASO_REABERTO', idLimpo, 'Retornado para investigação pelo farmacêutico');

      const docAtualizado = fsGetDoc_(SCHEMA.FS.CASOS, idLimpo);
      return _mapearCasoResumo_(docAtualizado);

    } catch (erro) {
      throw new Error(`Erro ao reabrir caso: ${erro.message}`);
    }
  });
}

/**
 * Registra nº/data de importação no VigiMed. ÚNICA escrita permitida em
 * caso CONCLUIDO sem reabri-lo (campos clínicos permanecem travados).
 */
function registrarImportacaoVigimed(dados, token) {
  return comAutenticacao_(token, function () {
    try {
      const idLimpo = String(dados && dados.idCaso || '').trim();
      if (!idLimpo) throw new Error('ID do caso não informado.');

      fsRunTransaction_(function (ctx) {
        const caso = fsTxnGetDoc_(ctx.id, SCHEMA.FS.CASOS, idLimpo);
        if (!caso) throw new Error('Caso não localizado.');
        if (caso.status !== SCHEMA.STATUS.CONCLUIDO) {
          throw new Error('Só é possível registrar importação VigiMed em casos CONCLUÍDOS.');
        }

        fsTxnUpdateDoc_(ctx, SCHEMA.FS.CASOS, idLimpo, {
          numVigimed:  String(dados.numVigimed  || '').trim(),
          dataVigimed: _normalizarDataHoraInput_(dados.dataVigimed)
        });
        fsCarimbarAuditoria_(ctx, idLimpo);
        return true;
      });

      espelharCasoNoSheets_(idLimpo, null, 'UPDATE');
      invalidarCasosCache_();
      fsRegistrarLog_('VIGIMED_IMPORTADO', idLimpo, dados.numVigimed || '');

      const docAtualizado = fsGetDoc_(SCHEMA.FS.CASOS, idLimpo);
      return _mapearCasoResumo_(docAtualizado);

    } catch (erro) {
      throw new Error(`Erro ao registrar importação VigiMed: ${erro.message}`);
    }
  });
}
```

---

## 📄 Arquivo [6/32]: Config.gs

```javascript
/**
 * @fileoverview Config.gs — Serviço de Configuração Externalizada (Fase 2 → Fase 4 Firestore).
 *
 * MIGRAÇÃO (Fase 4): fonte de dados trocada de Google Sheets para Firestore.
 * A ASSINATURA PÚBLICA NÃO MUDA: getConfig() continua retornando exatamente
 * o mesmo formato de objeto { geral, setores, listas, naranjo, status }.
 * Nenhuma alteração necessária em js_core.html / aplicarConfig() / frontend.
 *
 * DEGRADAÇÃO GRACIOSA MANTIDA: se uma coleção Firestore estiver vazia ou
 * inacessível, cai nos valores PADRÃO (DEFAULT_GERAL/DEFAULT_LISTAS/
 * DEFAULT_NARANJO) — o sistema nunca quebra por falta de configuração,
 * igual ao comportamento original com abas ausentes no Sheets.
 *
 * ROLLBACK: se algo der errado, basta restaurar a versão anterior deste
 * arquivo (baseada em SpreadsheetApp) — DB_Config_Geral, DB_Setores,
 * DB_Listas e DB_Naranjo continuam intactas no Sheets, não foram alteradas
 * pela migração, apenas copiadas.
 */

const CONFIG_CACHE_KEY  = "VIGI_CONFIG_V1";
const CONFIG_CACHE_SEG  = 600; // 10 minutos — mesmo valor de antes

// ── Valores padrão (espelham os dropdowns atuais do index.html) ──────────────
// Mantidos idênticos à versão Sheets — são o fallback de última instância.
const DEFAULT_GERAL = {
  EMAIL_COORDENACAO: "farmacia.clinica@hospital.com",
  SLA_PADRAO_HORAS:  "48",
  ALERTAS_ATIVOS:    "SIM",
  TITULO_SISTEMA:    "VigiRAM"
};

const DEFAULT_LISTAS = {
  gravidade:        ["LEVE", "MODERADA", "GRAVE", "FATAL"],
  desfecho:         ["PROLONGADO INTERNAÇÃO", "PACIENTE RECUPERADO", "TRANSFERÊNCIA INTERNA",
                     "ALTA", "TRANSFERÊNCIA EXTERNA", "ÓBITO"],
  conclusao:        ["CONFIRMADO", "NÃO RELACIONADO AO MEDICAMENTO", "PROVÁVEL"],
  motivo_descarte:  ["Uso Profilático / Rotina", "Erro de Prescrição", "Evolução da Doença", "Outros"],
  readministrado:   ["Não", "Sim", "Sim. Sintomas reapareceram", "Sim. Sintomas não reapareceram"],
  evolucao:         ["NENHUMA CONDUTA REALIZADA", "SINTOMAS DESAPARECERAM",
                     "MELHORA DOS SINTOMAS", "SINTOMAS NÃO DESAPARECERAM"]
};

const DEFAULT_NARANJO = [
  { pergunta: "Relatos prévios sobre esta reação?",                    sim: 1, nao:  0, ns: 0 },
  { pergunta: "Apareceu após o uso do medicamento?",                   sim: 2, nao: -1, ns: 0 },
  { pergunta: "Melhorou ao suspender ou usar antagonista?",            sim: 1, nao:  0, ns: 0 },
  { pergunta: "Reapareceu ao readministrar?",                          sim: 2, nao: -1, ns: 0 },
  { pergunta: "Existem causas alternativas?",                          sim:-1, nao:  2, ns: 0 },
  { pergunta: "Reapareceu com placebo?",                               sim:-1, nao:  1, ns: 0 },
  { pergunta: "Detectado no sangue em concentração tóxica?",           sim: 1, nao:  0, ns: 0 },
  { pergunta: "Mais grave ao aumentar a dose?",                        sim: 1, nao:  0, ns: 0 },
  { pergunta: "Reação semelhante no passado?",                         sim: 1, nao:  0, ns: 0 },
  { pergunta: "Confirmado por evidência objetiva?",                    sim: 1, nao:  0, ns: 0 }
];

// ─────────────────────────────────────────────────────────────────────────────
// PONTO ÚNICO DE LEITURA — com cache de 10 minutos (idêntico ao original)
// ─────────────────────────────────────────────────────────────────────────────
function getConfig() {
  const cache = CacheService.getScriptCache();
  const hit   = cache.get(CONFIG_CACHE_KEY);
  if (hit) {
    try { return JSON.parse(hit); } catch (e) { /* cache corrompido: relê */ }
  }

  const config = {
    geral:   lerConfigGeralFirestore_(),
    setores: lerSetoresFirestore_(),
    listas:  lerListasFirestore_(),
    naranjo: lerNaranjoFirestore_(),
    status:  SCHEMA.STATUS
  };

  try { cache.put(CONFIG_CACHE_KEY, JSON.stringify(config), CONFIG_CACHE_SEG); } catch (e) {}
  return config;
}

/** Limpa o cache (use após editar dados para refletir imediatamente). */
function invalidarConfig() {
  const cache = CacheService.getScriptCache();
  cache.remove(CONFIG_CACHE_KEY);
  cache.remove(CONFIG_SETORES_PUB_KEY); // cache público do form (getSetoresPublico)
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// [M8 — LGPD] LEITURA PÚBLICA MÍNIMA — form.html (anônimo)
// ─────────────────────────────────────────────────────────────────────────────
// form.html chamava getConfig() completo: expunha a QUALQUER anônimo os
// e-mails e nomes dos farmacêuticos por setor, EMAIL_COORDENACAO e o Naranjo.
// O form só precisa dos NOMES dos setores. Este endpoint devolve apenas isso.
// Cache próprio (mesmo TTL de 10 min) — payload minúsculo, zero PII.

const CONFIG_SETORES_PUB_KEY = 'VIGI_SETORES_PUB_V1';

/**
 * Lista pública de setores ativos — SOMENTE nomes, para o dropdown do
 * formulário anônimo de notificação (form.html).
 * @returns {{ setores: string[] }}
 */
function getSetoresPublico() {
  const cache = CacheService.getScriptCache();
  const hit   = cache.get(CONFIG_SETORES_PUB_KEY);
  if (hit) {
    try { return JSON.parse(hit); } catch (e) { /* cache corrompido: relê */ }
  }

  const nomes = lerSetoresFirestore_()
    .map(function (s) { return s.setor; })
    .filter(Boolean)
    .sort();

  const resultado = { setores: nomes };
  try { cache.put(CONFIG_SETORES_PUB_KEY, JSON.stringify(resultado), CONFIG_CACHE_SEG); } catch (e) {}
  return resultado;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEITORES INDIVIDUAIS — agora via Firestore (fsListarTodos_/fsGetDoc_)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lê config_geral (coleção com 1 documento por chave) e funde com os
 * padrões — equivalente a DEFAULT_GERAL + sobrescrita por linha do Sheets.
 */
function lerConfigGeralFirestore_() {
  const obj = Object.assign({}, DEFAULT_GERAL);
  try {
    const docs = fsListarTodos_(SCHEMA.FS.GERAL);
    docs.forEach(function (doc) {
      const chave = String(doc.chave || doc._id || '').trim();
      const valor = String(doc.valor || '').trim();
      if (chave) obj[chave] = valor;
    });
  } catch (e) {
    console.error('lerConfigGeralFirestore_: falha ao ler Firestore, usando DEFAULT_GERAL — ' + e.message);
  }
  return obj;
}

/**
 * Lê setores (Fase 4: 1 documento por SETOR+e-mail, já que setores como
 * "TODOS" podem ter múltiplos farmacêuticos — ver migrarSetoresParaFirestore).
 * Retorna o MESMO formato de array que o frontend já espera:
 *   [{ setor, email, farmaceutico }, ...]
 */
function lerSetoresFirestore_() {
  try {
    const docs = fsListarTodos_(SCHEMA.FS.SETORES);
    const lista = [];
    docs.forEach(function (doc) {
      const setor = String(doc.setor || '').trim();
      const ativo = String(doc.ativo || 'SIM').trim().toUpperCase();
      if (!setor) return;
      if (ativo === 'NAO' || ativo === 'NÃO') return;

      lista.push({
        setor: setor,
        email: String(doc.emailResponsavel || '').trim(),
        farmaceutico: String(doc.farmaceuticoResponsavel || '').trim()
      });
    });
    return lista;
  } catch (e) {
    console.error('lerSetoresFirestore_: falha ao ler Firestore — ' + e.message);
    return [];
  }
}

/**
 * Lê listas (Fase 4: 1 documento por campo, já com array de opções
 * ordenado — ver migrarListasParaFirestore). Funde com DEFAULT_LISTAS.
 */
function lerListasFirestore_() {
  const listas = JSON.parse(JSON.stringify(DEFAULT_LISTAS)); // cópia profunda dos padrões
  try {
    const docs = fsListarTodos_(SCHEMA.FS.LISTAS);
    docs.forEach(function (doc) {
      const campo = String(doc.campo || doc._id || '').trim();
      if (!campo || !Array.isArray(doc.opcoes)) return;
      listas[campo] = doc.opcoes;
    });
  } catch (e) {
    console.error('lerListasFirestore_: falha ao ler Firestore, usando DEFAULT_LISTAS — ' + e.message);
  }
  return listas;
}

/**
 * Lê naranjo (Fase 4: documento único 'algoritmo_padrao' com array de
 * 10 perguntas — ver migrarNaranjoParaFirestore). Mesma validação de
 * segurança do original: precisa ter exatamente 10 itens.
 */
function lerNaranjoFirestore_() {
  try {
    const doc = fsGetDoc_(SCHEMA.FS.NARANJO, 'algoritmo_padrao');
    if (doc && Array.isArray(doc.perguntas) && doc.perguntas.length === 10) {
      return doc.perguntas;
    }
  } catch (e) {
    console.error('lerNaranjoFirestore_: falha ao ler Firestore, usando DEFAULT_NARANJO — ' + e.message);
  }
  return DEFAULT_NARANJO;
}
```

---

## 📄 Arquivo [7/32]: Config write.gs

```javascript
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
    registrarLog_('CONFIG_GERAL_ATUALIZADA', 'config_geral',
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
    registrarLog_('SETORES_ATUALIZADOS', 'setores',
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
                           'motivo_descarte', 'readministrado', 'evolucao'];

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
    registrarLog_('LISTAS_ATUALIZADAS', 'listas',
      salvos + ' lista(s) salvas | Por: ' + __emailSessaoAtual);

    return { sucesso: true, mensagem: salvos + ' lista(s) salvas com sucesso.' };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GATILHOS (medicamentos monitorados pelo ETL)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lê a lista de gatilhos da aba DB_Antidotos (Sheets) — o ETL lê daqui.
 * Retorna array de objetos { medicamento }.
 */
function listarGatilhos(token) {
  return comAutenticacao_(token, function () {
    const aba = SpreadsheetApp
      .getActiveSpreadsheet()
      .getSheetByName(SCHEMA.ABAS.ANTIDOTOS);

    if (!aba) return [];

    const dados = aba.getDataRange().getValues();
    // Assume coluna A = medicamento, linha 1 = cabeçalho
    return dados.slice(1)
      .filter(function (row) { return String(row[0] || '').trim(); })
      .map(function (row) { return { medicamento: String(row[0]).trim().toUpperCase() }; });
  });
}

/**
 * Substitui todos os gatilhos na aba DB_Antidotos.
 * Mantém o cabeçalho original (linha 1) e regrava as linhas de dados.
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

    return comTrava_(function () {
      const aba = SpreadsheetApp
        .getActiveSpreadsheet()
        .getSheetByName(SCHEMA.ABAS.ANTIDOTOS);

      if (!aba) return { sucesso: false, mensagem: 'Aba ' + SCHEMA.ABAS.ANTIDOTOS + ' não encontrada.' };

      // Preserva cabeçalho e limpa dados
      const ultimaLinha = aba.getLastRow();
      if (ultimaLinha > 1) {
        aba.getRange(2, 1, ultimaLinha - 1, aba.getLastColumn()).clearContent();
      }

      // Reinsere
      const linhas = nomesFiltrados.map(function (nome) { return [nome]; });
      aba.getRange(2, 1, linhas.length, 1).setValues(linhas);

      registrarLog_('GATILHOS_ATUALIZADOS', SCHEMA.ABAS.ANTIDOTOS,
        nomesFiltrados.length + ' gatilho(s) | Por: ' + __emailSessaoAtual);

      return { sucesso: true, mensagem: nomesFiltrados.length + ' gatilho(s) salvo(s) com sucesso.' };
    });
  });
}
```

---

## 📄 Arquivo [8/32]: E2b.gs

```javascript
/**
 * @fileoverview E2B.gs — Geração de XML ICH E2B(R3) para importação no VigiMed.
 *
 * FASE 8 (Exportação E2B(R3) para VigiMed).
 *
 * BASE: estrutura validada empiricamente contra o ambiente de teste do
 * VigiFlow/VigiMed (importação "Não validado", AckLog de sucesso em
 * 01/07/2026 — arquivo vigimed_hrn_teste_v6.xml). NÃO é uma implementação
 * genérica do padrão ICH E2B(R3) completo — é o subconjunto de elementos
 * que comprovadamente passa na validação estrutural do VigiMed para o
 * cenário de HRN (notificação espontânea, 1 medicamento, 1 reação por caso).
 *
 * LIMITAÇÕES CONHECIDAS (documentadas, não escondidas):
 *   1. MedDRA / WHODrug — ausentes (sem licença ativa). Reação vai com
 *      nullFlavor="NI" no campo de código (E.i.2.1b), preenchida só como
 *      texto livre (E.i.1.1a).
 *   2. Só gera notificação INICIAL. Follow-up/nullification ficam para
 *      entrega futura (mecânica diferente: C.1.1 muda a cada envio,
 *      C.1.8.1/WWUID permanece fixo — ver conversa/roadmap).
 *   3. FASE 2 — elementos com XPath ainda NÃO confirmado no
 *      IG_Complete_Package_v1_11_1.zip (regra do projeto: XPath não
 *      confirmado não entra no XML):
 *        - D.1.1.3 Prontuário (dado existe: caso.prontuario)
 *        - G.k.9.i.4 Rechallenge (dado existe: caso.readministrado)
 *        - G.k.4.r.8 Dosage Text (ordem RIM do <text> em
 *          substanceAdministration precisa confirmação)
 *        - G.k.7.r Indicação (além do XPath, exige novo campo no Schema)
 *        - D.9 Óbito (exige campo de data de óbito — hoje inexistente)
 *
 * CICLO DE COMPLETUDE (pós-validação BFC Element Mapping v2.02 — 07/2026):
 *   - E.i.7 Desfecho: AGORA INCLUÍDO. Obrigatório (1..1) no BFC mapping.
 *     Usa SCHEMA.E2B.DESFECHO_MAP com fallback '6' (Unknown) para valor
 *     não mapeado/ausente. Mesmo padrão XML dos critérios de gravidade
 *     (outboundRelationship2 > observation), já validado no AckLog v6 —
 *     só muda o code (27) e o value (CE em vez de BL).
 *   - E.i.2.1b: nullFlavor="NI" agora EMITIDO de fato no <value> da reação
 *     (docstring antiga prometia, código não fazia — elemento é 1..1).
 *   - E.i.1.1b: language="por" (ISO 639-2, formato 3A do mapping) — antes
 *     "pt" (2 letras, fora de spec).
 *   - C.1.4: effectiveTime/low agora usa a data de RECEBIMENTO da
 *     notificação (notificador.dataNotificacao), semântica correta do
 *     elemento; fallback caso.data (comportamento antigo).
 *   - C.2.r.1.2/1.4: nome do notificador primário agora preenchido com o
 *     farmacêutico logado (mesma identidade já usada em C.2.r.4='2' e no
 *     telecom) — decisão LGPD mantida: NÃO expor PII de notificador
 *     externo; a Farmácia é a fonte primária perante o VigiMed.
 *     Estrutura <name><given>/<family> idêntica ao bloco C.3 validado.
 *   - H.1/D.14 Narrativa enriquecida: EXAMES_COMPLEMENTARES,
 *     CONDUTA_NOTIFICADOR, EVOLUCAO_POS_CONDUTAS, CONCLUSAO, OBSERVACOES e
 *     HISTORIA_CLINICA concatenados com marcadores — zero risco estrutural,
 *     preenche a narrativa clínica que o VigiMed exibia quase vazia.
 *   NÃO testado contra novo AckLog ainda — gerar XML de teste e reimportar
 *   como "Não validado" antes de assumir produção.
 *
 * AJUSTES ANTERIORES (ciclo pós-AckLog v6, ver PDF ICH ICSR IG v5.03):
 *   - D.5 Sexo lido de caso.sexo (SEXO_MAP), fallback nullFlavor="UNK".
 *   - G.k.4.r.10 Via de Administração em <routeCode> (não <formCode>).
 *   - G.k.4.r.7 Lote via <lotNumberText>.
 *   - G.k.4.r.4 Início da administração em campo próprio.
 *   - C.2.r.4 Qualificação fixada em '2' (Farmacêutico).
 *   - C.3.1 Sender Type '3' (Health Professional).
 *
 * ARQUITETURA:
 *   - Leitura via fsGetDoc_ (Firestore) — não usa comTrava_/localizarLinhaCaso_
 *     (esses são legado do Mirror.gs/Sheets; casos_ram já migrou pra Firestore).
 *   - Geração de XML é 100% leitura — não precisa de trava de concorrência.
 *   - A ÚNICA escrita feita por este módulo é persistir os 3 IDs estáveis
 *     (idReacaoE2B, idMedicamentoE2B, safetyReportIdE2B) na 1ª exportação de
 *     cada caso, via fsRunTransaction_ (padrão do projeto), com
 *     fsCarimbarAuditoria_ + fsRegistrarLog_.
 *   - Todo texto livre (narrativa, nome de medicamento, reação, comentários)
 *     passa por escaparHtml_ antes de entrar no XML — mesma função já usada
 *     no resto do projeto para prevenção de XSS/injeção, reaproveitada aqui
 *     para escapar caracteres especiais XML (&, <, >, ", ').
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES INSTITUCIONAIS
// ─────────────────────────────────────────────────────────────────────────────
// Dados de identidade do hospital/remetente que não variam por caso. Lidos de
// getConfig().geral quando disponíveis (degradação graciosa, mesmo padrão de
// DEFAULT_GERAL em Config.gs); caem no fallback abaixo se as chaves não
// existirem ainda em config_geral. Se quiser tornar isso 100% configurável
// pelo painel, adicionar HOSPITAL_CIDADE/HOSPITAL_ESTADO/HOSPITAL_CNES/
// HOSPITAL_NOME_OFICIAL em DEFAULT_GERAL (Config.gs) e no painel de Config_Write.gs.
const E2B_INSTITUCIONAL_FALLBACK = {
  CIDADE:            'Sobral',
  ESTADO:            'CE',
  CNES:              '6848710',
  NOME_OFICIAL:      'CE - Hospital Regional Norte - CNES 6848710',
  ORGANIZACAO:       'Hospital Regional Norte - CE',
  DEPARTAMENTO:      'Farmacia Clinica',
  SENDER_SHORTNAME:  'HRN-CE'
};

// ─────────────────────────────────────────────────────────────────────────────
// PONTO DE ENTRADA — chamado via google.script.run pelo frontend
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gera o XML E2B(R3) de um caso e retorna pronto para download no cliente.
 * @param {string} idCaso
 * @param {string} token
 * @return {{ xml: string, nomeArquivo: string, avisos: string[] }}
 */
function gerarXmlE2B(idCaso, token) {
  return comAutenticacao_(token, function () {
    const idLimpo = String(idCaso || '').trim();
    if (!idLimpo) throw new Error('ID do caso não informado.');

    const caso = fsGetDoc_(SCHEMA.FS.CASOS, idLimpo);
    if (!caso) throw new Error('Caso não localizado: ' + idLimpo);

    if (caso.status !== SCHEMA.STATUS.CONCLUIDO) {
      throw new Error('Exportação E2B só é permitida para casos CONCLUÍDOS. Finalize a investigação primeiro.');
    }

    const avisos = _validarCasoParaE2B_(caso);

    const ids = _prepararIdsE2B_(idLimpo, caso);
    // Reflete os IDs recém-gerados no objeto em memória (para esta geração,
    // sem precisar reler o Firestore).
    caso.idReacaoE2B      = ids.idReacaoE2B;
    caso.idMedicamentoE2B = ids.idMedicamentoE2B;
    caso.safetyReportIdE2B = ids.safetyReportIdE2B;

    const config   = getConfig();
    const usuario  = _buscarUsuarioAtualParaAssinatura_();

    const xml = _montarXmlE2B_(caso, usuario, config);

    fsRegistrarLog_('E2B_EXPORTADO', idLimpo,
      'safetyReportId=' + ids.safetyReportIdE2B + ' | Por: ' + usuarioAtual_());

    return {
      xml: xml,
      nomeArquivo: ids.safetyReportIdE2B + '.xml',
      avisos: avisos
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDAÇÃO DEFENSIVA — falha explícita em vez de gerar XML incompleto
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifica campos obrigatórios para exportação E2B. Lança erro descritivo
 * se algo estrutural estiver faltando (não gera XML capenga silenciosamente).
 * Retorna array de avisos não-bloqueantes (ex: campo opcional ausente).
 */
function _validarCasoParaE2B_(caso) {
  const faltando = [];

  if (!caso.iniciais)                          faltando.push('Iniciais do paciente');
  if (!caso.nascimento)                        faltando.push('Data de nascimento');
  if (!caso.medicamento)                       faltando.push('Medicamento suspeito');
  if (!caso.reacaoTermo)                       faltando.push('Reação/Evento (termo curto)');
  if (!caso.gravidade)                         faltando.push('Gravidade');
  if (!caso.naranjo)                           faltando.push('Classificação de causalidade (Naranjo)');
  // C.2.r.4 Qualificação do notificador NÃO valida mais categoriaNotificador —
  // sistema é uso exclusivo da Farmácia, código fixado em '2' (Farmacêutico)
  // direto em _montarXmlE2B_, sem depender de PII de notificador externo.

  if (faltando.length > 0) {
    throw new Error(
      'Caso incompleto para exportação E2B. Faltam: ' + faltando.join(', ') +
      '. Preencha na investigação antes de exportar.'
    );
  }

  const avisos = [];
  if (!SCHEMA.E2B.GRAVIDADE_MAP[String(caso.gravidade).toUpperCase()]) {
    throw new Error(
      'Gravidade "' + caso.gravidade + '" sem mapeamento E2B (SCHEMA.E2B.GRAVIDADE_MAP). ' +
      'Atualize o mapa em Schema.gs antes de exportar este caso.'
    );
  }
  if (!caso.dataInicioReacao) avisos.push('Data de início da reação não preenchida — usando data do evento como aproximação.');
  if (!caso.doseMedicamento)  avisos.push('Dose do medicamento não preenchida — posologia sairá incompleta no XML.');
  if (!caso.dataInicioAdministracao) avisos.push('Início da administração não preenchido — usando data de início da reação/evento como aproximação (G.k.4.r.4).');
  if (!caso.sexo || !SCHEMA.E2B.SEXO_MAP[String(caso.sexo).toUpperCase()]) {
    avisos.push('Sexo do paciente ausente ou não mapeado — D.5 sairá como nullFlavor="UNK".');
  }
  if (!caso.loteLaboratorio) avisos.push('Lote/laboratório não preenchido — G.k.4.r.7 sairá em branco.');
  // E.i.7 é 1..1 no padrão — sem desfecho mapeado, sai '6' (Unknown), não trava.
  if (!caso.desfecho || !SCHEMA.E2B.DESFECHO_MAP[String(caso.desfecho).toUpperCase()]) {
    avisos.push('Desfecho ausente ou sem mapeamento (SCHEMA.E2B.DESFECHO_MAP) — E.i.7 sairá como "6" (Desconhecido).');
  }

  return avisos;
}

// ─────────────────────────────────────────────────────────────────────────────
// IDs ESTÁVEIS — gerados 1x, persistidos, reutilizados em exportações futuras
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Garante que o caso tenha idReacaoE2B, idMedicamentoE2B e safetyReportIdE2B.
 * Se já existirem (exportação repetida ou follow-up futuro), reutiliza —
 * essencial para o WWUID (C.1.8.1) permanecer estável entre envios do
 * mesmo caso, requisito do padrão E2B.
 */
function _prepararIdsE2B_(idCaso, caso) {
  const jaTemTudo = caso.idReacaoE2B && caso.idMedicamentoE2B && caso.safetyReportIdE2B;
  if (jaTemTudo) {
    return {
      idReacaoE2B:       caso.idReacaoE2B,
      idMedicamentoE2B:  caso.idMedicamentoE2B,
      safetyReportIdE2B: caso.safetyReportIdE2B
    };
  }

  const novo = {
    idReacaoE2B:       caso.idReacaoE2B      || Utilities.getUuid(),
    idMedicamentoE2B:  caso.idMedicamentoE2B || Utilities.getUuid(),
    // Determinístico e legível — mesmo padrão usado nos testes de validação.
    safetyReportIdE2B: caso.safetyReportIdE2B || ('BR-HRN-' + idCaso)
  };

  fsRunTransaction_(function (ctx) {
    fsTxnUpdateDoc_(ctx, SCHEMA.FS.CASOS, idCaso, {
      idReacaoE2B:       novo.idReacaoE2B,
      idMedicamentoE2B:  novo.idMedicamentoE2B,
      safetyReportIdE2B: novo.safetyReportIdE2B
    });
    fsCarimbarAuditoria_(ctx, idCaso);
    return true;
  });

  espelharCasoNoSheets_(idCaso, null, 'UPDATE');
  invalidarCasosCache_();

  return novo;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS DE FORMATAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

/** Converte data (Date, 'dd/MM/yyyy', 'yyyy-MM-dd') para 'YYYYMMDD' (E2B). */
function _formatarDataE2B_(valor) {
  if (!valor) return '';
  let d;
  if (valor instanceof Date) {
    d = valor;
  } else {
    const s = String(valor).trim();
    const m1 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m1)      d = new Date(parseInt(m1[3]), parseInt(m1[2]) - 1, parseInt(m1[1]));
    else if (m2) d = new Date(parseInt(m2[1]), parseInt(m2[2]) - 1, parseInt(m2[3]));
    else         d = new Date(s);
  }
  if (isNaN(d)) return '';
  const tz = Session.getScriptTimeZone();
  return Utilities.formatDate(d, tz, 'yyyyMMdd');
}

/** 'YYYYMMDDHHMMSS' para o momento atual — usado em creationTime/effectiveTime. */
function _agoraE2B_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMddHHmmss');
}

/** Divide um nome completo em { given, family } — heurística: última palavra = sobrenome. */
function _dividirNome_(nomeCompleto) {
  const partes = String(nomeCompleto || '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return { given: '', family: '' };
  if (partes.length === 1) return { given: partes[0], family: '' };
  return { given: partes.slice(0, -1).join(' '), family: partes[partes.length - 1] };
}

/** Soma as respostas do Naranjo ('1|2|0|...') para obter o escore numérico. */
function _calcularScoreNaranjo_(naranjoRespostas) {
  if (!naranjoRespostas) return 0;
  return String(naranjoRespostas).split('|')
    .reduce(function (soma, v) { return soma + (parseInt(v, 10) || 0); }, 0);
}

/** Busca nome do usuário autenticado (para assinatura C.3.3.3/C.3.3.5). */
function _buscarUsuarioAtualParaAssinatura_() {
  const email = usuarioAtual_();
  try {
    const doc = fsGetDoc_(SCHEMA.FS.USUARIOS, String(email).toLowerCase());
    if (doc && doc.nome) return { email: email, nome: doc.nome };
  } catch (e) {
    console.warn('E2B.gs: não foi possível buscar nome do usuário — ' + e.message);
  }
  return { email: email, nome: email };
}

/**
 * Monta a narrativa clínica (H.1 / investigationEvent.text) concatenando
 * todos os campos descritivos da investigação com marcadores em CAIXA ALTA.
 * Campos vazios são omitidos. Escapado 1x no final (não escapar por partes).
 */
function _montarNarrativa_(caso) {
  const base = String(
    caso.relato || caso.relatoNotificador || caso.reacaoTermo || ''
  ).trim();

  const secoes = [
    { rotulo: 'EXAMES COMPLEMENTARES',          valor: caso.exames },
    { rotulo: 'CONDUTA DO NOTIFICADOR',         valor: caso.condutaNotificador },
    { rotulo: 'EVOLUCAO POS CONDUTAS',          valor: caso.evolucao },
    { rotulo: 'CONCLUSAO DO FARMACEUTICO',      valor: caso.conclusao },
    { rotulo: 'HISTORIA CLINICA RELEVANTE',     valor: caso.historiaClinica },
    { rotulo: 'OBSERVACOES',                    valor: caso.observacoes }
  ];

  const partes = [base];
  secoes.forEach(function (s) {
    const v = String(s.valor || '').trim();
    if (v) partes.push(s.rotulo + ': ' + v);
  });

  return escaparHtml_(partes.join(' | ').toUpperCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// MONTAGEM DO XML
// ─────────────────────────────────────────────────────────────────────────────

function _montarXmlE2B_(caso, usuario, config) {
  const agora = _agoraE2B_();
  const nomeSender = _dividirNome_(usuario.nome);

  const gravidadeCriterios = SCHEMA.E2B.GRAVIDADE_MAP[String(caso.gravidade).toUpperCase()];

  // C.2.r.4 Qualificação — sistema é uso exclusivo da Farmácia: sempre Farmacêutico(a).
  const codigoQualificacao = '2';

  // C.3.3 Sender (assinatura institucional) — e-mail sempre do usuário logado,
  // com fallback pro e-mail geral da farmácia configurado em Config.gs.
  const emailSender = usuario.email ||
                       (config.geral && config.geral.EMAIL_COORDENACAO) ||
                       'farmacovigilancia@hrn.org.br';
  // C.2.r telecom — e-mail do notificador primário: mesma regra do Sender.
  const emailNotificador = emailSender;

  const dataInicioReacao = _formatarDataE2B_(caso.dataInicioReacao || caso.data);
  const dataInicioAdministracao = _formatarDataE2B_(
    caso.dataInicioAdministracao || caso.dataInicioReacao || caso.data
  );
  // C.1.4 Data em que o relato foi RECEBIDO da fonte — semântica correta é a
  // data da notificação (notificador.dataNotificacao), não a data do evento.
  // Fallback pra data do evento (comportamento antigo) em casos legados/BA.
  const dataRecebimento = _formatarDataE2B_(
    (caso.notificador && caso.notificador.dataNotificacao) || caso.data
  );
  const dataNascimento   = _formatarDataE2B_(caso.nascimento);

  // D.5 Sexo — mapeia valor livre vindo do ETL; sem match cai em nullFlavor="UNK" (ver abaixo).
  const codigoSexo = SCHEMA.E2B.SEXO_MAP[String(caso.sexo || '').toUpperCase()] || null;

  // E.i.7 Desfecho — codelist oficial ICH CL11 (…2.1.1.11): 1 Recovered,
  // 2 Recovering, 3 Not recovered, 4 Recovered w/ sequelae, 5 Fatal,
  // 0 Unknown. Fallback '0' (o comentário antigo do Schema.gs dizia '6' —
  // NÃO existe '6' na CL11, confirmado no IG_Complete_Package).
  const codigoDesfecho = SCHEMA.E2B.DESFECHO_MAP[String(caso.desfecho || '').toUpperCase()] || '0';

  // ── Lote A (XPath confirmado na instância de referência IG v1.11.1) ────────
  // D.1.1.3 Prontuário (nº registro hospitalar). Omitido se vazio ou 'N/I'
  // (default do getter em Firestore.gs). Envio ao VigiMed/ANVISA é finalidade
  // regulatória legítima sob LGPD — ainda assim escapado.
  const prontuarioRaw = String(caso.prontuario || '').trim();
  const prontuario = (prontuarioRaw && prontuarioRaw.toUpperCase() !== 'N/I')
                       ? escaparHtml_(prontuarioRaw) : '';
  // H.2 Reporter's Comments = relato do notificador (fonte primária da assistência).
  const comentarioNotificador = escaparHtml_(String(caso.relatoNotificador || '').trim().toUpperCase());
  // H.4 Sender's Comments = conclusão do farmacêutico (remetente).
  const comentarioSender = escaparHtml_(String(caso.conclusao || '').trim().toUpperCase());

  // H.1/D.14 Narrativa — todos os campos descritivos da investigação.
  const narrativa = _montarNarrativa_(caso);

  const reacaoTermo   = escaparHtml_(String(caso.reacaoTermo).toUpperCase());
  const medicamento   = escaparHtml_(String(caso.medicamento).toUpperCase());
  const viaOuForma    = escaparHtml_(String(caso.viaAdministracao || 'NAO INFORMADO').toUpperCase());
  // CORREÇÃO: dose com vírgula decimal BR ("2,5") era mutilada pelo strip
  // antigo (/[^0-9.]/) → "25" — dose 10× maior num relatório REGULATÓRIO.
  // Normaliza vírgula→ponto antes de limpar. (Não usar separador de milhar
  // no campo de dose — "1.000,5" continua ambíguo em qualquer convenção.)
  const dose          = String(caso.doseMedicamento || '')
                          .replace(/,/g, '.')
                          .replace(/[^0-9.]/g, '');
  const doseUnidade   = escaparHtml_(String(caso.doseUnidade || '').toLowerCase()) || 'mg';
  const lote          = escaparHtml_(String(caso.loteLaboratorio || '').toUpperCase());

  const naranjoScore    = _calcularScoreNaranjo_(caso.naranjoRespostas);
  const naranjoClasse   = escaparHtml_(String(caso.naranjo || 'DUVIDOSA').toUpperCase());

  const criteriosGravidade = [
    { comentario: 'E.i.3.2a: Results in Death',                       codigo: '34', valor: gravidadeCriterios.morte },
    { comentario: 'E.i.3.2b: Life Threatening',                       codigo: '21', valor: gravidadeCriterios.risco_vida },
    { comentario: 'E.i.3.2c: Caused / Prolonged Hospitalisation',     codigo: '33', valor: gravidadeCriterios.hospital },
    { comentario: 'E.i.3.2d: Disabling / Incapacitating',             codigo: '35', valor: gravidadeCriterios.incapacitante },
    { comentario: 'E.i.3.2e: Congenital Anomaly / Birth Defect',      codigo: '12', valor: false },
    { comentario: 'E.i.3.2f: Other Medically Important Condition',    codigo: '26', valor: gravidadeCriterios.outro_importante }
  ];

  const blocosGravidade = criteriosGravidade.map(function (c) {
    return '                      <outboundRelationship2 typeCode="PERT">\n' +
           '                        <observation classCode="OBS" moodCode="EVN">\n' +
           '                          <code code="' + c.codigo + '" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
           '                          <value xsi:type="BL" value="' + (c.valor ? 'true' : 'false') + '"/>\n' +
           '                          <!-- ' + c.comentario + ' -->\n' +
           '                        </observation>\n' +
           '                      </outboundRelationship2>';
  }).join('\n');

  // E.i.7 Outcome — mesmo padrão estrutural dos critérios de gravidade
  // (outboundRelationship2 > observation dentro da observation da reação),
  // já validado no AckLog v6. Diferenças: code="27" e value CE (codelist
  // …2.1.1.11) em vez de BL.
  const blocoDesfecho =
    '                      <outboundRelationship2 typeCode="PERT">\n' +
    '                        <observation classCode="OBS" moodCode="EVN">\n' +
    '                          <code code="27" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
    '                          <value xsi:type="CE" code="' + codigoDesfecho + '" codeSystem="' + SCHEMA.E2B.CODESYS.DESFECHO + '"/>\n' +
    '                          <!-- E.i.7: Outcome of Reaction at Time of Last Observation -->\n' +
    '                        </observation>\n' +
    '                      </outboundRelationship2>';

  return (
'<?xml version="1.0" encoding="UTF-8"?>\n' +
'<MCCI_IN200100UV01 ITSVersion="XML_1.0" xsi:schemaLocation="urn:hl7-org:v3 MCCI_IN200100UV01.xsd" xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n' +
'  <id extension="' + caso.safetyReportIdE2B + '-BATCH" root="2.16.840.1.113883.3.989.2.1.3.22"/>\n' +
'  <creationTime value="' + agora + '"/>\n' +
'  <responseModeCode code="D"/>\n' +
'  <interactionId extension="MCCI_IN200100UV01" root="2.16.840.1.113883.1.6"/>\n' +
'  <name code="1" codeSystem="' + SCHEMA.E2B.CODESYS.TIPO_RELATO + '"/>\n' +
'  <PORR_IN049016UV>\n' +
'    <id extension="' + caso.safetyReportIdE2B + '" root="2.16.840.1.113883.3.989.2.1.3.1"/>\n' +
'    <creationTime value="' + agora + '"/>\n' +
'    <interactionId extension="PORR_IN049016UV" root="2.16.840.1.113883.1.6"/>\n' +
'    <processingCode code="P"/>\n' +
'    <processingModeCode code="T"/>\n' +
'    <acceptAckCode code="AL"/>\n' +
'    <receiver typeCode="RCV">\n' +
'      <device classCode="DEV" determinerCode="INSTANCE">\n' +
'        <id extension="ANVISA" root="2.16.840.1.113883.3.989.2.1.3.12"/>\n' +
'      </device>\n' +
'    </receiver>\n' +
'    <sender typeCode="SND">\n' +
'      <device classCode="DEV" determinerCode="INSTANCE">\n' +
'        <id extension="' + E2B_INSTITUCIONAL_FALLBACK.SENDER_SHORTNAME + '" root="2.16.840.1.113883.3.989.2.1.3.11"/>\n' +
'      </device>\n' +
'    </sender>\n' +
'    <controlActProcess classCode="CACT" moodCode="EVN">\n' +
'      <code code="PORR_TE049016UV" codeSystem="2.16.840.1.113883.1.18"/>\n' +
'      <effectiveTime value="' + agora + '"/>\n' +
'      <subject typeCode="SUBJ">\n' +
'        <investigationEvent classCode="INVSTG" moodCode="EVN">\n' +
'          <id extension="' + caso.safetyReportIdE2B + '" root="2.16.840.1.113883.3.989.2.1.3.1"/>\n' +
'          <id extension="' + caso.safetyReportIdE2B + '" root="2.16.840.1.113883.3.989.2.1.3.2"/>\n' +
'          <code code="PAT_ADV_EVNT" codeSystem="2.16.840.1.113883.5.4"/>\n' +
'          <text>' + narrativa + '</text>\n' +
'          <statusCode code="active"/>\n' +
'          <effectiveTime>\n' +
'            <low value="' + dataRecebimento + '"/>\n' +
'            <!-- C.1.4: Date Report Was First Received from Source -->\n' +
'          </effectiveTime>\n' +
'          <availabilityTime value="' + agora.substring(0, 8) + '"/>\n' +
'          <!-- C.1.5: Date of Most Recent Information -->\n' +
'\n' +
'          <component typeCode="COMP">\n' +
'            <adverseEventAssessment classCode="INVSTG" moodCode="EVN">\n' +
'              <subject1 typeCode="SBJ">\n' +
'                <primaryRole classCode="INVSBJ">\n' +
'                  <player1 classCode="PSN" determinerCode="INSTANCE">\n' +
'                    <name>' + escaparHtml_(caso.iniciais) + '</name>\n' +
(codigoSexo
  ? '                    <administrativeGenderCode code="' + codigoSexo + '" codeSystem="' + SCHEMA.E2B.CODESYS.SEXO + '"/>\n'
  : '                    <administrativeGenderCode nullFlavor="UNK"/>\n'
) +
'                    <!-- D.5 Sexo -->\n' +
(dataNascimento
  ? '                    <birthTime value="' + dataNascimento + '"/>\n'
  : ''
) +
(prontuario
  ? '                    <asIdentifiedEntity classCode="IDENT">\n' +
    '                      <id extension="' + prontuario + '" root="2.16.840.1.113883.3.989.2.1.3.9"/>\n' +
    '                      <code code="3" codeSystem="' + SCHEMA.E2B.CODESYS.FONTE_PRONTUARIO + '" displayName="Hospital Record"/>\n' +
    '                      <!-- D.1.1.3: Patient Hospital Record Number -->\n' +
    '                    </asIdentifiedEntity>\n'
  : ''
) +
'                  </player1>\n' +
'\n' +
'                  <!-- E.i Reacao -->\n' +
'                  <subjectOf2 typeCode="SBJ">\n' +
'                    <observation classCode="OBS" moodCode="EVN">\n' +
'                      <id root="' + caso.idReacaoE2B + '"/>\n' +
'                      <code code="29" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
'                      <effectiveTime xsi:type="IVL_TS">\n' +
'                        <low value="' + dataInicioReacao + '"/>\n' +
'                      </effectiveTime>\n' +
'                      <value xsi:type="CE" nullFlavor="NI">\n' +
'                        <!-- E.i.2.1b: MedDRA code — nullFlavor NI (sem licenca MedDRA) -->\n' +
'                        <originalText language="por">' + reacaoTermo + '</originalText>\n' +
'                        <!-- E.i.1.1a/E.i.1.1b: termo original, idioma ISO 639-2 -->\n' +
'                      </value>\n' +
'                      <location typeCode="LOC">\n' +
'                        <locatedEntity classCode="LOCE">\n' +
'                          <locatedPlace classCode="COUNTRY" determinerCode="INSTANCE">\n' +
'                            <code code="BR" codeSystem="' + SCHEMA.E2B.CODESYS.PAIS + '"/>\n' +
'                          </locatedPlace>\n' +
'                        </locatedEntity>\n' +
'                      </location>\n' +
blocosGravidade + '\n' +
blocoDesfecho + '\n' +
'                    </observation>\n' +
'                  </subjectOf2>\n' +
'\n' +
'                  <!-- G.k Medicamento -->\n' +
'                  <subjectOf2 typeCode="SBJ">\n' +
'                    <organizer classCode="CATEGORY" moodCode="EVN">\n' +
'                      <code code="4" codeSystem="' + SCHEMA.E2B.CODESYS.CATEGORIA_GK + '"/>\n' +
'                      <component typeCode="COMP">\n' +
'                        <substanceAdministration classCode="SBADM" moodCode="EVN">\n' +
'                          <id root="' + caso.idMedicamentoE2B + '"/>\n' +
'                          <consumable typeCode="CSM">\n' +
'                            <instanceOfKind classCode="INST">\n' +
'                              <kindOfProduct classCode="MMAT" determinerCode="KIND">\n' +
'                                <name>' + medicamento + '</name>\n' +
'                                <ingredient classCode="ACTI">\n' +
'                                  <ingredientSubstance classCode="MMAT" determinerCode="KIND">\n' +
'                                    <name>' + medicamento + '</name>\n' +
'                                  </ingredientSubstance>\n' +
'                                </ingredient>\n' +
'                              </kindOfProduct>\n' +
'                            </instanceOfKind>\n' +
'                          </consumable>\n' +
'                          <outboundRelationship2 typeCode="COMP">\n' +
'                            <substanceAdministration classCode="SBADM" moodCode="EVN">\n' +
'                              <effectiveTime xsi:type="IVL_TS">\n' +
'                                <low value="' + dataInicioAdministracao + '"/>\n' +
'                                <!-- G.k.4.r.4: Date and Time of Start of Drug -->\n' +
'                              </effectiveTime>\n' +
'                              <routeCode>\n' +
'                                <originalText>' + viaOuForma + '</originalText>\n' +
'                                <!-- G.k.4.r.10.1: Route of Administration (free text) -->\n' +
'                              </routeCode>\n' +
(dose ? '                              <doseQuantity value="' + dose + '" unit="' + doseUnidade + '"/>\n' : '') +
'                              <consumable typeCode="CSM">\n' +
'                                <instanceOfKind classCode="INST">\n' +
(lote ? '                                  <productInstanceInstance classCode="MMAT" determinerCode="INSTANCE">\n' +
       '                                    <lotNumberText>' + lote + '</lotNumberText>\n' +
       '                                    <!-- G.k.4.r.7: Batch / Lot Number -->\n' +
       '                                  </productInstanceInstance>\n' : '') +
'                                  <kindOfProduct classCode="MMAT" determinerCode="KIND">\n' +
'                                    <!-- G.k.4.r.9.1 Forma farmaceutica: em branco, nao coletado -->\n' +
'                                  </kindOfProduct>\n' +
'                                </instanceOfKind>\n' +
'                              </consumable>\n' +
'                            </substanceAdministration>\n' +
'                          </outboundRelationship2>\n' +
'                        </substanceAdministration>\n' +
'                      </component>\n' +
'                    </organizer>\n' +
'                  </subjectOf2>\n' +
'\n' +
'                </primaryRole>\n' +
'              </subject1>\n' +
'\n' +
'              <!-- G.k.1: Characterisation of Drug Role = Suspect -->\n' +
'              <component typeCode="COMP">\n' +
'                <causalityAssessment classCode="OBS" moodCode="EVN">\n' +
'                  <code code="20" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
'                  <value xsi:type="CE" code="1" codeSystem="' + SCHEMA.E2B.CODESYS.CARACTERIZACAO_DROGA + '"/>\n' +
'                  <subject2 typeCode="SUBJ">\n' +
'                    <productUseReference classCode="SBADM" moodCode="EVN">\n' +
'                      <id root="' + caso.idMedicamentoE2B + '"/>\n' +
'                    </productUseReference>\n' +
'                  </subject2>\n' +
'                </causalityAssessment>\n' +
'              </component>\n' +
'\n' +
'              <!-- Avaliacao de causalidade — Algoritmo de Naranjo -->\n' +
'              <component typeCode="COMP">\n' +
'                <causalityAssessment classCode="OBS" moodCode="EVN">\n' +
'                  <code code="39" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
'                  <value xsi:type="ST">' + naranjoClasse + '</value>\n' +
'                  <methodCode>\n' +
'                    <originalText>NARANJO ALGORITHM (score: ' + naranjoScore + ')</originalText>\n' +
'                  </methodCode>\n' +
'                  <author typeCode="AUT">\n' +
'                    <assignedEntity classCode="ASSIGNED">\n' +
'                      <code>\n' +
'                        <originalText>SENDER</originalText>\n' +
'                      </code>\n' +
'                    </assignedEntity>\n' +
'                  </author>\n' +
'                  <subject1 typeCode="SUBJ">\n' +
'                    <adverseEffectReference classCode="OBS" moodCode="EVN">\n' +
'                      <id root="' + caso.idReacaoE2B + '"/>\n' +
'                    </adverseEffectReference>\n' +
'                  </subject1>\n' +
'                  <subject2 typeCode="SUBJ">\n' +
'                    <productUseReference classCode="SBADM" moodCode="EVN">\n' +
'                      <id root="' + caso.idMedicamentoE2B + '"/>\n' +
'                    </productUseReference>\n' +
'                  </subject2>\n' +
'                </causalityAssessment>\n' +
'              </component>\n' +
'\n' +
(comentarioNotificador
  ? '              <!-- H.2: Reporter Comments (relato do notificador) -->\n' +
    '              <component1 typeCode="COMP">\n' +
    '                <observationEvent classCode="OBS" moodCode="EVN">\n' +
    '                  <code code="10" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
    '                  <value xsi:type="ED">' + comentarioNotificador + '</value>\n' +
    '                  <author typeCode="AUT">\n' +
    '                    <assignedEntity classCode="ASSIGNED">\n' +
    '                      <code code="3" codeSystem="' + SCHEMA.E2B.CODESYS.AUTOR_COMENTARIO + '" displayName="sourceReporter"/>\n' +
    '                    </assignedEntity>\n' +
    '                  </author>\n' +
    '                </observationEvent>\n' +
    '              </component1>\n' +
    '\n'
  : ''
) +
(comentarioSender
  ? '              <!-- H.4: Sender Comments (conclusao do farmaceutico) -->\n' +
    '              <component1 typeCode="COMP">\n' +
    '                <observationEvent classCode="OBS" moodCode="EVN">\n' +
    '                  <code code="10" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
    '                  <value xsi:type="ED">' + comentarioSender + '</value>\n' +
    '                  <author typeCode="AUT">\n' +
    '                    <assignedEntity classCode="ASSIGNED">\n' +
    '                      <code code="1" codeSystem="' + SCHEMA.E2B.CODESYS.AUTOR_COMENTARIO + '" displayName="sender"/>\n' +
    '                    </assignedEntity>\n' +
    '                  </author>\n' +
    '                </observationEvent>\n' +
    '              </component1>\n' +
    '\n'
  : ''
) +
'            </adverseEventAssessment>\n' +
'          </component>\n' +
'\n' +
'          <!-- C.1.6.1: Are Additional Documents Available? -->\n' +
'          <component typeCode="COMP">\n' +
'            <observationEvent classCode="OBS" moodCode="EVN">\n' +
'              <code code="1" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
'              <value xsi:type="BL" value="false"/>\n' +
'            </observationEvent>\n' +
'          </component>\n' +
'\n' +
'          <!-- C.1.7: Fulfils Local Criteria for Expedited Report? -->\n' +
'          <component typeCode="COMP">\n' +
'            <observationEvent classCode="OBS" moodCode="EVN">\n' +
'              <code code="23" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
'              <value xsi:type="BL" value="false"/>\n' +
'            </observationEvent>\n' +
'          </component>\n' +
'\n' +
'          <!-- C.1.8.2: First Sender of This Case = 2 (Other) -->\n' +
'          <outboundRelationship typeCode="SPRT">\n' +
'            <relatedInvestigation classCode="INVSTG" moodCode="EVN">\n' +
'              <code code="1" codeSystem="' + SCHEMA.E2B.CODESYS.FIRST_SENDER + '"/>\n' +
'              <subjectOf2 typeCode="SUBJ">\n' +
'                <controlActEvent classCode="CACT" moodCode="EVN">\n' +
'                  <author typeCode="AUT">\n' +
'                    <assignedEntity classCode="ASSIGNED">\n' +
'                      <code code="2" codeSystem="' + SCHEMA.E2B.CODESYS.FIRST_SENDER + '"/>\n' +
'                    </assignedEntity>\n' +
'                  </author>\n' +
'                </controlActEvent>\n' +
'              </subjectOf2>\n' +
'            </relatedInvestigation>\n' +
'          </outboundRelationship>\n' +
'\n' +
'          <!-- C.2.r: Primary Source / Notificador inicial -->\n' +
'          <outboundRelationship typeCode="SPRT">\n' +
'            <priorityNumber value="1"/>\n' +
'            <!-- C.2.r.5: Primary Source for Regulatory Purposes -->\n' +
'            <relatedInvestigation classCode="INVSTG" moodCode="EVN">\n' +
'              <code code="2" codeSystem="' + SCHEMA.E2B.CODESYS.FIRST_SENDER + '"/>\n' +
'              <subjectOf2 typeCode="SUBJ">\n' +
'                <controlActEvent classCode="CACT" moodCode="EVN">\n' +
'                  <author typeCode="AUT">\n' +
'                    <assignedEntity classCode="ASSIGNED">\n' +
'                      <addr>\n' +
'                        <city>' + E2B_INSTITUCIONAL_FALLBACK.CIDADE + '</city>\n' +
'                        <state>' + E2B_INSTITUCIONAL_FALLBACK.ESTADO + '</state>\n' +
'                      </addr>\n' +
'                      <telecom value="mailto:' + escaparHtml_(emailNotificador) + '"/>\n' +
'                      <assignedPerson classCode="PSN" determinerCode="INSTANCE">\n' +
'                        <name>\n' +
'                          <given>' + escaparHtml_(nomeSender.given) + '</given>\n' +
'                          <family>' + escaparHtml_(nomeSender.family) + '</family>\n' +
'                        </name>\n' +
'                        <!-- C.2.r.1.2/C.2.r.1.4: notificador primario = farmaceutico logado.\n' +
'                             Decisao LGPD: NAO expor PII do notificador externo da assistencia;\n' +
'                             a Farmacia e a fonte primaria perante o VigiMed (coerente com\n' +
'                             C.2.r.4 = 2 e com o telecom acima). -->\n' +
'                        <asQualifiedEntity classCode="QUAL">\n' +
'                          <code code="' + codigoQualificacao + '" codeSystem="' + SCHEMA.E2B.CODESYS.QUALIFICACAO_NOTIF + '"/>\n' +
'                        </asQualifiedEntity>\n' +
'                        <asLocatedEntity classCode="LOCE">\n' +
'                          <location classCode="COUNTRY" determinerCode="INSTANCE">\n' +
'                            <code code="BR" codeSystem="' + SCHEMA.E2B.CODESYS.PAIS + '"/>\n' +
'                          </location>\n' +
'                        </asLocatedEntity>\n' +
'                      </assignedPerson>\n' +
'                      <representedOrganization classCode="ORG" determinerCode="INSTANCE">\n' +
'                        <name>' + escaparHtml_(E2B_INSTITUCIONAL_FALLBACK.DEPARTAMENTO) + '</name>\n' +
'                        <assignedEntity classCode="ASSIGNED">\n' +
'                          <representedOrganization classCode="ORG" determinerCode="INSTANCE">\n' +
'                            <name>' + escaparHtml_(E2B_INSTITUCIONAL_FALLBACK.NOME_OFICIAL) + '</name>\n' +
'                          </representedOrganization>\n' +
'                        </assignedEntity>\n' +
'                      </representedOrganization>\n' +
'                    </assignedEntity>\n' +
'                  </author>\n' +
'                </controlActEvent>\n' +
'              </subjectOf2>\n' +
'            </relatedInvestigation>\n' +
'          </outboundRelationship>\n' +
'\n' +
'          <!-- C.3: Sender (Remetente) -->\n' +
'          <subjectOf1 typeCode="SUBJ">\n' +
'            <controlActEvent classCode="CACT" moodCode="EVN">\n' +
'              <author typeCode="AUT">\n' +
'                <assignedEntity classCode="ASSIGNED">\n' +
'                  <code code="3" codeSystem="' + SCHEMA.E2B.CODESYS.SENDER_TYPE + '"/>\n' +
'                  <!-- C.3.1 Sender Type = 3 Health Professional ("Recebido de": Profissional de Saude) -->\n' +
'                  <addr>\n' +
'                    <city>' + E2B_INSTITUCIONAL_FALLBACK.CIDADE + '</city>\n' +
'                    <state>' + E2B_INSTITUCIONAL_FALLBACK.ESTADO + '</state>\n' +
'                  </addr>\n' +
'                  <telecom value="mailto:' + escaparHtml_(emailSender) + '"/>\n' +
'                  <assignedPerson classCode="PSN" determinerCode="INSTANCE">\n' +
'                    <name>\n' +
'                      <given>' + escaparHtml_(nomeSender.given) + '</given>\n' +
'                      <family>' + escaparHtml_(nomeSender.family) + '</family>\n' +
'                    </name>\n' +
'                    <asLocatedEntity classCode="LOCE">\n' +
'                      <location classCode="COUNTRY" determinerCode="INSTANCE">\n' +
'                        <code code="BR" codeSystem="' + SCHEMA.E2B.CODESYS.PAIS + '"/>\n' +
'                      </location>\n' +
'                    </asLocatedEntity>\n' +
'                  </assignedPerson>\n' +
'                  <representedOrganization classCode="ORG" determinerCode="INSTANCE">\n' +
'                    <name>' + escaparHtml_(E2B_INSTITUCIONAL_FALLBACK.DEPARTAMENTO) + '</name>\n' +
'                    <assignedEntity classCode="ASSIGNED">\n' +
'                      <representedOrganization classCode="ORG" determinerCode="INSTANCE">\n' +
'                        <name>' + escaparHtml_(E2B_INSTITUCIONAL_FALLBACK.ORGANIZACAO) + '</name>\n' +
'                      </representedOrganization>\n' +
'                    </assignedEntity>\n' +
'                  </representedOrganization>\n' +
'                </assignedEntity>\n' +
'              </author>\n' +
'            </controlActEvent>\n' +
'          </subjectOf1>\n' +
'\n' +
'          <!-- C.1.3: Type of Report = 1 Spontaneous -->\n' +
'          <subjectOf2 typeCode="SUBJ">\n' +
'            <investigationCharacteristic classCode="OBS" moodCode="EVN">\n' +
'              <code code="1" codeSystem="2.16.840.1.113883.3.989.2.1.1.23"/>\n' +
'              <value xsi:type="CE" code="1" codeSystem="' + SCHEMA.E2B.CODESYS.TIPO_RELATO + '"/>\n' +
'            </investigationCharacteristic>\n' +
'          </subjectOf2>\n' +
'\n' +
'          <!-- C.1.9.1: Other Case Identifiers in Previous Transmissions -->\n' +
'          <subjectOf2 typeCode="SUBJ">\n' +
'            <investigationCharacteristic classCode="OBS" moodCode="EVN">\n' +
'              <code code="2" codeSystem="2.16.840.1.113883.3.989.2.1.1.23"/>\n' +
'              <value xsi:type="BL" value="false"/>\n' +
'            </investigationCharacteristic>\n' +
'          </subjectOf2>\n' +
'\n' +
'        </investigationEvent>\n' +
'      </subject>\n' +
'    </controlActProcess>\n' +
'  </PORR_IN049016UV>\n' +
'  <receiver typeCode="RCV">\n' +
'    <device classCode="DEV" determinerCode="INSTANCE">\n' +
'      <id extension="ANVISA" root="2.16.840.1.113883.3.989.2.1.3.14"/>\n' +
'    </device>\n' +
'  </receiver>\n' +
'  <sender typeCode="SND">\n' +
'    <device classCode="DEV" determinerCode="INSTANCE">\n' +
'      <id extension="' + E2B_INSTITUCIONAL_FALLBACK.SENDER_SHORTNAME + '" root="2.16.840.1.113883.3.989.2.1.3.13"/>\n' +
'    </device>\n' +
'  </sender>\n' +
'</MCCI_IN200100UV01>\n'
  );
}
```

---

## 📄 Arquivo [9/32]: EXPORT COD.gs

```javascript
/**
 * SCRIPT SÉNIOR: Exportação de Código para Markdown (.md)
 * Versão: Otimizada para Documentação, Backup Estruturado e Correção de URL
 */
function exportarProjetoCompletoParaMD() {
  try {
    const scriptId = ScriptApp.getScriptId();
    const token = ScriptApp.getOAuthToken();
    
    let nomeProjeto = "Projeto_Apps_Script";
    try {
      nomeProjeto = DriveApp.getFileById(scriptId).getName();
    } catch(e) {
      Logger.log("Aviso: Não foi possível capturar o nome do arquivo via DriveApp.");
    }
    
    // CORREÇÃO APLICADA: Uso do encodeURI para limpar qualquer espaço ou caractere invisível
    const url = encodeURI("https://script.googleapis.com/v1/projects/" + scriptId + "/content");
    
    const opcoes = {
      method: "GET", // CORREÇÃO APLICADA: Escrito em maiúsculas
      headers: {
        "Authorization": "Bearer " + token
      },
      muteHttpExceptions: true
    };
    
    const resposta = UrlFetchApp.fetch(url, opcoes);
    const respostaTexto = resposta.getContentText();
    const statusCode = resposta.getResponseCode();
    
    // 🔍 JANELA DE DIAGNÓSTICO NO CONSOLA
    Logger.log("============================ DEBUG API ============================");
    Logger.log("Código de Estado HTTP: " + statusCode);
    Logger.log("Resposta Real do Google: " + respostaTexto);
    Logger.log("===================================================================");
    
    const resultado = JSON.parse(respostaTexto);
    
    // Se o Google retornou um objeto de erro estruturado
    if (resultado.error) {
      throw new Error(`[API Error ${resultado.error.code}]: ${resultado.error.message}`);
    }
    
    if (!resultado.files || resultado.files.length === 0) {
      throw new Error("A API não devolveu nenhum arquivo de código.");
    }
    
    const dataAtual = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm");
    
    // Iniciar a estrutura do documento Markdown
    let mdContext = '# RELATÓRIO DE CONSOLIDAÇÃO DE CÓDIGO FONTE\n\n';
    mdContext += '## 📋 Informações do Projeto\n';
    mdContext += '- **Sistema/Folha de Cálculo:** ' + nomeProjeto + '\n';
    mdContext += '- **ID do Projeto Script:** `' + scriptId + '`\n';
    mdContext += '- **Compilado em:** ' + dataAtual + '\n\n';
    mdContext += '---\n\n';
    
    const arquivosOrdenados = resultado.files.sort((a, b) => a.name.localeCompare(b.name));
    
    arquivosOrdenados.forEach((arquivo, index) => {
      let extensao = ".gs";
      let linguagemMarkdown = "javascript"; // Sintaxe recomendada para .gs no Markdown
      
      if (arquivo.type === "HTML") {
        extensao = ".html";
        linguagemMarkdown = "html";
      }
      if (arquivo.name === "appsscript") {
        extensao = ".json";
        linguagemMarkdown = "json";
      }
      
      const nomeCompletoArquivo = arquivo.name + extensao;
      
      mdContext += '## 📄 Arquivo [' + (index + 1) + '/' + arquivosOrdenados.length + ']: ' + nomeCompletoArquivo + '\n\n';
      
      let codigoTratado = arquivo.source ? arquivo.source : "// Arquivo sem conteúdo estruturado.";
      
      // Insere o código dentro de um bloco de código Markdown com realce de sintaxe
      mdContext += '```' + linguagemMarkdown + '\n' + codigoTratado + '\n```\n\n';
      
      if (index < arquivosOrdenados.length - 1) {
        mdContext += '---\n\n'; // Separador visual entre os arquivos
      }
    });
    
    const nomeMd = "BACKUP_CODIGO_" + nomeProjeto.toUpperCase().replace(/\s+/g, "_") + ".md";
    
    // Cria o Blob como text/markdown e guarda diretamente no Google Drive
    const mdBlob = Utilities.newBlob(mdContext, "text/markdown", nomeMd);
    DriveApp.createFile(mdBlob);
    
    Logger.log("=========================================");
    Logger.log("✅ EXPORTAÇÃO CONCLUÍDA COM SUCESSO!");
    Logger.log("=========================================");
    Logger.log("Nome do arquivo Markdown no Drive: " + nomeMd);
    
  } catch (erro) {
    Logger.log("=========================================");
    Logger.log("❌ FALHA NA EXPORTAÇÃO");
    Logger.log("=========================================");
    Logger.log("Detalhes do Erro: " + erro.toString());
  }
}
```

---

## 📄 Arquivo [10/32]: Favicon.html

```html
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='48' fill='%230f766e'/%3E%3Cpath fill='white' d='M50 20a6 6 0 0 1 6 6v18h18a6 6 0 0 1 0 12H56v18a6 6 0 0 1-12 0V56H26a6 6 0 0 1 0-12h18V26a6 6 0 0 1 6-6z'/%3E%3C/svg%3E">
```

---

## 📄 Arquivo [11/32]: Firestore.gs

```javascript
/**
 * @fileoverview Firestore.gs — Camada de acesso ao Cloud Firestore (modo Nativo)
 * via API REST, autenticada por Service Account (JWT/OAuth2).
 *
 * DEPENDÊNCIAS:
 *   - Biblioteca "OAuth2 for Apps Script"
 *     Script ID: 1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF
 *   - Script Properties: FIRESTORE_PROJECT_ID, FIRESTORE_CLIENT_EMAIL,
 *     FIRESTORE_PRIVATE_KEY (opcional: FIRESTORE_DATABASE_ID)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * FIX 07/2026 — URLs de método custom (:beginTransaction, :commit,
 * :runQuery) exigem "/documents" no path. Código antigo removia via
 * .replace('/documents','') → URL inexistente → 404 HTML genérico do
 * Google (não JSON do Firestore). Triagem/investigação falhavam na
 * transação. Corrigido em fsRunTransaction_ e fsQuery_.
 *
 * Otimizações mantidas: P0 paginação fsListarTodos_, P2 fsListarComMascara_
 * (field mask), P3 fsSetDoc_ sem leitura prévia redundante.
 * ═══════════════════════════════════════════════════════════════════════
 */

const FS_BASE_URL = 'https://firestore.googleapis.com/v1';

function fsConfig_() {
  const props = PropertiesService.getScriptProperties();
  const projectId  = props.getProperty('FIRESTORE_PROJECT_ID');
  const clientEmail = props.getProperty('FIRESTORE_CLIENT_EMAIL');
  let   privateKey  = props.getProperty('FIRESTORE_PRIVATE_KEY');
  const databaseId = props.getProperty('FIRESTORE_DATABASE_ID') || '(default)';

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Firestore.gs: Script Properties ausentes. Verifique FIRESTORE_PROJECT_ID, ' +
      'FIRESTORE_CLIENT_EMAIL e FIRESTORE_PRIVATE_KEY em Configurações do Projeto.'
    );
  }

  privateKey = privateKey.replace(/\\n/g, '\n');

  return { projectId: projectId, clientEmail: clientEmail, privateKey: privateKey, databaseId: databaseId };
}

function fsServicoOAuth_() {
  const cfg = fsConfig_();
  return OAuth2.createService('FirestoreVigiRAM')
    .setTokenUrl('https://oauth2.googleapis.com/token')
    .setPrivateKey(cfg.privateKey)
    .setIssuer(cfg.clientEmail)
    .setPropertyStore(PropertiesService.getScriptProperties())
    .setCache(CacheService.getScriptCache()) // evita hit no PropertiesService a cada request
    .setScope('https://www.googleapis.com/auth/datastore');
}

function fsAccessToken_() {
  const servico = fsServicoOAuth_();
  if (!servico.hasAccess()) {
    throw new Error('Firestore.gs: falha de autenticação OAuth2 — ' + servico.getLastError());
  }
  return servico.getAccessToken();
}

function fsUrlBase_() {
  const cfg = fsConfig_();
  return FS_BASE_URL + '/projects/' + cfg.projectId + '/databases/' + cfg.databaseId + '/documents';
}

const FS_FETCH_MAX_TENTATIVAS_GET = 3; // backoff só para leituras (idempotentes)

function fsFetch_(metodo, url, corpo) {
  const opcoes = {
    method: metodo,
    headers: { Authorization: 'Bearer ' + fsAccessToken_() },
    contentType: 'application/json',
    muteHttpExceptions: true
  };
  if (corpo !== undefined && corpo !== null) {
    opcoes.payload = JSON.stringify(corpo);
  }

  // Backoff exponencial APENAS para GET (idempotente) em 429/500/503.
  // Escritas (patch/post/delete) NÃO são reexecutadas aqui — retry de
  // escrita é responsabilidade da transação (fsRunTransaction_) ou da
  // fila do Mirror, para não duplicar efeitos colaterais.
  const ehGet = String(metodo).toLowerCase() === 'get';
  const maxTentativas = ehGet ? FS_FETCH_MAX_TENTATIVAS_GET : 1;

  let status, texto;
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    const resposta = UrlFetchApp.fetch(url, opcoes);
    status = resposta.getResponseCode();
    texto  = resposta.getContentText();

    if (status >= 200 && status < 300) {
      return texto ? JSON.parse(texto) : null;
    }
    const transitorio = (status === 429 || status === 500 || status === 503);
    if (ehGet && transitorio && tentativa < maxTentativas) {
      Utilities.sleep(400 * Math.pow(2, tentativa - 1)); // 400ms, 800ms
      continue;
    }
    break;
  }
  throw new Error('Firestore.gs: HTTP ' + status + ' em ' + url + ' → ' + texto);
}

function fsParaValorFs_(valor) {
  if (valor === null || valor === undefined) return { nullValue: null };
  if (typeof valor === 'boolean') return { booleanValue: valor };
  if (typeof valor === 'number') {
    return Number.isInteger(valor) ? { integerValue: String(valor) } : { doubleValue: valor };
  }
  if (valor instanceof Date) return { timestampValue: valor.toISOString() };
  if (typeof valor === 'string') return { stringValue: valor };
  if (Array.isArray(valor)) {
    return { arrayValue: { values: valor.map(fsParaValorFs_) } };
  }
  if (typeof valor === 'object') {
    const campos = {};
    Object.keys(valor).forEach(function (chave) {
      campos[chave] = fsParaValorFs_(valor[chave]);
    });
    return { mapValue: { fields: campos } };
  }
  return { stringValue: String(valor) };
}

function fsParaCamposFs_(objeto) {
  const campos = {};
  Object.keys(objeto || {}).forEach(function (chave) {
    campos[chave] = fsParaValorFs_(objeto[chave]);
  });
  return campos;
}

function fsDeValorFs_(valorFs) {
  if (!valorFs) return null;
  if ('nullValue' in valorFs) return null;
  if ('booleanValue' in valorFs) return valorFs.booleanValue;
  if ('integerValue' in valorFs) return Number(valorFs.integerValue);
  if ('doubleValue' in valorFs) return valorFs.doubleValue;
  if ('timestampValue' in valorFs) return new Date(valorFs.timestampValue);
  if ('stringValue' in valorFs) return valorFs.stringValue;
  if ('arrayValue' in valorFs) {
    const vals = (valorFs.arrayValue.values || []);
    return vals.map(fsDeValorFs_);
  }
  if ('mapValue' in valorFs) {
    return fsDeCamposFs_(valorFs.mapValue.fields || {});
  }
  return null;
}

function fsDeCamposFs_(camposFs) {
  const objeto = {};
  Object.keys(camposFs || {}).forEach(function (chave) {
    objeto[chave] = fsDeValorFs_(camposFs[chave]);
  });
  return objeto;
}

function fsIdDoNome_(nomeCompleto) {
  const partes = String(nomeCompleto || '').split('/');
  return partes[partes.length - 1];
}

function fsGetDoc_(colecao, id) {
  const url = fsUrlBase_() + '/' + colecao + '/' + encodeURIComponent(id);
  const opcoes = {
    method: 'get',
    headers: { Authorization: 'Bearer ' + fsAccessToken_() },
    muteHttpExceptions: true
  };
  const resposta = UrlFetchApp.fetch(url, opcoes);
  const status = resposta.getResponseCode();
  if (status === 404) return null;
  if (status < 200 || status >= 300) {
    throw new Error('Firestore.gs (fsGetDoc_): HTTP ' + status + ' → ' + resposta.getContentText());
  }
  const doc = JSON.parse(resposta.getContentText());
  const objeto = fsDeCamposFs_(doc.fields || {});
  objeto._id = fsIdDoNome_(doc.name);
  return objeto;
}

function fsSetDoc_(colecao, id, dados) {
  const url = fsUrlBase_() + '/' + colecao + '/' + encodeURIComponent(id);
  const corpo = { fields: fsParaCamposFs_(dados) };
  return fsFetch_('patch', url, corpo);
}

function fsUpdateDoc_(colecao, id, camposParciais) {
  const nomesCampos = Object.keys(camposParciais);
  const mascara = nomesCampos.map(function (c) { return 'updateMask.fieldPaths=' + encodeURIComponent(c); }).join('&');
  const url = fsUrlBase_() + '/' + colecao + '/' + encodeURIComponent(id) + '?' + mascara;
  const corpo = { fields: fsParaCamposFs_(camposParciais) };
  return fsFetch_('patch', url, corpo);
}

function fsDeleteDoc_(colecao, id) {
  const url = fsUrlBase_() + '/' + colecao + '/' + encodeURIComponent(id);
  return fsFetch_('delete', url, null);
}

function fsDeleteCampos_(colecao, id, nomesCampos) {
  const camposVazios = {};
  nomesCampos.forEach(function (c) { camposVazios[c] = null; });
  return fsUpdateDoc_(colecao, id, camposVazios);
}

/** FIX: url sem strip de /documents — parent do runQuery exige /documents. */
function fsQuery_(colecao, filtros, limite) {
  const corpo = {
    structuredQuery: {
      from: [{ collectionId: colecao }],
      limit: limite || undefined
    }
  };

  if (filtros && filtros.length === 1) {
    corpo.structuredQuery.where = {
      fieldFilter: {
        field: { fieldPath: filtros[0].campo },
        op: filtros[0].op || 'EQUAL',
        value: fsParaValorFs_(filtros[0].valor)
      }
    };
  } else if (filtros && filtros.length > 1) {
    corpo.structuredQuery.where = {
      compositeFilter: {
        op: 'AND',
        filters: filtros.map(function (f) {
          return {
            fieldFilter: {
              field: { fieldPath: f.campo },
              op: f.op || 'EQUAL',
              value: fsParaValorFs_(f.valor)
            }
          };
        })
      }
    };
  }

  const url = fsUrlBase_() + ':runQuery';
  const resultado = fsFetch_('post', url, corpo);

  return (resultado || [])
    .filter(function (r) { return r.document; })
    .map(function (r) {
      const objeto = fsDeCamposFs_(r.document.fields || {});
      objeto._id = fsIdDoNome_(r.document.name);
      return objeto;
    });
}

/** P0: pagina via nextPageToken — sem isso, coleção grande truncava silenciosamente. */
function fsListarTodos_(colecao) {
  const documentos = [];
  let pageToken = null;

  do {
    const url = fsUrlBase_() + '/' + colecao
      + '?pageSize=300'
      + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const resultado = fsFetch_('get', url, null);
    (resultado.documents || []).forEach(function (doc) {
      documentos.push(doc);
    });
    pageToken = resultado.nextPageToken || null;
  } while (pageToken);

  return documentos.map(function (doc) {
    const objeto = fsDeCamposFs_(doc.fields || {});
    objeto._id = fsIdDoNome_(doc.name);
    return objeto;
  });
}

/** P2: paginação + field mask — reduz payload em leitura de lista (Kanban). */
function fsListarComMascara_(colecao, camposMascara) {
  const maskParams = (camposMascara || [])
    .map(function (c) { return 'mask.fieldPaths=' + encodeURIComponent(c); })
    .join('&');

  const documentos = [];
  let pageToken = null;

  do {
    let url = fsUrlBase_() + '/' + colecao + '?pageSize=300';
    if (maskParams) url += '&' + maskParams;
    if (pageToken)  url += '&pageToken=' + encodeURIComponent(pageToken);

    const resultado = fsFetch_('get', url, null);
    (resultado.documents || []).forEach(function (doc) {
      documentos.push(doc);
    });
    pageToken = resultado.nextPageToken || null;
  } while (pageToken);

  return documentos.map(function (doc) {
    const objeto = fsDeCamposFs_(doc.fields || {});
    objeto._id = fsIdDoNome_(doc.name);
    return objeto;
  });
}

const FS_TRANSACAO_MAX_TENTATIVAS = 5;

/** FIX: begin/commit urls sem strip de /documents. */
function fsRunTransaction_(operacao) {
  const urlBegin = fsUrlBase_() + ':beginTransaction';

  for (let tentativa = 1; tentativa <= FS_TRANSACAO_MAX_TENTATIVAS; tentativa++) {
    const inicio = fsFetch_('post', urlBegin, {});
    const transacaoId = inicio.transaction;
    const escritasAcumuladas = [];

    try {
      const resultadoOperacao = operacao({
        id: transacaoId,
        acumularEscrita: function (write) { escritasAcumuladas.push(write); }
      });

      const urlCommit = fsUrlBase_() + ':commit';
      fsFetch_('post', urlCommit, {
        writes: escritasAcumuladas,
        transaction: transacaoId
      });

      return resultadoOperacao;

    } catch (erro) {
      const mensagem = String(erro && erro.message || erro);
      const ehConflito = mensagem.indexOf('ABORTED') !== -1 || mensagem.indexOf('409') !== -1;
      if (ehConflito && tentativa < FS_TRANSACAO_MAX_TENTATIVAS) {
        Utilities.sleep(150 * tentativa);
        continue;
      }
      throw erro;
    }
  }
}

function fsTxnGetDoc_(transacaoId, colecao, id) {
  const url = fsUrlBase_() + '/' + colecao + '/' + encodeURIComponent(id) + '?transaction=' + encodeURIComponent(transacaoId);
  const opcoes = {
    method: 'get',
    headers: { Authorization: 'Bearer ' + fsAccessToken_() },
    muteHttpExceptions: true
  };
  const resposta = UrlFetchApp.fetch(url, opcoes);
  const status = resposta.getResponseCode();
  if (status === 404) return null;
  if (status < 200 || status >= 300) {
    throw new Error('Firestore.gs (fsTxnGetDoc_): HTTP ' + status + ' → ' + resposta.getContentText());
  }
  const doc = JSON.parse(resposta.getContentText());
  const objeto = fsDeCamposFs_(doc.fields || {});
  objeto._id = fsIdDoNome_(doc.name);
  return objeto;
}

function fsTxnUpdateDoc_(ctx, colecao, id, camposParciais) {
  const cfg = fsConfig_();
  const nomeDoc = 'projects/' + cfg.projectId + '/databases/' + cfg.databaseId + '/documents/' + colecao + '/' + id;
  ctx.acumularEscrita({
    update: { name: nomeDoc, fields: fsParaCamposFs_(camposParciais) },
    updateMask: { fieldPaths: Object.keys(camposParciais) }
  });
}

function fsTxnSetDoc_(ctx, colecao, id, dados) {
  const cfg = fsConfig_();
  const nomeDoc = 'projects/' + cfg.projectId + '/databases/' + cfg.databaseId + '/documents/' + colecao + '/' + id;
  ctx.acumularEscrita({
    update: { name: nomeDoc, fields: fsParaCamposFs_(dados) }
  });
}

function fsLocalizarCaso_(idCaso) {
  return fsGetDoc_(SCHEMA.FS.CASOS, String(idCaso).trim());
}

function fsCarimbarAuditoria_(ctx, idCaso, origem) {
  const quem = origem || usuarioAtual_();
  // CORREÇÃO: a versão anterior passava chaves com ponto
  // ('auditoria.atualizadoPor') dentro de `fields`. Na REST API do Firestore,
  // as chaves do mapa `fields` são NOMES LITERAIS de campo (um ponto na chave
  // cria um campo cujo nome contém ponto), enquanto updateMask.fieldPaths
  // interpreta 'auditoria.atualizadoPor' como caminho ANINHADO. Resultado:
  // a máscara apontava para um caminho ausente no documento enviado —
  // comportamento indefinido/perigoso (pode apagar o subcampo em vez de
  // gravá-lo). Agora envia o mapa aninhado real com máscara 'auditoria'
  // (o mapa de auditoria contém exatamente estes dois campos, então a
  // substituição do mapa inteiro é segura e determinística).
  fsTxnUpdateDoc_(ctx, SCHEMA.FS.CASOS, idCaso, {
    auditoria: {
      atualizadoPor: quem,
      atualizadoEm: new Date()
    }
  });
}

function fsRegistrarLog_(acao, idCaso, detalhe) {
  try {
    const idLog   = Utilities.getUuid();
    const payload = {
      data:    new Date(),
      usuario: usuarioAtual_(),
      acao:    acao,
      idCaso:  idCaso  || '',
      detalhe: detalhe || ''
    };

    fsSetDoc_(SCHEMA.FS.LOG, idLog, payload);
    espelharLogNoSheets_(payload);

  } catch (e) {
    console.error('Falha ao registrar log (Firestore): ' + e.message);
  }
}

function fsTestarConexao() {
  const idTeste = 'teste_conexao_' + new Date().getTime();
  fsSetDoc_(SCHEMA.FS.LOG, idTeste, {
    data: new Date(),
    usuario: 'fsTestarConexao_',
    acao: 'TESTE_CONEXAO',
    detalhe: 'Se você está vendo isso na coleção de log no Firestore, a conexão está OK.'
  });
  const lido = fsGetDoc_(SCHEMA.FS.LOG, idTeste);
  Logger.log(JSON.stringify(lido));
  fsDeleteDoc_(SCHEMA.FS.LOG, idTeste);
  Logger.log('fsTestarConexao_: OK — escrita, leitura e exclusão funcionaram.');
  return true;
}

/**
 * SCHEMA.FS (anexo Schema.gs):
 * { CASOS:'casos_ram', GERAL:'config_geral', SETORES:'setores',
 *   LISTAS:'listas', NARANJO:'naranjo', LOG:'log_auditoria', USUARIOS:'usuarios' }
 */
```

---

## 📄 Arquivo [12/32]: form.html

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>Notificação de RAM · VigiRAM</title>
  <?!= include('Favicon'); ?>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
  <style>
    input[type=number]::-webkit-inner-spin-button,
    input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
    #barraProgresso { transition: width .35s ease; }
    .cat-pill.ativo {
      background-color: #0f766e;
      color: #ffffff;
      border-color: #0f766e;
    }
    textarea.auto { overflow: hidden; }
    select:focus { outline: none; }
    .painel { animation: fadeUp .2s ease both; }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    #bannerErro { animation: fadeUp .2s ease both; }
  </style>
</head>

<body class="bg-slate-100 font-sans min-h-screen flex flex-col items-center justify-start py-6 px-4"
      onload="inicializar()">

  <div class="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden">

    <!-- CABEÇALHO -->
    <div class="bg-teal-700 px-6 py-5 text-white">
      <div class="flex items-center gap-3 mb-1">
        <div class="w-10 h-10 bg-white rounded-full flex items-center justify-center shadow flex-shrink-0">
          <i class="fas fa-notes-medical text-teal-700 text-lg"></i>
        </div>
        <div>
          <h1 class="text-lg font-bold leading-tight tracking-tight">VigiRAM · HRN</h1>
          <p class="text-teal-200 text-xs">Notificação de Reação Adversa a Medicamentos</p>
        </div>
      </div>
    </div>

    <!-- BARRA DE PROGRESSO + ETAPAS -->
    <div class="bg-teal-800 px-5 pb-3 pt-2">
      <div class="flex justify-between items-center mb-1.5">
        <span id="lblEtapa" class="text-xs font-semibold text-teal-200">Etapa 1 de 3 · Paciente</span>
        <span id="lblPct" class="text-xs text-teal-300">0%</span>
      </div>
      <div class="w-full bg-teal-900 rounded-full h-1.5 overflow-hidden">
        <div id="barraProgresso" class="h-1.5 rounded-full bg-orange-400" style="width:0%"></div>
      </div>
      <div class="flex justify-around mt-2.5">
        <button type="button" onclick="irParaEtapa(1)"
                class="flex flex-col items-center gap-0.5 group" aria-label="Etapa 1: Paciente">
          <span id="dot1" class="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold
                                  bg-white text-teal-700 shadow">1</span>
          <span class="text-[9px] text-white font-medium">Paciente</span>
        </button>
        <button type="button" onclick="irParaEtapa(2)"
                class="flex flex-col items-center gap-0.5 group" aria-label="Etapa 2: Evento">
          <span id="dot2" class="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold
                                  bg-teal-600 text-teal-200">2</span>
          <span class="text-[9px] text-teal-300 font-medium">Evento</span>
        </button>
        <button type="button" onclick="irParaEtapa(3)"
                class="flex flex-col items-center gap-0.5 group" aria-label="Etapa 3: Você">
          <span id="dot3" class="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold
                                  bg-teal-600 text-teal-200">3</span>
          <span class="text-[9px] text-teal-300 font-medium">Você</span>
        </button>
      </div>
    </div>

    <!-- ═══ ÁREA DO FORMULÁRIO ═══ -->
    <div id="areaFormulario" class="px-5 py-5">

      <!-- ─── ETAPA 1: PACIENTE ─────────────────── -->
      <div id="etapa1" class="painel space-y-4">

        <div class="bg-teal-50 border border-teal-200 rounded-xl px-4 py-3 flex items-start gap-2 text-xs text-teal-800">
          <i class="fas fa-info-circle mt-0.5 text-teal-500 flex-shrink-0"></i>
          <span>Preencha rapidamente — a Farmácia Clínica realiza o detalhamento da investigação.</span>
        </div>

        <div>
          <label class="block text-xs font-bold text-gray-600 mb-1.5 uppercase tracking-wider">
            Prontuário <span class="text-red-500">*</span>
          </label>
          <div class="relative">
            <i class="fas fa-id-card absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm"></i>
            <input type="tel" id="iptProntuario" inputmode="numeric" pattern="[0-9]*"
                   required autocomplete="off"
                   placeholder="Ex: 123456"
                   oninput="this.value=this.value.replace(/\D/g,''); validarProntuario(); _salvarRascunho();"
                   class="w-full pl-9 pr-4 py-3 border border-gray-300 rounded-xl text-sm bg-gray-50
                          focus:bg-white focus:ring-2 focus:ring-teal-500 focus:border-teal-500
                          outline-none transition-all text-gray-800">
          </div>
          <p id="hintProntuario" aria-live="polite" class="text-xs text-gray-400 mt-1">Apenas números</p>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-bold text-gray-600 mb-1.5 uppercase tracking-wider">
              Iniciais do paciente <span class="text-red-500">*</span>
            </label>
            <input type="text" id="iptIniciais" required maxlength="12"
                   placeholder="A.B.C.D"
                   oninput="this.value=this.value.toUpperCase(); _salvarRascunho();"
                   class="w-full px-3 py-3 border border-gray-300 rounded-xl text-sm bg-gray-50
                          focus:bg-white focus:ring-2 focus:ring-teal-500 focus:border-teal-500
                          outline-none transition-all text-gray-800 tracking-widest">
            <p class="text-[10px] text-gray-400 mt-1"></p>
          </div>
          <div>
            <label class="block text-xs font-bold text-gray-600 mb-1.5 uppercase tracking-wider">
              Nascimento
            </label>
            <input type="date" id="iptNascimento"
                   oninput="validarNascimento(); _salvarRascunho();"
                   class="w-full px-3 py-3 border border-gray-300 rounded-xl text-sm bg-gray-50
                          focus:bg-white focus:ring-2 focus:ring-teal-500 focus:border-teal-500
                          outline-none transition-all text-gray-800">
            <p id="hintNascimento" aria-live="polite" class="text-[10px] text-gray-400 mt-1"></p>
          </div>
        </div>

        <button type="button" onclick="avancar(1)"
                class="w-full bg-teal-600 hover:bg-teal-700 text-white font-bold py-3.5 rounded-xl
                       shadow transition-all text-sm flex items-center justify-center gap-2 mt-2">
          Próximo <i class="fas fa-arrow-right text-xs"></i>
        </button>

      </div><!-- /etapa1 -->

      <!-- ─── ETAPA 2: EVENTO ────────────────────── -->
      <div id="etapa2" class="painel hidden space-y-4">

        <div>
          <label class="block text-xs font-bold text-gray-600 mb-1.5 uppercase tracking-wider">
            Setor / Clínica <span class="text-red-500">*</span>
          </label>
          <div class="relative">
            <i class="fas fa-hospital absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none"></i>
            <select id="iptSetor" required onchange="_salvarRascunho()"
                    class="w-full pl-9 pr-8 py-3 border border-gray-300 rounded-xl text-sm bg-gray-50
                           focus:bg-white focus:ring-2 focus:ring-teal-500 focus:border-teal-500
                           outline-none transition-all text-gray-800 appearance-none cursor-pointer">
              <option value="">Carregando setores…</option>
            </select>
            <i class="fas fa-chevron-down absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs pointer-events-none"></i>
          </div>
          <p id="hintSetor" aria-live="polite" class="hidden text-xs text-red-500 mt-1 flex items-center gap-2">
            Erro ao carregar setores.
            <button type="button" onclick="carregarSetores()" class="underline font-semibold text-red-600">Tentar novamente</button>
          </p>
        </div>

        <div>
          <label class="block text-xs font-bold text-gray-600 mb-1.5 uppercase tracking-wider">
            Início do evento <span class="text-red-500">*</span>
          </label>
          <input type="datetime-local" id="iptDataEvento" required onchange="_salvarRascunho()"
                 class="w-full px-4 py-3 border border-gray-300 rounded-xl text-sm bg-gray-50
                        focus:bg-white focus:ring-2 focus:ring-teal-500 focus:border-teal-500
                        outline-none transition-all text-gray-800">
          <p class="text-[10px] text-teal-600 mt-1 flex items-center gap-1">
            <i class="fas fa-clock"></i> Pré-preenchido com agora — ajuste data e hora se necessário
          </p>
        </div>

        <div>
          <label class="block text-xs font-bold text-gray-600 mb-1.5 uppercase tracking-wider">
            Medicamento suspeito <span class="text-red-500">*</span>
          </label>
          <input type="text" id="iptMedicamento" required
                 placeholder="Ex: MEDICAMENTO QUE PODE TER CAUSADO A REAÇÃO"
                 oninput="this.value=this.value.toUpperCase(); _salvarRascunho();"
                 class="w-full px-4 py-3 border border-gray-300 rounded-xl text-sm bg-gray-50
                        focus:bg-white focus:ring-2 focus:ring-teal-500 focus:border-teal-500
                        outline-none transition-all text-gray-800">
        </div>

        <div>
          <label class="block text-xs font-bold text-gray-600 mb-1.5 uppercase tracking-wider">
            O que aconteceu? <span class="text-red-500">*</span>
          </label>
          <textarea id="iptDescricao" required rows="3" maxlength="500"
                    placeholder="Descreva brevemente a reação observada no paciente…"
                    oninput="autoCresce(this); _atualizarContador(); _salvarRascunho();"
                    class="auto w-full px-4 py-3 border border-gray-300 rounded-xl text-sm bg-gray-50
                           focus:bg-white focus:ring-2 focus:ring-teal-500 focus:border-teal-500
                           outline-none transition-all text-gray-800 resize-none"></textarea>
          <div class="flex justify-between mt-1">
            <p class="text-[10px] text-gray-400">Seja breve — a Farmácia complementa na investigação</p>
            <p id="contadorDescricao" class="text-[10px] text-gray-400">0/500</p>
          </div>
        </div>

        <div>
          <label class="block text-xs font-bold text-gray-600 mb-1.5 uppercase tracking-wider">
            Conduta realizada após a RAM <span class="text-red-500">*</span>
          </label>
          <div class="relative">
            <i class="fas fa-hand-holding-medical absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none"></i>
            <select id="iptCondutas" required
                    onchange="toggleOutraConduta(); _salvarRascunho();"
                    class="w-full pl-9 pr-8 py-3 border border-gray-300 rounded-xl text-sm bg-gray-50
                           focus:bg-white focus:ring-2 focus:ring-teal-500 focus:border-teal-500
                           outline-none transition-all text-gray-800 appearance-none cursor-pointer">
              <option value="">Selecione a conduta…</option>
              <option value="Alterado diluição">Alterado diluição</option>
              <option value="Alterado posologia">Alterado posologia</option>
              <option value="Alterado velocidade de infusão">Alterado velocidade de infusão</option>
              <option value="Medicamento mantido">Medicamento mantido</option>
              <option value="Medicamento mantido com uso de antagonista ou sintomático">Medicamento mantido com uso de antagonista ou sintomático</option>
              <option value="Medicamento suspenso">Medicamento suspenso</option>
              <option value="__outro__">Outro…</option>
            </select>
            <i class="fas fa-chevron-down absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs pointer-events-none"></i>
          </div>

          <div id="areaOutraConduta" class="hidden mt-2">
            <input type="text" id="iptOutraConduta"
                   oninput="_salvarRascunho()"
                   placeholder="Descreva a conduta realizada…"
                   class="w-full px-4 py-3 border border-orange-300 rounded-xl text-sm bg-orange-50
                          focus:bg-white focus:ring-2 focus:ring-orange-400 focus:border-orange-400
                          outline-none transition-all text-gray-800">
          </div>
        </div>

        <div class="flex gap-3 mt-2">
          <button type="button" onclick="voltar(2)"
                  class="flex-none px-5 py-3.5 bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold
                         rounded-xl text-sm transition-all">
            <i class="fas fa-arrow-left text-xs mr-1"></i> Voltar
          </button>
          <button type="button" onclick="avancar(2)"
                  class="flex-1 bg-teal-600 hover:bg-teal-700 text-white font-bold py-3.5 rounded-xl
                         shadow transition-all text-sm flex items-center justify-center gap-2">
            Próximo <i class="fas fa-arrow-right text-xs"></i>
          </button>
        </div>

      </div><!-- /etapa2 -->

      <!-- ─── ETAPA 3: NOTIFICADOR ──────────────── -->
      <div id="etapa3" class="painel hidden space-y-4">

        <div id="blocoMemoria" class="hidden bg-teal-50 border border-teal-200 rounded-xl px-4 py-3
                                       flex items-center justify-between gap-3">
          <div class="flex items-center gap-2 text-sm text-teal-800 font-medium min-w-0">
            <i class="fas fa-user-check text-teal-600 flex-shrink-0"></i>
            <span id="lblMemoria" class="truncate"></span>
          </div>
          <button type="button" onclick="limparMemoria()"
                  class="text-xs text-teal-600 hover:text-teal-800 underline flex-shrink-0 font-semibold">
            Alterar
          </button>
        </div>

        <div id="camposNotificador" class="space-y-4">

          <div>
            <label class="block text-xs font-bold text-gray-600 mb-2 uppercase tracking-wider">
              Categoria profissional <span class="text-red-500">*</span>
            </label>
            <div class="flex flex-wrap gap-2" id="pillsCategoria">
              <button type="button" data-cat="Enfermeiro(a)"
                      onclick="selecionarCategoria(this)"
                      class="cat-pill px-3 py-2 text-xs font-semibold border border-gray-300 rounded-full
                             text-gray-600 bg-white transition-all">
                <i class="fas fa-user-nurse mr-1"></i> Enfermeiro(a)
              </button>
              <button type="button" data-cat="Técnico(a) de Enfermagem"
                      onclick="selecionarCategoria(this)"
                      class="cat-pill px-3 py-2 text-xs font-semibold border border-gray-300 rounded-full
                             text-gray-600 bg-white transition-all">
                <i class="fas fa-stethoscope mr-1"></i> Técnico(a) Enf.
              </button>
              <button type="button" data-cat="Farmacêutico(a)"
                      onclick="selecionarCategoria(this)"
                      class="cat-pill px-3 py-2 text-xs font-semibold border border-gray-300 rounded-full
                             text-gray-600 bg-white transition-all">
                <i class="fas fa-pills mr-1"></i> Farmacêutico(a)
              </button>
              <button type="button" data-cat="Médico(a)"
                      onclick="selecionarCategoria(this)"
                      class="cat-pill px-3 py-2 text-xs font-semibold border border-gray-300 rounded-full
                             text-gray-600 bg-white transition-all">
                <i class="fas fa-user-md mr-1"></i> Médico(a)
              </button>
              <button type="button" data-cat="Outro"
                      onclick="selecionarCategoria(this)"
                      class="cat-pill px-3 py-2 text-xs font-semibold border border-gray-300 rounded-full
                             text-gray-600 bg-white transition-all">
                Outro
              </button>
            </div>
            <input type="hidden" id="iptCategoria" required>
            <p id="errCategoria" aria-live="polite" class="hidden text-xs text-red-500 mt-1">Selecione sua categoria.</p>
          </div>

          <div>
            <label class="block text-xs font-bold text-gray-600 mb-1.5 uppercase tracking-wider">
              Seu nome <span class="text-red-500">*</span>
            </label>
            <div class="relative">
              <i class="fas fa-user absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm"></i>
              <input type="text" id="iptNotificador" required
                     placeholder="Nome completo"
                     autocomplete="name"
                     class="w-full pl-9 pr-4 py-3 border border-gray-300 rounded-xl text-sm bg-gray-50
                            focus:bg-white focus:ring-2 focus:ring-teal-500 focus:border-teal-500
                            outline-none transition-all text-gray-800 capitalize">
            </div>
          </div>

          <div>
            <label class="block text-xs font-bold text-gray-600 mb-1.5 uppercase tracking-wider">
              E-mail para receber o resultado
            </label>
            <div class="relative">
              <i class="fas fa-envelope absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm"></i>
              <input type="email" id="iptEmail"
                     placeholder="seu@email.com"
                     autocomplete="email"
                     class="w-full pl-9 pr-4 py-3 border border-gray-300 rounded-xl text-sm bg-gray-50
                            focus:bg-white focus:ring-2 focus:ring-teal-500 focus:border-teal-500
                            outline-none transition-all text-gray-800">
            </div>
            <p class="text-[10px] text-gray-400 mt-1 flex items-center gap-1">
              <i class="fas fa-shield-alt"></i>
            </p>
          </div>

        </div><!-- /camposNotificador -->

        <!-- Banner de erro de envio -->
        <div id="bannerErro" class="hidden bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700
                                     flex items-start justify-between gap-3" role="alert" aria-live="assertive">
          <div class="flex items-start gap-2 min-w-0">
            <i class="fas fa-exclamation-triangle mt-0.5 flex-shrink-0"></i>
            <span id="lblBannerErro">Falha ao enviar. Verifique a conexão.</span>
          </div>
          <button type="button" onclick="enviarNotificacao()"
                  class="text-xs font-bold underline flex-shrink-0">Tentar novamente</button>
        </div>

        <div class="flex gap-3 mt-2">
          <button type="button" onclick="voltar(3)"
                  class="flex-none px-5 py-3.5 bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold
                         rounded-xl text-sm transition-all">
            <i class="fas fa-arrow-left text-xs mr-1"></i> Voltar
          </button>
          <button type="button" id="btnEnviar" onclick="enviarNotificacao()"
                  class="flex-1 bg-orange-500 hover:bg-orange-600 text-white font-bold py-3.5 rounded-xl
                         shadow-lg transition-all text-sm flex items-center justify-center gap-2
                         border-b-4 border-orange-700 active:border-b-0 active:translate-y-px">
            <i class="fas fa-paper-plane"></i> Enviar notificação
          </button>
        </div>

      </div><!-- /etapa3 -->

    </div><!-- /areaFormulario -->

    <!-- ═══ TELA DE SUCESSO ═══ -->
    <div id="areaSucesso" class="hidden px-6 py-10 text-center">
      <div class="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-5">
        <i class="fas fa-check-circle text-4xl text-green-500"></i>
      </div>
      <h2 class="text-xl font-bold text-gray-800 mb-1">Notificação registrada!</h2>
      <p class="text-gray-500 text-sm mb-4">
        Prontuário <strong id="lblSucessoPront" class="text-teal-700 font-bold"></strong>
        enviado à Farmácia Clínica.
      </p>

      <div id="boxFarma" class="bg-teal-50 border border-teal-200 rounded-xl p-4 mb-3 text-sm text-teal-800 text-left">
        <div class="flex items-start gap-2">
          <i class="fas fa-user-md text-teal-600 mt-0.5 flex-shrink-0"></i>
          <span id="lblFarma">O farmacêutico responsável foi notificado e iniciará a investigação.</span>
        </div>
      </div>

      <div id="boxEmail" class="hidden bg-blue-50 border border-blue-200 rounded-xl p-4 mb-5 text-sm text-blue-800 text-left">
        <div class="flex items-start gap-2">
          <i class="fas fa-envelope text-blue-500 mt-0.5 flex-shrink-0"></i>
          <span>Você receberá um e-mail com o resultado da investigação quando ela for concluída.</span>
        </div>
      </div>

      <div class="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-6 text-xs text-gray-500">
        Obrigado por zelar pela segurança do paciente!
      </div>

      <button type="button" onclick="novaNotificacao()"
              class="w-full bg-white border-2 border-teal-600 text-teal-700 font-bold py-3
                     rounded-xl hover:bg-teal-50 transition-all shadow-sm text-sm">
        <i class="fas fa-plus mr-2"></i> Registrar outra RAM
      </button>
    </div>

  </div><!-- /cartão -->

  <script>
    // ──────────────────────────────────────────
    // ESTADO
    // ──────────────────────────────────────────
    let etapaAtual = 1;
    let categoriaEscolhida = '';
    let idempotencyKeyAtual = null;
    const TOTAL_ETAPAS = 3;

    const SS_NOME     = 'vigi_notif_nome';
    const SS_CAT      = 'vigi_notif_cat';
    const SS_EMAIL    = 'vigi_notif_email';
    const SS_RASCUNHO = 'vigi_notif_rascunho'; // etapas 1-2, limpo só no sucesso

    let _timeoutRascunho = null;

    /** Agora local em "yyyy-MM-ddTHH:mm" para datetime-local. */
    function _agoraDateTimeLocal() {
      const d = new Date();
      const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
             'T' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    // ──────────────────────────────────────────
    // INICIALIZAÇÃO
    // ──────────────────────────────────────────
    function inicializar() {
      // Local (UTC-3), com hora — toISOString é UTC e virava o dia às 21h.
      document.getElementById('iptDataEvento').value = _agoraDateTimeLocal();

      carregarSetores();
      _restaurarMemoria();
      _restaurarRascunho();

      // Foco imediato no primeiro campo — reduz 1 toque no fluxo mobile
      document.getElementById('iptProntuario').focus();

      window.addEventListener('beforeunload', _guardarSaida);
    }

    function carregarSetores() {
      const sel = document.getElementById('iptSetor');
      const hint = document.getElementById('hintSetor');
      hint.classList.add('hidden');
      sel.innerHTML = '<option value="">Carregando setores…</option>';

      // [M8 — LGPD] antes: getConfig() completo (expunha e-mails/nomes de
      // farmacêuticos por setor + config geral a qualquer anônimo). Agora:
      // getSetoresPublico() — só nomes de setor, zero PII.
      google.script.run
        .withSuccessHandler(res => {
          sel.innerHTML = '<option value="">Selecione o setor…</option>';
          const setores = (res && res.setores) || [];
          if (setores.length) {
            setores.forEach(nome => {
              const opt = document.createElement('option');
              opt.value       = nome;
              opt.textContent = nome;
              sel.appendChild(opt);
            });
            // Restaura seleção salva no rascunho, se houver
            const r = _lerRascunho();
            if (r && r.setor) sel.value = r.setor;
          } else {
            sel.innerHTML = '<option value="">Nenhum setor disponível</option>';
          }
        })
        .withFailureHandler(() => {
          sel.innerHTML = '<option value="">Falha ao carregar</option>';
          hint.classList.remove('hidden');
        })
        .getSetoresPublico();
    }

    // ──────────────────────────────────────────
    // RASCUNHO — persiste etapas 1-2 entre reloads
    // acidentais. Nunca persiste dado do notificador
    // aqui (isso já é tratado por _salvarMemoria).
    // ──────────────────────────────────────────
    function _salvarRascunho() {
      clearTimeout(_timeoutRascunho);
      _timeoutRascunho = setTimeout(() => {
        const r = {
          prontuario:  document.getElementById('iptProntuario').value,
          iniciais:    document.getElementById('iptIniciais').value,
          nascimento:  document.getElementById('iptNascimento').value,
          setor:       document.getElementById('iptSetor').value,
          dataEvento:  document.getElementById('iptDataEvento').value,
          medicamento: document.getElementById('iptMedicamento').value,
          descricao:   document.getElementById('iptDescricao').value,
          condutas:    document.getElementById('iptCondutas').value,
          outraConduta: document.getElementById('iptOutraConduta').value
        };
        try { sessionStorage.setItem(SS_RASCUNHO, JSON.stringify(r)); } catch (e) { /* storage indisponível — degrada sem quebrar fluxo */ }
      }, 300);
    }

    function _lerRascunho() {
      try {
        const raw = sessionStorage.getItem(SS_RASCUNHO);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }

    function _restaurarRascunho() {
      const r = _lerRascunho();
      if (!r) return;
      if (r.prontuario)  document.getElementById('iptProntuario').value = r.prontuario;
      if (r.iniciais)    document.getElementById('iptIniciais').value   = r.iniciais;
      if (r.nascimento)  document.getElementById('iptNascimento').value = r.nascimento;
      if (r.dataEvento)  document.getElementById('iptDataEvento').value = r.dataEvento;
      if (r.medicamento) document.getElementById('iptMedicamento').value = r.medicamento;
      if (r.descricao) {
        document.getElementById('iptDescricao').value = r.descricao;
        autoCresce(document.getElementById('iptDescricao'));
        _atualizarContador();
      }
      if (r.condutas) {
        document.getElementById('iptCondutas').value = r.condutas;
        toggleOutraConduta();
        if (r.outraConduta) document.getElementById('iptOutraConduta').value = r.outraConduta;
      }
      validarProntuario();
      validarNascimento();
      // setor é restaurado em carregarSetores(), pois depende do dropdown já populado
    }

    function _limparRascunho() {
      try { sessionStorage.removeItem(SS_RASCUNHO); } catch (e) {}
    }

    function _guardarSaida(e) {
      const pront = document.getElementById('iptProntuario').value.trim();
      const desc  = document.getElementById('iptDescricao').value.trim();
      const sucessoVisivel = !document.getElementById('areaSucesso').classList.contains('hidden');
      if (!sucessoVisivel && (pront || desc)) {
        e.preventDefault();
        e.returnValue = '';
      }
    }

    // ──────────────────────────────────────────
    // MEMÓRIA DE SESSÃO DO NOTIFICADOR
    // ──────────────────────────────────────────
    function _restaurarMemoria() {
      const nome  = sessionStorage.getItem(SS_NOME);
      const cat   = sessionStorage.getItem(SS_CAT);
      const email = sessionStorage.getItem(SS_EMAIL);
      if (!nome || !cat) return;

      document.getElementById('lblMemoria').textContent = `${cat} · ${nome}`;
      document.getElementById('blocoMemoria').classList.remove('hidden');
      document.getElementById('camposNotificador').classList.add('hidden');

      document.getElementById('iptNotificador').value = nome;
      document.getElementById('iptCategoria').value   = cat;
      if (email) document.getElementById('iptEmail').value = email;
      categoriaEscolhida = cat;
    }

    function limparMemoria() {
      sessionStorage.removeItem(SS_NOME);
      sessionStorage.removeItem(SS_CAT);
      sessionStorage.removeItem(SS_EMAIL);
      categoriaEscolhida = '';
      document.getElementById('blocoMemoria').classList.add('hidden');
      document.getElementById('camposNotificador').classList.remove('hidden');
      document.getElementById('iptNotificador').value = '';
      document.getElementById('iptCategoria').value   = '';
      document.getElementById('iptEmail').value       = '';
      document.querySelectorAll('.cat-pill').forEach(p => p.classList.remove('ativo'));
    }

    function _salvarMemoria() {
      const nome  = document.getElementById('iptNotificador').value.trim();
      const cat   = document.getElementById('iptCategoria').value.trim();
      const email = document.getElementById('iptEmail').value.trim();
      if (nome && cat) {
        sessionStorage.setItem(SS_NOME, nome);
        sessionStorage.setItem(SS_CAT, cat);
        if (email) sessionStorage.setItem(SS_EMAIL, email);
      }
    }

    // ──────────────────────────────────────────
    // STEPPER
    // ──────────────────────────────────────────
    function _mostrarEtapa(n) {
      for (let i = 1; i <= TOTAL_ETAPAS; i++) {
        const p = document.getElementById('etapa' + i);
        if (i === n) p.classList.remove('hidden');
        else p.classList.add('hidden');
      }
      etapaAtual = n;

      for (let i = 1; i <= TOTAL_ETAPAS; i++) {
        const dot = document.getElementById('dot' + i);
        dot.className = 'w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold ';
        if (i < n)        dot.className += 'bg-green-500 text-white';
        else if (i === n) dot.className += 'bg-orange-500 text-white shadow-md ring-2 ring-orange-300';
        else              dot.className += 'bg-gray-200 text-gray-400';
      }

      const pct = Math.round((n / TOTAL_ETAPAS) * 100);
      const barra = document.getElementById('barraProgresso');
      barra.style.width = pct + '%';
      barra.className = 'h-1.5 rounded-full transition-all duration-500 ' +
        (pct < 50 ? 'bg-orange-400' : pct < 100 ? 'bg-yellow-400' : 'bg-green-500');
      document.getElementById('lblPct').textContent = pct + '%';

      const nomes = ['', 'Paciente', 'Evento', 'Você'];
      document.getElementById('lblEtapa').textContent =
        `Etapa ${n} de ${TOTAL_ETAPAS} · ${nomes[n]}`;

      window.scrollTo({ top: 0, behavior: 'smooth' });
      _focarPrimeiroCampo(n);
    }

    function _focarPrimeiroCampo(n) {
      // Pequeno delay — evita roubar foco durante o scroll suave
      setTimeout(() => {
        if (n === 1) document.getElementById('iptProntuario').focus();
        if (n === 2) document.getElementById('iptSetor').focus();
        if (n === 3) {
          const memoriaAberta = !document.getElementById('blocoMemoria').classList.contains('hidden');
          if (!memoriaAberta) document.getElementById('iptNotificador').focus();
        }
      }, 320);
    }

    function irParaEtapa(n) {
      if (n > etapaAtual) return;
      _mostrarEtapa(n);
    }

    // ──────────────────────────────────────────
    // VALIDAÇÕES INLINE
    // ──────────────────────────────────────────
    function validarProntuario() {
      const v    = document.getElementById('iptProntuario').value;
      const hint = document.getElementById('hintProntuario');
      if (v.length === 0) {
        hint.textContent  = 'Apenas números';
        hint.className    = 'text-xs text-gray-400 mt-1';
      } else if (v.length < 3) {
        hint.textContent  = 'Número muito curto';
        hint.className    = 'text-xs text-red-500 mt-1';
      } else {
        hint.textContent  = '✓ OK';
        hint.className    = 'text-xs text-teal-600 mt-1';
      }
    }

    function validarNascimento() {
      const el   = document.getElementById('iptNascimento');
      const hint = document.getElementById('hintNascimento');
      if (!el.value) { hint.textContent = ''; return; }

      const hoje = new Date();
      const data = new Date(el.value + 'T00:00:00');
      const idadeMaxima = new Date();
      idadeMaxima.setFullYear(hoje.getFullYear() - 120);

      if (data > hoje) {
        hint.textContent = 'Data no futuro';
        hint.className   = 'text-[10px] text-red-500 mt-1';
        el.classList.add('border-red-400');
      } else if (data < idadeMaxima) {
        hint.textContent = 'Verifique o ano';
        hint.className   = 'text-[10px] text-red-500 mt-1';
        el.classList.add('border-red-400');
      } else {
        hint.textContent = '';
        el.classList.remove('border-red-400');
      }
    }

    function autoCresce(el) {
      el.style.height = '';
      el.style.height = el.scrollHeight + 'px';
    }

    function _atualizarContador() {
      const desc = document.getElementById('iptDescricao');
      document.getElementById('contadorDescricao').textContent = desc.value.length + '/500';
    }

    // ──────────────────────────────────────────
    // CONDUTAS — revelar campo "Outro"
    // ──────────────────────────────────────────
    function toggleOutraConduta() {
      const sel  = document.getElementById('iptCondutas').value;
      const area = document.getElementById('areaOutraConduta');
      const inp  = document.getElementById('iptOutraConduta');
      if (sel === '__outro__') {
        area.classList.remove('hidden');
        inp.required = true;
        inp.focus();
      } else {
        area.classList.add('hidden');
        inp.required = false;
        inp.value    = '';
      }
    }

    function _valorConduta() {
      const sel = document.getElementById('iptCondutas').value;
      if (sel === '__outro__') {
        return document.getElementById('iptOutraConduta').value.trim();
      }
      return sel;
    }

    // ──────────────────────────────────────────
    // PILLS DE CATEGORIA
    // ──────────────────────────────────────────
    function selecionarCategoria(el) {
      document.querySelectorAll('.cat-pill').forEach(p => p.classList.remove('ativo'));
      el.classList.add('ativo');
      categoriaEscolhida = el.getAttribute('data-cat');
      document.getElementById('iptCategoria').value = categoriaEscolhida;
      document.getElementById('errCategoria').classList.add('hidden');
    }

    // ──────────────────────────────────────────
    // NAVEGAÇÃO COM VALIDAÇÃO POR ETAPA
    // ──────────────────────────────────────────
    function avancar(etapa) {
      if (etapa === 1) {
        const pront  = document.getElementById('iptProntuario').value.trim();
        const inic   = document.getElementById('iptIniciais').value.trim();
        if (!pront || pront.length < 3) {
          _focarComErro('iptProntuario', 'Informe o número do prontuário.');
          return;
        }
        if (!inic) {
          _focarComErro('iptIniciais', 'Informe as iniciais do paciente.');
          return;
        }
      }

      if (etapa === 2) {
        const setor = document.getElementById('iptSetor').value;
        const data  = document.getElementById('iptDataEvento').value;
        const med   = document.getElementById('iptMedicamento').value.trim();
        const desc  = document.getElementById('iptDescricao').value.trim();
        const cond  = document.getElementById('iptCondutas').value;
        const outro = document.getElementById('iptOutraConduta').value.trim();

        if (!setor)  { _focarComErro('iptSetor',      'Selecione o setor.');          return; }
        if (!data)   { _focarComErro('iptDataEvento', 'Informe a data do evento.');    return; }
        if (!med)    { _focarComErro('iptMedicamento','Informe o medicamento.');       return; }
        if (!desc)   { _focarComErro('iptDescricao',  'Descreva o evento.');           return; }
        if (!cond)   { _focarComErro('iptCondutas',   'Selecione a conduta.');         return; }
        if (cond === '__outro__' && !outro) {
          _focarComErro('iptOutraConduta', 'Descreva a conduta realizada.');
          return;
        }
      }

      _mostrarEtapa(etapa + 1);
    }

    function voltar(etapa) {
      _mostrarEtapa(etapa - 1);
    }

    function _focarComErro(id, msg) {
      const el = document.getElementById(id);
      el.classList.add('border-red-400', 'ring-2', 'ring-red-100');
      el.focus();
      el.addEventListener('input',  () => el.classList.remove('border-red-400','ring-2','ring-red-100'), { once: true });
      el.addEventListener('change', () => el.classList.remove('border-red-400','ring-2','ring-red-100'), { once: true });
    }

    // ──────────────────────────────────────────
    // ENVIO FINAL
    // ──────────────────────────────────────────
    function enviarNotificacao() {
      document.getElementById('bannerErro').classList.add('hidden');

      const cat   = document.getElementById('iptCategoria').value.trim();
      const nome  = document.getElementById('iptNotificador').value.trim();
      const email = document.getElementById('iptEmail').value.trim();

      if (!cat) {
        document.getElementById('errCategoria').classList.remove('hidden');
        return;
      }
      if (!nome) {
        _focarComErro('iptNotificador', 'Informe seu nome.');
        return;
      }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        _focarComErro('iptEmail', 'E-mail inválido.');
        return;
      }

      const btn = document.getElementById('btnEnviar');
      btn.innerHTML  = '<i class="fas fa-circle-notch fa-spin mr-2"></i> Enviando…';
      btn.disabled   = true;

      const conduta = _valorConduta();

      // Idempotency key gerada uma única vez por tentativa de submissão;
      // reenvio (retry) usa a MESMA chave — evita duplicar RAM em timeout de rede.
      // Backend (Cases.gs/salvarDemandaEspontanea) deve checar chave já processada
      // antes de gravar, dentro do comTrava_() existente.
      if (!idempotencyKeyAtual) {
        idempotencyKeyAtual = (crypto && crypto.randomUUID)
          ? crypto.randomUUID()
          : ('id_' + Date.now() + '_' + Math.random().toString(36).slice(2));
      }

      const dados = {
        prontuario:            document.getElementById('iptProntuario').value.trim(),
        iniciais:              document.getElementById('iptIniciais').value.trim(),
        nascimento:            document.getElementById('iptNascimento').value,
        setor:                 document.getElementById('iptSetor').value,
        dataEvento:            document.getElementById('iptDataEvento').value,
        medicamento:           document.getElementById('iptMedicamento').value.trim(),
        descricao:             document.getElementById('iptDescricao').value.trim(),
        condutas:              conduta,
        categoriaProfissional: cat,
        notificador:           nome,
        emailNotificador:      email,
        idempotencyKey:        idempotencyKeyAtual
      };

      google.script.run
        .withSuccessHandler(resultado => {
          _salvarMemoria();
          _limparRascunho();
          idempotencyKeyAtual = null;
          _exibirSucesso(dados, resultado);
        })
        .withFailureHandler(err => {
          btn.innerHTML = '<i class="fas fa-paper-plane"></i> Enviar notificação';
          btn.disabled  = false;
          document.getElementById('lblBannerErro').textContent =
            'Falha ao enviar: ' + (err.message || 'verifique a conexão e tente novamente.');
          document.getElementById('bannerErro').classList.remove('hidden');
          // idempotencyKeyAtual É MANTIDA — retry reenvia com a mesma chave
        })
        .salvarDemandaEspontanea(dados);
    }

    // ──────────────────────────────────────────
    // TELA DE SUCESSO personalizada
    // ──────────────────────────────────────────
    function _exibirSucesso(dados, resultado) {
      document.getElementById('areaFormulario').classList.add('hidden');
      document.getElementById('areaSucesso').classList.remove('hidden');

      document.getElementById('lblSucessoPront').textContent = dados.prontuario;

      const farmaLabel = document.getElementById('lblFarma');
      if (resultado && resultado.farmaceuticoResponsavel) {
        farmaLabel.textContent =
          `${resultado.farmaceuticoResponsavel} foi notificado(a) e iniciará a investigação.`;
      } else {
        farmaLabel.textContent =
          'A Farmácia Clínica foi notificada e iniciará a investigação em breve.';
      }

      if (dados.emailNotificador) {
        document.getElementById('boxEmail').classList.remove('hidden');
      }

      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // ──────────────────────────────────────────
    // NOVA NOTIFICAÇÃO
    // ──────────────────────────────────────────
    function novaNotificacao() {
      document.getElementById('iptProntuario').value  = '';
      document.getElementById('iptIniciais').value    = '';
      document.getElementById('iptNascimento').value  = '';
      document.getElementById('iptSetor').value       = '';
      document.getElementById('iptMedicamento').value = '';
      document.getElementById('iptDescricao').value   = '';
      document.getElementById('iptCondutas').value    = '';
      document.getElementById('iptOutraConduta').value = '';
      document.getElementById('areaOutraConduta').classList.add('hidden');
      document.getElementById('bannerErro').classList.add('hidden');
      document.getElementById('hintNascimento').textContent = '';
      _atualizarContador();

      document.getElementById('iptDataEvento').value = _agoraDateTimeLocal();

      const btn = document.getElementById('btnEnviar');
      btn.innerHTML = '<i class="fas fa-paper-plane"></i> Enviar notificação';
      btn.disabled  = false;

      const hint = document.getElementById('hintProntuario');
      hint.textContent = 'Apenas números';
      hint.className   = 'text-xs text-gray-400 mt-1';

      document.getElementById('areaSucesso').classList.add('hidden');
      document.getElementById('boxEmail').classList.add('hidden');
      document.getElementById('areaFormulario').classList.remove('hidden');

      idempotencyKeyAtual = null;
      _mostrarEtapa(1);
      _restaurarMemoria();
    }
  </script>

</body>
</html>
```

---

## 📄 Arquivo [13/32]: index.html

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>VigiRAM</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <?!= include('styles'); ?>
</head>
<body class="bg-gray-100 font-sans h-screen flex flex-col overflow-hidden text-gray-800"
      onload="inicializar()">

  <!-- =====================================================
       TELA DE LOGIN
  ===================================================== -->
  <div id="view-login" class="fixed inset-0 bg-teal-800 z-50 flex flex-col items-center justify-center p-4 fade-in">
    <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
      <div class="bg-teal-700 p-6 text-center text-white">
        <i class="fas fa-shield-virus text-4xl text-teal-300 mb-3"></i>
        <h1 class="text-2xl font-bold tracking-tight">VigiRAM</h1>
        <p class="text-teal-200 text-sm mt-1">Acesso Restrito · Farmácia · HRN</p>
      </div>
      <form id="formLogin" onsubmit="realizarLogin(event)" class="p-8 space-y-6">
        <div>
          <label class="block text-xs font-bold text-gray-700 mb-1.5 uppercase tracking-wider">Email</label>
          <div class="relative">
            <i class="fas fa-envelope absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"></i>
            <input type="email" id="loginEmail" required
                   class="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-300 rounded-lg text-sm
                          focus:bg-white focus:ring-2 focus:ring-teal-500 outline-none transition-all"
                   placeholder="usuario@isgh.org.br">
          </div>
        </div>
        <div>
          <label class="block text-xs font-bold text-gray-700 mb-1.5 uppercase tracking-wider">Senha</label>
          <div class="relative">
            <i class="fas fa-lock absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"></i>
            <input type="password" id="loginSenha" required
                   class="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-300 rounded-lg text-sm
                          focus:bg-white focus:ring-2 focus:ring-teal-500 outline-none transition-all"
                   placeholder="••••••••">
          </div>
        </div>
        <button type="submit" id="btnLogin"
                class="w-full bg-teal-600 text-white font-bold py-3 rounded-lg shadow-lg
                       hover:bg-teal-700 transition-all flex items-center justify-center text-sm">
          Entrar no Sistema
        </button>
      </form>
    </div>
  </div>

  <!-- =====================================================
       APLICAÇÃO PRINCIPAL
  ===================================================== -->
  <div id="app-container" class="hidden flex-1 flex-col w-full overflow-hidden">

    <!-- NAVBAR -->
    <nav class="bg-teal-700 text-white shadow-md z-10 relative">
      <div class="flex justify-between items-end px-4 pt-4">

        <!-- Identidade -->
        <div class="mb-4 flex items-center gap-3">
          <div class="bg-white/10 rounded-lg w-10 h-10 flex items-center justify-center shrink-0">
            <i class="fas fa-shield-virus text-teal-200 text-lg"></i>
          </div>
          <div>
            <h1 class="text-xl font-bold tracking-tight leading-none">VigiRAM</h1>
            <p class="text-teal-200 text-[11px] font-semibold uppercase tracking-wider mt-0.5">
              Farmacovigilância · HRN
            </p>
          </div>
        </div>

        <!-- Abas -->
        <div class="flex items-end self-end space-x-1">
          <button onclick="alternarAba('kanban')" id="btnAbaKanban"
                  class="px-5 py-3 font-bold text-sm transition aba-ativa">
            <i class="fas fa-tasks mr-2"></i> Painel de Notificações
          </button>
          <button onclick="alternarAba('dashboard')" id="btnAbaDash"
                  class="px-5 py-3 font-bold text-sm transition aba-inativa">
            <i class="fas fa-chart-pie mr-2"></i> Dashboard
          </button>
        </div>

        <!-- Ações da direita -->
        <div class="flex items-center gap-2 mb-4">
          <button onclick="abrirNotificacaoInterna()"
                  class="pill-action bg-purple-600 hover:bg-purple-500 px-4 py-2 rounded-lg font-semibold
                         text-sm shadow-sm flex items-center gap-1.5"
                  title="Registrar suspeita de RAM diretamente (entra em Investigação)">
            <i class="fas fa-plus-circle"></i>
            <span class="hidden sm:inline">Notificar RAM</span>
          </button>

          <button onclick="carregarCasos()" id="btnAtualizar"
                  class="pill-action bg-teal-600 hover:bg-teal-500 w-9 h-9 rounded-lg flex items-center justify-center shadow-sm"
                  title="Sincronizar casos">
            <i class="fas fa-sync-alt"></i>
          </button>

          <div class="navbar-divider"></div>

          <!-- Avatar usuário — tooltip fixed, posicionado via JS (getBoundingClientRect) -->
          <button onclick="_toggleTooltipUsuario()"
                  onmouseenter="_mostrarTooltipUsuario()"
                  onmouseleave="_esconderTooltipUsuario()"
                  class="w-9 h-9 rounded-full bg-teal-800 border-2 border-teal-400/40 text-teal-50 text-xs
                         font-bold flex items-center justify-center shrink-0 hover:border-teal-300 transition"
                  id="avatarUsuario">
            --
          </button>
          <span id="lblUsuarioLogado" class="hidden"></span>

          <button onclick="document.getElementById('modalSobre').classList.replace('hidden','flex')"
                  class="pill-action bg-white/10 hover:bg-white/20 w-9 h-9 rounded-lg flex items-center justify-center"
                  title="Sobre o VigiRAM">
            <i class="fas fa-info-circle"></i>
          </button>

          <!-- Configurações — visível apenas para ADMIN, discreto na navbar -->
          <button id="btnAbaAdmin" onclick="abrirConfiguracoes()"
                  class="hidden pill-action bg-white/10 hover:bg-white/20 w-9 h-9 rounded-lg
                         flex items-center justify-center opacity-60 hover:opacity-100 transition"
                  title="Configurações do sistema">
            <i class="fas fa-cog text-sm"></i>
          </button>

          <button onclick="fazerLogout()"
                  class="pill-action bg-white/10 hover:bg-white/20 w-9 h-9 rounded-lg flex items-center justify-center"
                  title="Sair do sistema">
            <i class="fas fa-sign-out-alt"></i>
          </button>
        </div>
      </div>
    </nav>

    <!-- BARRA DE FILTROS -->
    <div id="barraFiltros" class="bg-white px-4 py-2.5 flex flex-nowrap items-center gap-2 overflow-x-auto z-10 shadow-sm border-b border-gray-200">
      <div class="relative flex-shrink-0 w-56">
        <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs"></i>
        <input type="text" id="inputBusca" placeholder="Prontuário, iniciais ou medicamento…"
               oninput="processarFiltros()"
               class="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-lg
                      focus:ring-2 focus:ring-teal-500 focus:border-teal-500 transition">
      </div>
      <select id="filtroSetor" onchange="processarFiltros()"
              class="flex-shrink-0 border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-gray-700 max-w-[160px]
                     focus:ring-2 focus:ring-teal-500 focus:border-teal-500 transition bg-white">
        <option value="TODOS">Todos os Setores</option>
      </select>
      <select id="filtroFarmaceutico" onchange="processarFiltros()"
        class="flex-shrink-0 border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-gray-700 w-[190px]
               focus:ring-2 focus:ring-teal-500 focus:border-teal-500 transition bg-white">
  <option value="TODOS">Todos os Farmacêuticos</option>
</select>
      <select id="filtroSLA" onchange="processarFiltros()"
              class="flex-shrink-0 border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-gray-700 max-w-[150px]
                     focus:ring-2 focus:ring-teal-500 focus:border-teal-500 transition bg-white">
        <option value="TODOS">Qualquer prazo</option>
        <option value="VENCIDO">🔴 Vencido</option>
        <option value="VENCENDO">🟡 Vencendo (&lt;12h)</option>
        <option value="OK">🟢 No Prazo</option>
        <option value="SEM">⚪ Sem SLA</option>
      </select>
      <div class="flex-shrink-0 flex items-center gap-1 text-sm text-gray-500 whitespace-nowrap">
        <label class="text-xs font-semibold text-gray-500">De</label>
        <input type="date" id="filtroDe" onchange="processarFiltros()"
               class="border border-gray-300 rounded-lg px-2 py-1.5 text-sm w-[130px]
                      focus:ring-2 focus:ring-teal-500 focus:border-teal-500 transition bg-white">
        <label class="text-xs font-semibold text-gray-500">até</label>
        <input type="date" id="filtroAte" onchange="processarFiltros()"
               class="border border-gray-300 rounded-lg px-2 py-1.5 text-sm w-[130px]
                      focus:ring-2 focus:ring-teal-500 focus:border-teal-500 transition bg-white">
      </div>
      <button onclick="limparFiltros()"
              class="flex-shrink-0 text-xs text-teal-600 hover:text-teal-800 font-semibold transition flex items-center gap-1">
        <i class="fas fa-times-circle"></i> Limpar
      </button>
      <span id="contadorResultados" class="flex-shrink-0 ml-auto text-xs text-gray-400 font-medium whitespace-nowrap"></span>
    </div>

    <!-- =====================================================
         VIEW KANBAN
    ===================================================== -->
    <div id="view-kanban" class="p-4 flex-1 overflow-hidden flex flex-col md:flex-row gap-4">

      <!-- Coluna Triagem -->
      <div class="flex-1 flex flex-col min-w-0">
        <div class="bg-orange-100 border-t-4 border-orange-500 rounded-t shadow-sm p-3 flex items-center justify-between">
          <h2 class="text-base font-bold text-orange-800 flex items-center gap-2">
            <i class="fas fa-filter text-orange-500"></i> Triagem
          </h2>
          <span id="contador-triagem" class="bg-orange-200 text-orange-800 py-0.5 px-2.5 rounded-full text-xs font-bold">0</span>
        </div>
        <div id="coluna-triagem" class="bg-orange-50 rounded-b shadow-sm p-3 flex-1 overflow-y-auto kanban-col space-y-2"></div>
        <button id="btnMaisTriagem" onclick="carregarMais('triagem')"
                class="hidden mt-2 text-xs text-orange-600 font-semibold hover:text-orange-800 text-center py-1">
          <i class="fas fa-chevron-down mr-1"></i> Ver mais casos
        </button>
      </div>

      <!-- Coluna Investigação -->
      <div class="flex-1 flex flex-col min-w-0">
        <div class="bg-blue-100 border-t-4 border-blue-500 rounded-t shadow-sm p-3 flex items-center justify-between">
          <h2 class="text-base font-bold text-blue-800 flex items-center gap-2">
            <i class="fas fa-microscope text-blue-500"></i> Em Investigação
          </h2>
          <span id="contador-investigacao" class="bg-blue-200 text-blue-800 py-0.5 px-2.5 rounded-full text-xs font-bold">0</span>
        </div>
        <div id="coluna-investigacao" class="bg-blue-50 rounded-b shadow-sm p-3 flex-1 overflow-y-auto kanban-col space-y-2"></div>
        <button id="btnMaisInvestigacao" onclick="carregarMais('investigacao')"
                class="hidden mt-2 text-xs text-blue-600 font-semibold hover:text-blue-800 text-center py-1">
          <i class="fas fa-chevron-down mr-1"></i> Ver mais casos
        </button>
      </div>

      <!-- Coluna Concluídos -->
      <div class="flex-1 flex flex-col min-w-0">
        <div class="bg-gray-200 border-t-4 border-gray-500 rounded-t shadow-sm p-3 flex items-center justify-between">
          <h2 class="text-base font-bold text-gray-700 flex items-center gap-2">
            <i class="fas fa-check-double text-gray-500"></i> Finalizados / Descartados
          </h2>
          <span id="contador-concluidos" class="bg-gray-300 text-gray-700 py-0.5 px-2.5 rounded-full text-xs font-bold">0</span>
        </div>
        <div id="coluna-concluidos" class="bg-gray-100 rounded-b shadow-sm p-3 flex-1 overflow-y-auto kanban-col space-y-2"></div>
        <button id="btnMaisConcluidos" onclick="carregarMais('concluidos')"
                class="hidden mt-2 text-xs text-gray-500 font-semibold hover:text-gray-700 text-center py-1">
          <i class="fas fa-chevron-down mr-1"></i> Ver mais casos
        </button>
      </div>

    </div>

    <!-- =====================================================
         VIEW DASHBOARD
    ===================================================== -->
    <div id="view-dashboard" class="hidden p-6 flex-1 overflow-y-auto bg-gray-100 fade-in">
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
        <div class="bg-white p-4 rounded-lg shadow-sm border-l-4 border-blue-500">
          <p class="text-xs text-gray-500 font-bold uppercase">Total Rastreados</p>
          <p id="dashCardTotal" class="text-2xl font-black text-gray-800">0</p>
        </div>
        <div class="bg-white p-4 rounded-lg shadow-sm border-l-4 border-red-500">
          <p class="text-xs text-gray-500 font-bold uppercase">RAMs Confirmadas</p>
          <p id="dashCardRAMs" class="text-2xl font-black text-red-600">0</p>
        </div>
        <div class="bg-white p-4 rounded-lg shadow-sm border-l-4 border-gray-400">
          <p class="text-xs text-gray-500 font-bold uppercase">Falsos Positivos</p>
          <p id="dashCardDescartes" class="text-2xl font-black text-gray-600">0</p>
        </div>
        <div class="bg-white p-4 rounded-lg shadow-sm border-l-4 border-orange-400">
          <p class="text-xs text-gray-500 font-bold uppercase">Aguardando Avaliação</p>
          <p id="dashCardPendentes" class="text-2xl font-black text-orange-600">0</p>
        </div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div class="bg-white p-4 rounded-lg shadow-sm border-l-4 border-teal-500">
          <p class="text-xs text-gray-500 font-bold uppercase">Tempo Médio de Análise (Triagem)</p>
          <p id="dashCardTempoMedio" class="text-2xl font-black text-teal-700">—</p>
          <p class="text-[10px] text-gray-400 mt-0.5">Evento → triagem farmacêutica · gatilhos (BA)</p>
        </div>
        <div class="bg-white p-4 rounded-lg shadow-sm border-l-4 border-red-600">
          <p class="text-xs text-gray-500 font-bold uppercase">Triagens Atrasadas (SLA)</p>
          <p id="dashCardAtrasados" class="text-2xl font-black text-red-700">0</p>
          <p id="dashCardAtrasadosSub" class="text-[10px] text-gray-400 mt-0.5">—</p>
        </div>
      </div>
       <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div class="bg-white p-5 rounded-lg shadow-sm">
          <h3 class="font-bold text-gray-700 border-b pb-2 mb-4">
            <i class="fas fa-chart-pie text-teal-600 mr-2"></i> Desfecho dos Gatilhos
          </h3>
          <div class="relative h-64 w-full flex justify-center"><canvas id="graficoDesfechos"></canvas></div>
        </div>
        <div class="bg-white p-5 rounded-lg shadow-sm">
          <h3 class="font-bold text-gray-700 border-b pb-2 mb-4">
            <i class="fas fa-heartbeat text-red-500 mr-2"></i> Distribuição de Gravidade
          </h3>
          <div class="relative h-64 w-full flex justify-center"><canvas id="graficoGravidade"></canvas></div>
        </div>
        <div class="bg-white p-5 rounded-lg shadow-sm">
          <h3 class="font-bold text-gray-700 border-b pb-2 mb-4">
            <i class="fas fa-hospital text-blue-500 mr-2"></i> Setores com Mais Eventos
          </h3>
          <div class="relative h-64 w-full"><canvas id="graficoSetores"></canvas></div>
        </div>
        <div class="bg-white p-5 rounded-lg shadow-sm">
          <h3 class="font-bold text-gray-700 border-b pb-2 mb-4">
            <i class="fas fa-pills text-purple-500 mr-2"></i> Top Medicamentos Suspeitos
          </h3>
          <div class="relative h-64 w-full"><canvas id="graficoMedicamentos"></canvas></div>
        </div>
        <div class="bg-white p-5 rounded-lg shadow-sm">
          <h3 class="font-bold text-gray-700 border-b pb-2 mb-4">
            <i class="fas fa-bullseye text-red-600 mr-2"></i> Conversão Gatilho → RAM (Busca Ativa)
          </h3>
          <div class="relative h-64 w-full flex justify-center"><canvas id="graficoGatilhoRam"></canvas></div>
        </div>
        <div class="bg-white p-5 rounded-lg shadow-sm">
          <h3 class="font-bold text-gray-700 border-b pb-2 mb-4">
            <i class="fas fa-layer-group text-orange-500 mr-2"></i> Notificações de RAM por Setor × Gravidade
          </h3>
          <div class="relative h-64 w-full"><canvas id="graficoGravidadeSetor"></canvas></div>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
        <div class="bg-white p-5 rounded-lg shadow-sm">
          <h3 class="font-bold text-gray-700 border-b pb-2 mb-4">
            <i class="fas fa-ranking-star text-blue-500 mr-2"></i> Ranking de Produção por Setor
          </h3>
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="text-left text-gray-400 uppercase text-[10px] border-b border-gray-200">
                  <th class="py-1.5 px-2">#</th>
                  <th class="py-1.5 px-2">Setor</th>
                  <th class="py-1.5 px-2 text-center">Concluídos</th>
                  <th class="py-1.5 px-2 text-center">Rastreados</th>
                  <th class="py-1.5 px-2 text-right">% Conclusão</th>
                </tr>
              </thead>
              <tbody id="rankingSetoresBody"></tbody>
            </table>
          </div>
        </div>
        <div class="bg-white p-5 rounded-lg shadow-sm">
          <h3 class="font-bold text-gray-700 border-b pb-2 mb-4">
            <i class="fas fa-user-md text-teal-600 mr-2"></i> Ranking de Investigação por Farmacêutico
          </h3>
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="text-left text-gray-400 uppercase text-[10px] border-b border-gray-200">
                  <th class="py-1.5 px-2">#</th>
                  <th class="py-1.5 px-2">Farmacêutico</th>
                  <th class="py-1.5 px-2 text-center">Casos Concluídos</th>
                  <th class="py-1.5 px-2 text-right">% do Total</th>
                </tr>
              </thead>
              <tbody id="rankingFarmaceuticosBody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- =====================================================
         MODAL TRIAGEM
    ===================================================== -->
    <div id="modalTriagem" class="fixed inset-0 bg-black bg-opacity-60 hidden flex items-center justify-center z-50">
      <div class="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6 fade-in">
        <h2 class="text-xl font-bold text-gray-800 mb-2 border-b pb-3">
          <i class="fas fa-filter text-orange-500 mr-2"></i> Triagem de Gatilho (Trigger Tools)
        </h2>
        <div class="bg-gray-50 p-3 rounded-lg text-xs mb-4 border border-gray-200">
        <p class="text-gray-600">
        <strong>Prontuário:</strong> <span id="trgProntuario" class="text-gray-800 font-bold"></span>
          &nbsp;·&nbsp;
        <strong>Iniciais:</strong> <span id="trgIniciais" class="text-gray-800 font-bold"></span>
          &nbsp;·&nbsp;
        <strong>Setor:</strong> <span id="trgSetor" class="text-gray-800"></span>
        </p>
        <p class="text-red-600 font-bold mt-1 text-sm">Gatilho: <span id="trgGatilho"></span></p>
        </div>
        <form onsubmit="enviarTriagem(event)" id="formTriagem" class="space-y-4">
          <div class="p-3 bg-orange-50 border border-orange-200 rounded-lg">
            <label class="block text-sm font-bold text-orange-800 mb-2">Foi confirmado como RAM?</label>
            <div class="flex gap-6">
              <label class="flex items-center gap-2 cursor-pointer text-sm text-gray-800">
                <input type="radio" name="trgHouveRam" value="SIM" onchange="toggleFormTriagem(true)"> Sim, houve RAM
              </label>
              <label class="flex items-center gap-2 cursor-pointer text-sm text-gray-800">
                <input type="radio" name="trgHouveRam" value="NAO" onchange="toggleFormTriagem(false)"> Não, descartar
              </label>
            </div>
          </div>
          <div id="trgAreaSim" class="hidden p-3 bg-green-50 border border-green-200 rounded-lg">
            <label class="block text-xs font-bold text-green-800 mb-1">Medicamento Suspeito Real</label>
            <input type="text" id="trgMedSuspeito"
                   class="w-full border rounded-lg px-3 py-2 text-sm uppercase focus:ring-2 focus:ring-green-500 text-gray-800">
          </div>
          <div id="trgAreaNao" class="hidden p-3 bg-gray-50 border border-gray-300 rounded-lg">
            <label class="block text-xs font-bold text-gray-700 mb-1">Motivo do Descarte</label>
            <!-- E3: populado via _aplicarConfig() em js_core (config.listas.motivo_descarte) -->
            <select id="trgMotivoDescarte"
                    class="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-gray-400 text-gray-800">
              <option value="">Selecione o motivo…</option>
            </select>
          </div>
          <div class="pt-3 flex justify-end space-x-3 border-t">
            <button type="button" onclick="fecharModalTriagem()"
                    class="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg font-semibold text-sm hover:bg-gray-200 transition">
              Cancelar
            </button>
            <button type="submit" id="btnSalvarTriagem"
                    class="px-4 py-2 bg-orange-500 text-white rounded-lg font-semibold text-sm hover:bg-orange-600 transition">
              <i class="fas fa-check mr-1"></i> Salvar e Enviar
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- =====================================================
         MODAL INVESTIGAÇÃO
    ===================================================== -->
    <div id="modalInvestigacao" class="fixed inset-0 bg-black bg-opacity-70 hidden flex items-center justify-center z-50 fade-in">
      <div class="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[95vh] overflow-hidden flex flex-col">

        <!-- Header -->
        <div class="bg-blue-700 p-4 flex justify-between items-center text-white flex-shrink-0">
          <div class="flex items-center gap-3">
            <i class="fas fa-microscope text-blue-200 text-lg"></i>
            <div>
              <h2 class="text-lg font-bold leading-tight">Investigação de RAM</h2>
              <p class="text-blue-200 text-xs" id="invSubtitulo">—</p>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <span id="invTipoBadge" class="bg-white text-blue-800 text-xs font-bold px-3 py-1 rounded-full shadow-sm">BA</span>
            <span id="autosaveStatus" class="text-xs text-blue-200 opacity-0 flex items-center gap-1 transition-opacity duration-400">
              <i class="fas fa-cloud-upload-alt"></i> Rascunho salvo
            </span>
            <button type="button" onclick="fecharModalInvestigacao()"
                    class="ml-2 text-blue-200 hover:text-white transition-colors"
                    title="Fechar investigação">
              <i class="fas fa-times text-lg"></i>
            </button>
          </div>
        </div>

        <!-- Barra de progresso -->
        <div class="bg-blue-50 border-b border-blue-100 px-5 py-2 flex-shrink-0 flex items-center gap-3">
          <span class="text-xs font-semibold text-blue-700 whitespace-nowrap" id="textoProgresso">0 de 12 campos</span>
          <div class="flex-1 bg-blue-100 rounded-full h-2 overflow-hidden">
            <div id="barraProgresso" class="h-2 rounded-full bg-red-400 transition-all duration-300" style="width:0%"></div>
          </div>
          <span class="text-xs text-blue-500" id="textoProgressoPct">0%</span>
        </div>

        <!-- Corpo scrollável -->
        <div class="p-5 overflow-y-auto bg-gray-50 flex-1">

          <!-- Info do caso (read-only) — B2: agora com Iniciais e Idade -->
          <div class="bg-white p-4 border border-blue-100 rounded-xl shadow-sm mb-5 flex flex-wrap gap-6 text-sm">
            <div>
              <span class="text-gray-400 text-[10px] font-bold block uppercase tracking-wider">Prontuário</span>
              <p id="invProntuario" class="font-bold text-gray-800 text-base">-</p>
            </div>
            <!-- B2 — Iniciais do paciente -->
            <div>
              <span class="text-gray-400 text-[10px] font-bold block uppercase tracking-wider">Iniciais</span>
              <p id="invIniciais" class="font-bold text-gray-800">-</p>
            </div>
            <!-- B2 — Idade calculada -->
            <div>
              <span class="text-gray-400 text-[10px] font-bold block uppercase tracking-wider">Idade</span>
              <p id="invIdade" class="font-semibold text-gray-600">-</p>
            </div>
            <div>
              <span class="text-gray-400 text-[10px] font-bold block uppercase tracking-wider">Setor</span>
              <p id="invSetor" class="font-bold text-gray-800">-</p>
            </div>
            <div class="flex-1">
              <span class="text-gray-400 text-[10px] font-bold block uppercase tracking-wider">Medicamento Suspeito</span>
              <p id="invMedicamento" class="font-bold text-red-600 uppercase text-base">-</p>
            </div>
            <div>
              <span class="text-gray-400 text-[10px] font-bold block uppercase tracking-wider">Data Evento</span>
              <p id="invDataEvento" class="font-semibold text-gray-600">-</p>
            </div>
          </div>

          <form id="formInvestigacao" class="space-y-5">

            <!-- Fase 6 — Relato original da Assistência (read-only; só aparece em casos DE) -->
<div id="invBlocoNotificador"
     class="hidden bg-amber-50 border border-amber-200 rounded-xl p-4 shadow-sm">
  <h3 class="text-sm font-bold text-amber-800 mb-3 border-b border-amber-200 pb-2 flex items-center gap-2">
    <i class="fas fa-bullhorn text-amber-500"></i> Relato da Assistência (original — não editável)
  </h3>
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
    <div>
      <p class="text-xs font-bold text-amber-700 mb-1">Descrição do evento</p>
      <p id="invNotifRelato" class="text-gray-700 whitespace-pre-wrap">—</p>
    </div>
    <div>
      <p class="text-xs font-bold text-amber-700 mb-1">Conduta imediata informada</p>
      <p id="invNotifConduta" class="text-gray-700 whitespace-pre-wrap">—</p>
    </div>
  </div>
  <p id="invNotifMeta" class="text-xs text-amber-600 mt-3"></p>
</div>

            <!-- Seção 1: Dados Clínicos -->
            <div class="bg-white p-5 border border-gray-200 rounded-xl shadow-sm">
              <h3 class="text-sm font-bold text-gray-700 mb-4 border-b pb-2 flex items-center gap-2">
                <i class="fas fa-notes-medical text-teal-500"></i> 1. Dados Clínicos e Evento
              </h3>
              <div class="space-y-4">
                <div>
                  <label class="block text-xs font-bold text-gray-600 mb-1">Resumo da História Clínica</label>
                  <textarea id="invHistoriaClinica" rows="2"
                            oninput="agendarAutosave(); atualizarProgresso()"
                            class="w-full border rounded-lg px-3 py-2 text-sm bg-gray-50 focus:ring-2 focus:ring-blue-400 focus:border-blue-400 resize-none transition"
                            placeholder="Histórico clínico relevante do paciente…"></textarea>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label class="block text-xs font-bold text-gray-600 mb-1">Relato do Evento</label>
                    <textarea id="invRelatoEvento" rows="2"
                              oninput="agendarAutosave(); atualizarProgresso()"
                              class="w-full border rounded-lg px-3 py-2 text-sm bg-gray-50 focus:ring-2 focus:ring-blue-400 focus:border-blue-400 resize-none transition"
                              placeholder="Descrição da reação adversa observada…"></textarea>
                  </div>
                  <div>
                    <label class="block text-xs font-bold text-gray-600 mb-1">Exames Complementares</label>
                    <textarea id="invExames" rows="2"
                              oninput="agendarAutosave(); atualizarProgresso()"
                              class="w-full border rounded-lg px-3 py-2 text-sm bg-gray-50 focus:ring-2 focus:ring-blue-400 focus:border-blue-400 resize-none transition"
                              placeholder="Resultados laboratoriais ou de imagem relevantes…"></textarea>
                  </div>
                </div>
              </div>
            </div>

            <!-- Seção 2: Condutas -->
            <div class="bg-white p-5 border border-gray-200 rounded-xl shadow-sm">
              <h3 class="text-sm font-bold text-gray-700 mb-4 border-b pb-2 flex items-center gap-2">
                <i class="fas fa-heartbeat text-teal-500"></i> 2. Condutas e Evolução
              </h3>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label class="block text-xs font-bold text-gray-600 mb-1">Medicamento Readministrado?</label>
                  <!-- A3: populado via _aplicarConfig() (config.listas.readministrado) -->
                  <select id="invReadministrado"
                          onchange="agendarAutosave(); atualizarProgresso()"
                          class="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400 transition">
                    <option value="">Selecione…</option>
                  </select>
                </div>
                <div>
                  <label class="block text-xs font-bold text-gray-600 mb-1">Evolução Pós Condutas</label>
                  <!-- A3: populado via _aplicarConfig() (config.listas.evolucao) -->
                  <select id="invEvolucao"
                          onchange="agendarAutosave(); atualizarProgresso()"
                          class="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400 transition">
                    <option value="">Selecione…</option>
                  </select>
                </div>
              </div>
            </div>

            <!-- Seção 3: Naranjo -->
            <div class="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
              <div class="bg-gradient-to-r from-gray-50 to-gray-100 px-5 py-3 border-b flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                <h3 class="font-bold text-gray-700 flex items-center gap-2">
                  <i class="fas fa-calculator text-teal-500"></i> 3. Algoritmo de Naranjo
                  <span class="text-[10px] font-normal text-gray-400">(Causalidade de RAM)</span>
                </h3>
                <div id="naranjoFaixaContainer"
                     class="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-bold transition-all duration-300 bg-gray-100 text-gray-700 border-gray-300">
                  <span id="naranjoEscore" class="text-lg font-extrabold">0</span>
                  <div>
                    <span id="naranjoClassificacao" class="block text-xs font-bold">DUVIDOSA</span>
                    <span id="naranjoInterpretacao" class="block text-[10px] font-normal opacity-75">Escore ≤ 0</span>
                  </div>
                </div>
              </div>
              <div class="px-5 py-2 bg-gray-50 border-b flex flex-wrap gap-3 text-[10px] font-semibold text-gray-500">
                <span class="flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full bg-gray-300 inline-block"></span> DUVIDOSA (≤ 0)</span>
                <span class="flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full bg-yellow-300 inline-block"></span> POSSÍVEL (1–4)</span>
                <span class="flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full bg-orange-400 inline-block"></span> PROVÁVEL (5–8)</span>
                <span class="flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full bg-red-500 inline-block"></span> DEFINIDA (≥ 9)</span>
              </div>
              <div class="p-5 space-y-1" id="naranjoPerguntas"></div>
            </div>

            <!-- Seção 4: Fechamento Clínico -->
            <div class="bg-white p-5 border border-gray-200 rounded-xl shadow-sm">
              <h3 class="text-sm font-bold text-gray-700 mb-4 border-b pb-2 flex items-center gap-2">
                <i class="fas fa-clipboard-check text-teal-500"></i> 4. Fechamento Clínico
                <span class="ml-auto text-[10px] text-red-500 font-semibold">* Obrigatório para finalizar</span>
              </h3>
              <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                <div>
                  <label class="block text-xs font-bold text-gray-600 mb-1">Gravidade <span class="text-red-500">*</span></label>
                  <!-- A3: populado via _aplicarConfig() (config.listas.gravidade) -->
                  <select id="invGravidade"
                          onchange="agendarAutosave(); atualizarProgresso()"
                          class="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400 transition">
                    <option value="">Selecione…</option>
                  </select>
                </div>
                <div>
                  <label class="block text-xs font-bold text-gray-600 mb-1">Desfecho <span class="text-red-500">*</span></label>
                  <!-- A3: populado via _aplicarConfig() (config.listas.desfecho) -->
                  <select id="invDesfecho"
                          onchange="agendarAutosave(); atualizarProgresso()"
                          class="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400 transition">
                    <option value="">Selecione…</option>
                  </select>
                </div>
                <div>
                  <label class="block text-xs font-bold text-gray-600 mb-1">Conclusão <span class="text-red-500">*</span></label>
                  <!-- A3: populado via _aplicarConfig() (config.listas.conclusao) -->
                  <select id="invConclusao"
                          onchange="agendarAutosave(); atualizarProgresso()"
                          class="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400 transition">
                    <option value="">Selecione…</option>
                  </select>
                </div>
              </div>

              <!-- Fase 8 — Exportação E2B(R3): dados adicionais exigidos pelo VigiMed -->
              <div class="grid grid-cols-1 md:grid-cols-5 gap-4 mb-4">
                <div class="md:col-span-2">
                  <label class="block text-xs font-bold text-gray-600 mb-1">
                    Reação/Evento (termo curto) <span class="text-red-500">*</span>
                  </label>
                  <input type="text" id="invReacaoTermo"
                         oninput="agendarAutosave(); atualizarProgresso()"
                         placeholder="Ex: Tontura, Náusea, Rash cutâneo…"
                         class="w-full border rounded-lg px-3 py-2 text-sm uppercase focus:ring-2 focus:ring-blue-400 transition">
                  <p class="text-[10px] text-gray-400 mt-1">Termo objetivo — usado na exportação para o VIGIMED, não a narrativa completa.</p>
                </div>
                <div>
                  <label class="block text-xs font-bold text-gray-600 mb-1">Dose</label>
                  <input type="text" id="invDoseMedicamento"
                         oninput="agendarAutosave(); atualizarProgresso()"
                         placeholder="Ex: 10"
                         class="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400 transition">
                </div>
                <div>
                  <label class="block text-xs font-bold text-gray-600 mb-1">Unidade</label>
                  <input type="text" id="invDoseUnidade"
                         oninput="agendarAutosave(); atualizarProgresso()"
                         placeholder="Ex: mg"
                         class="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400 transition">
                </div>
                <div>
                  <label class="block text-xs font-bold text-gray-600 mb-1">Via de Administração</label>
                  <input type="text" id="invViaAdministracao"
                         oninput="agendarAutosave(); atualizarProgresso()"
                         placeholder="Ex: Oral, EV, IM…"
                         class="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400 transition">
                </div>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-5 gap-4 mb-4">
                <div>
                  <label class="block text-xs font-bold text-gray-600 mb-1">Data de Início da Reação</label>
                  <input type="datetime-local" id="invDataInicioReacao"
                         onchange="agendarAutosave(); atualizarProgresso()"
                         class="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400 transition">
                </div>
                <div>
                  <label class="block text-xs font-bold text-gray-600 mb-1">Início da Administração</label>
                  <input type="datetime-local" id="invDataInicioAdministracao"
                         onchange="agendarAutosave(); atualizarProgresso()"
                         class="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400 transition">
                </div>
                <div>
                  <label class="block text-xs font-bold text-gray-600 mb-1">Data de Nascimento do Paciente</label>
                  <input type="date" id="invDataNascimento"
                         onchange="agendarAutosave(); atualizarProgresso()"
                         class="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400 transition">
                </div>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div class="md:col-span-3">
                  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label class="block text-xs font-bold text-gray-600 mb-1">Farmacêutico(a)</label>
                      <input type="text" id="invFarmaceutico"
                             oninput="agendarAutosave(); atualizarProgresso()"
                             class="w-full border rounded-lg px-3 py-2 text-sm uppercase focus:ring-2 focus:ring-blue-400 transition"
                             placeholder="CRF ou nome completo">
                    </div>
                    <div>
                      <label class="block text-xs font-bold text-gray-600 mb-1">
                        <i class="fas fa-barcode text-gray-400 mr-1"></i>Lote
                      </label>
                      <input type="text" id="invLote"
                             oninput="agendarAutosave(); atualizarProgresso()"
                             class="w-full border rounded-lg px-3 py-2 text-sm uppercase focus:ring-2 focus:ring-blue-400 transition"
                             placeholder="Ex: 2024A123">
                    </div>
                    <div>
                      <label class="block text-xs font-bold text-gray-600 mb-1">
                        <i class="fas fa-flask text-gray-400 mr-1"></i>Laboratório
                      </label>
                      <input type="text" id="invLaboratorio"
                             oninput="agendarAutosave(); atualizarProgresso()"
                             class="w-full border rounded-lg px-3 py-2 text-sm uppercase focus:ring-2 focus:ring-blue-400 transition"
                             placeholder="Ex: NOVAFARMA">
                    </div>
                  </div>
                  <div id="invBlocoConclusaoVigimed" class="hidden mt-4 bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                    <h4 class="text-xs font-bold text-emerald-800 mb-3 flex items-center gap-2">
                      <i class="fas fa-file-import"></i> Importação no VigiMed
                    </h4>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label class="block text-xs font-bold text-gray-600 mb-1">Nº Notificação Vigimed</label>
                        <input type="text" id="invNumVigimed"
                               class="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-emerald-400 transition">
                      </div>
                      <div>
                        <label class="block text-xs font-bold text-gray-600 mb-1">Data da Importação</label>
                        <input type="datetime-local" id="invDataVigimed"
                               class="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-emerald-400 transition">
                      </div>
                    </div>
                    <button type="button" onclick="salvarImportacaoVigimed()" id="btnSalvarVigimed"
                            class="mt-3 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg transition flex items-center gap-2">
                      <i class="fas fa-check"></i> Registrar Importação
                    </button>
                    <p class="text-[10px] text-emerald-700 mt-2">
                      Disponível só após "Finalizar Caso" — exporte o XML, importe no VigiMed e registre aqui o nº/data.
                    </p>
                  </div>
                </div>
              </div>
              <div class="mt-4">
                <label class="block text-xs font-bold text-gray-600 mb-1">Observações</label>
                <textarea id="invObservacoes" rows="2"
                          oninput="agendarAutosave(); atualizarProgresso()"
                          class="w-full border rounded-lg px-3 py-2 text-sm bg-gray-50 focus:ring-2 focus:ring-blue-400 resize-none transition"
                          placeholder="Informações adicionais relevantes…"></textarea>
              </div>
            </div>

          </form>
        </div>

        <!-- Footer do modal -->
        <div class="bg-white px-5 py-4 border-t flex justify-between items-center flex-shrink-0 rounded-b-xl">
          <button type="button" onclick="fecharModalInvestigacao()"
                  class="px-5 py-2.5 bg-white border border-gray-300 rounded-lg font-bold text-sm hover:bg-gray-50 transition">
            Cancelar
          </button>
          <div class="flex items-center gap-3">
            <button type="button" onclick="reabrirCaso()" id="btnReabrir"
                    class="hidden px-5 py-2.5 bg-amber-500 text-white rounded-lg font-bold text-sm hover:bg-amber-600 transition flex items-center gap-2"
                    title="Destrava os campos e retorna o caso para Em Investigação">
              <i class="fas fa-undo"></i> Retornar para Investigação
            </button>
            <button type="button" onclick="exportarE2B()" id="btnExportarE2B"
                    class="hidden px-5 py-2.5 bg-emerald-600 text-white rounded-lg font-bold text-sm hover:bg-emerald-700 transition flex items-center gap-2"
                    title="Gerar XML E2B(R3) para importação no VigiMed">
              <i class="fas fa-file-export"></i> Exportar VIGIMED
            </button>
            <button type="button" onclick="enviarInvestigacao(false)" id="btnRascunho"
                    class="px-5 py-2.5 bg-gray-600 text-white rounded-lg font-bold text-sm hover:bg-gray-700 transition flex items-center gap-2">
              <i class="fas fa-save"></i> Salvar Rascunho
            </button>
            <button type="button" onclick="enviarInvestigacao(true)" id="btnFinalizar"
                    class="px-5 py-2.5 bg-blue-600 text-white rounded-lg font-bold text-sm hover:bg-blue-700 transition flex items-center gap-2">
              <i class="fas fa-check-double"></i> Finalizar Caso
            </button>
          </div>
        </div>

      </div>
    </div>

    <!-- =====================================================
         MODAL NOTIFICAÇÃO INTERNA (Fase C)
         Acessível ao farmacêutico autenticado no Kanban.
         Casos entram diretamente em "Em Investigação" (DE).
    ===================================================== -->
    <div id="modalNotificacaoInterna"
         class="fixed inset-0 bg-black bg-opacity-60 hidden items-center justify-center z-50 fade-in">
      <div class="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[92vh] overflow-y-auto">

        <!-- Header roxo — diferencia visualmente do modal de triagem (laranja) e investigação (azul) -->
        <div class="bg-purple-700 p-5 text-white flex items-center justify-between">
          <div class="flex items-center gap-3">
            <i class="fas fa-user-md text-purple-200 text-lg"></i>
            <div>
              <h2 class="text-lg font-bold">Notificação de RAM — Farmácia Clínica</h2>
              <p class="text-purple-200 text-xs">Caso inserido diretamente em investigação (DE)</p>
            </div>
          </div>
          <button onclick="fecharNotificacaoInterna()" class="text-purple-200 hover:text-white transition">
            <i class="fas fa-times text-lg"></i>
          </button>
        </div>

        <form id="formNotificacaoInterna" onsubmit="enviarNotificacaoInterna(event)" class="p-6 space-y-6">

          <!-- Erro -->
          <div id="niAreaErro"
               class="hidden bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg"></div>

          <!-- Dados do Paciente -->
          <div class="border border-gray-200 rounded-xl overflow-hidden">
            <div class="bg-teal-50 border-b border-gray-200 px-4 py-2.5 flex items-center gap-2">
              <i class="fas fa-user-injured text-teal-700"></i>
              <h3 class="text-xs font-bold text-teal-800 uppercase tracking-wide">1. Dados do Paciente</h3>
            </div>
            <div class="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label class="block text-xs font-bold text-gray-600 mb-1">Prontuário *</label>
                <input type="tel" id="niProntuario" required pattern="[0-9]*"
                       class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50 focus:bg-white focus:ring-2 focus:ring-purple-500 outline-none transition"
                       placeholder="123456">
              </div>
              <div>
                <label class="block text-xs font-bold text-gray-600 mb-1">Iniciais *</label>
                <input type="text" id="niIniciais" required maxlength="10"
                       class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50 focus:bg-white focus:ring-2 focus:ring-purple-500 outline-none transition uppercase"
                       placeholder="G.C.A.N">
              </div>
              <div>
                <label class="block text-xs font-bold text-gray-600 mb-1">Data Nascimento</label>
                <input type="date" id="niNascimento"
                       class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50 focus:bg-white focus:ring-2 focus:ring-purple-500 outline-none transition">
              </div>
            </div>
          </div>

          <!-- Dados do Evento -->
          <div class="border border-gray-200 rounded-xl overflow-hidden">
            <div class="bg-orange-50 border-b border-gray-200 px-4 py-2.5 flex items-center gap-2">
              <i class="fas fa-exclamation-triangle text-orange-600"></i>
              <h3 class="text-xs font-bold text-orange-800 uppercase tracking-wide">2. Dados do Evento</h3>
            </div>
            <div class="p-4 space-y-4">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label class="block text-xs font-bold text-gray-600 mb-1">Setor / Clínica *</label>
                  <!-- Populado por abrirNotificacaoInterna() via configGlobal.setores -->
                  <select id="niSetor" required
                          onchange="_niAtualizarFarmaceutico(this.value)"
                          class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50 focus:bg-white focus:ring-2 focus:ring-purple-500 outline-none transition">
                    <option value="">Carregando…</option>
                  </select>
                </div>
                <div>
                  <label class="block text-xs font-bold text-gray-600 mb-1">Data do Evento</label>
                  <input type="datetime-local" id="niDataEvento"
                         class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50 focus:bg-white focus:ring-2 focus:ring-purple-500 outline-none transition">
                </div>
              </div>
              <div>
                <label class="block text-xs font-bold text-gray-600 mb-1">Medicamento Suspeito *</label>
                <input type="text" id="niMedicamento" required
                       class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50 focus:bg-white focus:ring-2 focus:ring-purple-500 outline-none transition uppercase"
                       placeholder="Ex: VANCOMICINA">
              </div>
              <div>
                <label class="block text-xs font-bold text-gray-600 mb-1">Descrição do Evento *</label>
                <textarea id="niDescricao" required rows="2"
                          class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50 focus:bg-white focus:ring-2 focus:ring-purple-500 outline-none transition resize-none"
                          placeholder="Descreva a reação adversa observada…"
                          oninput="this.style.height=''; this.style.height=this.scrollHeight+'px'"></textarea>
              </div>
              <div>
                <label class="block text-xs font-bold text-gray-600 mb-1">Condutas realizadas</label>
                <textarea id="niCondutas" rows="1"
                          class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50 focus:bg-white focus:ring-2 focus:ring-purple-500 outline-none transition resize-none"
                          placeholder="Ex: medicamento suspenso, hidratação iniciada…"
                          oninput="this.style.height=''; this.style.height=this.scrollHeight+'px'"></textarea>
              </div>
            </div>
          </div>

          <!-- Farmacêutico responsável -->
          <div class="border border-gray-200 rounded-xl overflow-hidden">
            <div class="bg-blue-50 border-b border-gray-200 px-4 py-2.5 flex items-center gap-2">
              <i class="fas fa-user-md text-blue-700"></i>
              <h3 class="text-xs font-bold text-blue-800 uppercase tracking-wide">3. Farmacêutico Responsável</h3>
            </div>
            <div class="p-4">
              <label class="block text-xs font-bold text-gray-600 mb-1">Nome / CRF</label>
              <input type="text" id="niFarmaceutico"
                     class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50 focus:bg-white focus:ring-2 focus:ring-purple-500 outline-none transition uppercase"
                     placeholder="Preenchido automaticamente pelo setor">
              <p class="text-[10px] text-gray-400 mt-1">Pré-preenchido pelo setor ou pelo usuário logado. Edite se necessário.</p>
            </div>
          </div>

          <!-- Botões -->
          <div class="flex justify-end gap-3 pt-2">
            <button type="button" onclick="fecharNotificacaoInterna()"
                    class="px-5 py-2.5 bg-white border border-gray-300 rounded-lg font-bold text-sm hover:bg-gray-50 transition">
              Cancelar
            </button>
            <button type="submit" id="btnEnviarNI"
                    class="px-6 py-2.5 bg-purple-600 text-white rounded-lg font-bold text-sm hover:bg-purple-700 transition flex items-center gap-2 shadow">
              <i class="fas fa-paper-plane"></i> Registrar RAM
            </button>
          </div>

        </form>
      </div>
    </div>

  </div><!-- /app-container -->

 <div id="modalSobre" class="fixed inset-0 bg-black/60 hidden items-center justify-center z-50 p-4 backdrop-blur-sm">
  <div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg transform transition-all">

    <div class="bg-gradient-to-br from-teal-700 to-teal-900 rounded-t-2xl px-6 py-4 text-white relative">
      <button onclick="document.getElementById('modalSobre').classList.replace('flex','hidden')"
              class="absolute top-4 right-4 text-teal-200 hover:text-white transition-colors p-1"
              aria-label="Fechar">
        <i class="fas fa-times text-base"></i>
      </button>

      <div class="flex items-center gap-3">
        <div class="bg-white/10 rounded-xl w-11 h-11 flex items-center justify-center shadow-inner">
          <i class="fas fa-shield-virus text-teal-100 text-lg"></i>
        </div>
        <div>
          <h2 class="text-lg font-bold leading-tight tracking-wide">VigiRAM HRN</h2>
          <p class="text-teal-200 text-[11px] font-medium uppercase tracking-widest mt-0.5">Farmacovigilância Hospitalar</p>
        </div>
      </div>
    </div>

    <div class="p-6 space-y-4">

      <p class="text-xs text-gray-600 leading-relaxed">
        Gestão de casos de Reação Adversa a Medicamento (RAM), da captação por
        <strong class="text-gray-800">Busca Ativa</strong> ou
        <strong class="text-gray-800">Demanda Espontânea</strong> até a conclusão e notificação regulatória.
      </p>

      <div class="grid grid-cols-2 gap-3">

        <div class="bg-white border border-gray-100 shadow-sm rounded-xl p-3 hover:shadow-md hover:border-teal-100 transition-all">
          <div class="flex items-center gap-2 mb-1.5">
            <div class="bg-teal-50 w-6 h-6 rounded-md flex items-center justify-center shrink-0">
              <i class="fas fa-magnifying-glass-chart text-[10px] text-teal-600"></i>
            </div>
            <p class="text-[11px] font-bold text-gray-800 uppercase tracking-wide leading-tight">Busca Ativa</p>
          </div>
          <p class="text-[11px] text-gray-500 leading-snug">Triagem de gatilhos clínicos com priorização e prazos de resposta.</p>
        </div>

        <div class="bg-white border border-gray-100 shadow-sm rounded-xl p-3 hover:shadow-md hover:border-blue-100 transition-all">
          <div class="flex items-center gap-2 mb-1.5">
            <div class="bg-blue-50 w-6 h-6 rounded-md flex items-center justify-center shrink-0">
              <i class="fas fa-stethoscope text-[10px] text-blue-600"></i>
            </div>
            <p class="text-[11px] font-bold text-gray-800 uppercase tracking-wide leading-tight">Investigação</p>
          </div>
          <p class="text-[11px] text-gray-500 leading-snug">Fluxo por status (Kanban) e avaliação de causalidade por Naranjo.</p>
        </div>

        <div class="bg-white border border-gray-100 shadow-sm rounded-xl p-3 hover:shadow-md hover:border-purple-100 transition-all">
          <div class="flex items-center gap-2 mb-1.5">
            <div class="bg-purple-50 w-6 h-6 rounded-md flex items-center justify-center shrink-0">
              <i class="fas fa-file-medical text-[10px] text-purple-600"></i>
            </div>
            <p class="text-[11px] font-bold text-gray-800 uppercase tracking-wide leading-tight">Notificação VigiMed</p>
          </div>
          <p class="text-[11px] text-gray-500 leading-snug">Envio de casos concluídos à ANVISA com status de importação por caso.</p>
        </div>

        <div class="bg-white border border-gray-100 shadow-sm rounded-xl p-3 hover:shadow-md hover:border-amber-100 transition-all">
          <div class="flex items-center gap-2 mb-1.5">
            <div class="bg-amber-50 w-6 h-6 rounded-md flex items-center justify-center shrink-0">
              <i class="fas fa-chart-pie text-[10px] text-amber-600"></i>
            </div>
            <p class="text-[11px] font-bold text-gray-800 uppercase tracking-wide leading-tight">Indicadores</p>
          </div>
          <p class="text-[11px] text-gray-500 leading-snug">Produção por setor/farmacêutico, prazos e severidade das reações.</p>
        </div>
      </div>

      <div class="border-t border-gray-100 pt-3 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <div class="bg-gray-100 text-gray-500 rounded-full w-5 h-5 flex items-center justify-center text-[9px] shrink-0">
             <i class="fas fa-mortar-pestle"></i>
          </div>
          <div class="flex flex-col leading-tight">
             <span class="text-[10px] text-gray-400 font-medium">Idealização e Desenvolvimento</span>
             <span class="text-[11px] text-gray-700 font-semibold">Gisele Cristine · Farmácia · HRN</span>
          </div>
        </div>
        <span class="text-[10px] font-bold text-teal-700 bg-teal-50 px-2.5 py-1 rounded-full border border-teal-100 shadow-sm">v3.0</span>
      </div>

    </div>
  </div>
</div>
<!-- =====================================================
     RODAPÉ GLOBAL
===================================================== -->
<footer class="bg-teal-900 text-teal-300 text-[11px] px-6 py-2.5 flex justify-between items-center flex-shrink-0">
  <span>VigiRAM HRN © <?= new Date().getFullYear() ?> · Gisele Cristine · Hospital Regional Norte</span>
  <button onclick="document.getElementById('modalSobre').classList.replace('hidden','flex')"
          class="text-teal-300 hover:text-white transition flex items-center gap-1.5">
    <i class="fas fa-info-circle text-[10px]"></i> Sobre o sistema
  </button>
</footer>

<!-- Tooltip do avatar — position:fixed, coordenadas calculadas via JS -->
<div id="tooltipUsuario"
     class="hidden fixed whitespace-nowrap bg-gray-900 text-white text-xs font-semibold
            px-3 py-1.5 rounded-lg shadow-xl z-[9999] pointer-events-none"></div>

  <!-- =====================================================
       PARCIAIS JAVASCRIPT (injetados pelo GAS via include)
  ===================================================== -->
  <?!= include('js_core'); ?>
  <?!= include('js_kanban'); ?>
  <?!= include('js_triagem'); ?>
  <?!= include('js_investigacao'); ?>
  <?!= include('js_dashboard'); ?>
  <?!= include('js_notificacao_interna'); ?>
  <?!= include('js_admin'); ?>
</body>
</html>
```

---

## 📄 Arquivo [14/32]: Ingest.gs

```javascript
/**
 * @fileoverview Ingest.gs — Camada de ingestão / ETL (Fase 4: Firestore).
 *
 * MIGRAÇÃO: handleInsertDB trocado de Sheets para Firestore (casos_ram).
 *
 * handleUploadRaw NÃO MUDA — grava arquivo bruto no Drive, nunca tocou
 * Sheets/Firestore.
 *
 * handleGetTriggers NÃO MUDA — continua lendo DB_Antidotos do Sheets.
 * Essa aba (lista de medicamentos-gatilho) NÃO faz parte do escopo de
 * dados sensíveis/operacionais migrados (não tem PII de paciente, é
 * baixíssimo volume e baixa frequência de leitura pelo robô). Migrar
 * essa aba específica é opcional e de baixo risco — pode ser feito depois
 * se desejado, sem pressa.
 *
 * DEDUPLICAÇÃO: a versão Sheets lia toda a planilha pra montar um Set de
 * IDs existentes antes de inserir (O(n) de leitura). Na versão Firestore,
 * cada caso é verificado individualmente via fsGetDoc_ (lookup O(1) por
 * ID de documento) — mais rápido e sem precisar carregar a base inteira
 * na memória do GAS a cada execução do ETL.
 *
 * AJUSTE E2B (D.5 Sexo): handleInsertDB agora lê caso.sexo do payload do
 * ETL (SCHEMA.COL.SEXO / casos_ram.sexo). O robô PowerShell PRECISA passar
 * a chave "sexo" no JSON de insertDB — confirme o nome exato da coluna no
 * relatório de entradas bruto antes de alterar o lado PowerShell. Sem essa
 * chave, o campo grava vazio e E2B.gs cai no fallback nullFlavor="UNK".
 *
 * CONCORRÊNCIA: como cada inserção usa fsSetDoc_ com ID determinístico
 * (o id_caso vindo do ETL), duas chamadas concorrentes para o MESMO id_caso
 * resultam em upsert idempotente — não há duplicação mesmo sem lock
 * explícito. Isso é uma propriedade mais forte que o comTrava_ original,
 * que serializava TODA escrita (mesmo de casos diferentes).
 */

/**
 * Salva arquivo bruto no Google Drive (Camada Bronze). INALTERADO.
 */
function handleUploadRaw(e) {
  const folderId = e.parameter.folderId;
  const fileName = e.parameter.fileName;

  if (!folderId || !fileName) {
    return createJsonResponse({ status: 'erro', mensagem: 'folderId/fileName ausente.' });
  }
  validarFolderPermitido_(folderId); // Security.gs — lança se não autorizado

  const fileContent = Utilities.base64Decode(e.postData.contents);
  const folder = DriveApp.getFolderById(folderId);
  const blob = Utilities.newBlob(fileContent, MimeType.CSV, fileName);
  folder.createFile(blob);

  return createJsonResponse({ status: 'sucesso', mensagem: `Backup salvo no Drive: ${fileName}` });
}

/**
 * Insere múltiplos casos estruturados na base (Camada Ouro).
 * Anti-duplicação por id_caso (lookup individual no Firestore) e alertas
 * por setor (Notify.gs, inalterado).
 */
function handleInsertDB(e) {
  try {
    const dados = JSON.parse(e.postData.contents);

    let inseridos = 0;
    const novosCasosPorSetor = {};

    dados.forEach(function (caso) {
      const idLimpo = String(caso.id_caso).trim();

      // Anti-duplicação: lookup direto O(1), não precisa carregar a base inteira.
      const existente = fsGetDoc_(SCHEMA.FS.CASOS, idLimpo);
      if (existente) return;

      const agora = new Date();
      const objetoCaso = {
        id: idLimpo,
        data: caso.data_evento,
        tipo: 'BA',
        prontuario: caso.prontuario,
        iniciais: caso.iniciais_paciente,
        nascimento: caso.data_nascimento,
        sexo: caso.sexo || '',
        setor: caso.unidade_setor,
        medicamento: caso.medicamento_suspeito,
        status: SCHEMA.STATUS.TRIAGEM,
        sla: caso.prazo_sla,
        motivoDescarte: '', historiaClinica: '', relato: '', exames: '',
        readministrado: '', evolucao: '', desfecho: '', conclusao: '',
        naranjo: '', gravidade: '', farmaceutico: '', numVigimed: '',
        dataVigimed: '', observacoes: '', naranjoRespostas: '',
        lote: '', laboratorio: '', relatoNotificador: '', condutaNotificador: '',
        notificador: { nome: '', categoria: '', email: '', dataNotificacao: '' },
        auditoria: { atualizadoPor: 'ETL', atualizadoEm: agora }
      };

      fsSetDoc_(SCHEMA.FS.CASOS, idLimpo, objetoCaso);

      // Espelho síncrono no Sheets — sem reler o Firestore (objeto já em memória)
      // Se falhar, vai para fila de retry (processarFilaEspelho, trigger 5 min)
      espelharCasoNoSheets_(idLimpo, objetoCaso, 'INSERT');

      inseridos++;

      const setor = String(caso.unidade_setor).toUpperCase().trim();
      if (!novosCasosPorSetor[setor]) novosCasosPorSetor[setor] = [];
      novosCasosPorSetor[setor].push(caso);
    });

    if (inseridos > 0) {
      enviarAlertasAgrupados(novosCasosPorSetor); // Notify.gs — inalterado

      // Regra de Ouro #3: escrita sem trilha. Um log por LOTE (não por caso,
      // para não multiplicar chamadas Firestore/Sheets do ETL).
      fsRegistrarLog_('ETL_INSERT_LOTE', 'N/A',
        inseridos + ' caso(s) BA inseridos | setores: ' + Object.keys(novosCasosPorSetor).join(', '));

      // P1.1: sem isto os casos novos do robô só apareciam no Kanban após o
      // TTL de 45s do cache expirar — invalida como toda escrita em casos_ram.
      invalidarCasosCache_();
    }

    return createJsonResponse({ status: 'sucesso', inseridos: inseridos });
  } catch (erro) {
    return createJsonResponse({ status: 'erro', mensagem: erro.message });
  }
}

/**
 * Retorna a lista de gatilhos (DB_Antidotos) para o robô PowerShell.
 * INALTERADO — continua lendo do Sheets. Ver nota no cabeçalho do arquivo.
 */
function handleGetTriggers() {
  const plan = getSheet_(SCHEMA.ABAS.ANTIDOTOS);
  if (!plan) return createJsonResponse([]);
  const dados = plan.getDataRange().getValues();
  const triggers = [];
  for (let i = 1; i < dados.length; i++) {
    const medicamento = dados[i][0];
    const ativo = dados[i][3] != null ? dados[i][3] : true;
    if (medicamento && ativo) triggers.push(String(medicamento).trim());
  }
  return createJsonResponse(triggers);
}
```

---

## 📄 Arquivo [15/32]: js_admin.html

```html
<script>
// =========================================================
// js_admin.html — v2.0
//
// Modal de Configurações do Sistema (perfil ADMIN).
// Acessado via ícone de engrenagem na navbar.
// Seções: Usuários, E-mails, SLA, Setores, Listas, Gatilhos
//
// Depende de: tokenSessao, mostrarToast, escapeHtml (js_core)
// Backend: Admin.gs, Config_Write.gs
// =========================================================

// ─────────────────────────────────────────────────────────
// ABERTURA / FECHAMENTO DO MODAL PRINCIPAL
// ─────────────────────────────────────────────────────────
function abrirConfiguracoes() {
  let modal = document.getElementById('modalConfig');
  if (!modal) { _criarModalConfig(); modal = document.getElementById('modalConfig'); }
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  _abrirSecaoConfig('usuarios');
}

function fecharConfiguracoes() {
  const modal = document.getElementById('modalConfig');
  if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
}

// ─────────────────────────────────────────────────────────
// CRIAÇÃO DO MODAL (injetado uma vez no DOM)
// ─────────────────────────────────────────────────────────
function _criarModalConfig() {
  const modal = document.createElement('div');
  modal.id = 'modalConfig';
  modal.className = 'fixed inset-0 bg-black/60 hidden items-center justify-center z-50 p-4';
  modal.innerHTML = `
    <div class="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex overflow-hidden">

      <!-- SIDEBAR DE NAVEGAÇÃO -->
      <div class="w-52 bg-gray-900 flex flex-col flex-shrink-0">
        <div class="p-5 border-b border-gray-700">
          <div class="flex items-center gap-2">
            <i class="fas fa-cog text-teal-400"></i>
            <span class="text-white font-bold text-sm">Configurações</span>
          </div>
          <p class="text-gray-400 text-[10px] mt-0.5">VigiRAM · Admin</p>
        </div>
        <nav class="flex-1 p-3 space-y-1 overflow-y-auto">
          ${_menuItem('usuarios',  'fa-users',         'Usuários')}
          ${_menuItem('emails',    'fa-envelope',      'E-mails de Alerta')}
          ${_menuItem('sla',       'fa-clock',         'SLA')}
          ${_menuItem('setores',   'fa-hospital',      'Setores')}
          ${_menuItem('listas',    'fa-list',          'Listas / Dropdowns')}
          ${_menuItem('gatilhos',  'fa-pills',         'Gatilhos')}
        </nav>
        <div class="p-3 border-t border-gray-700">
          <button onclick="fecharConfiguracoes()"
                  class="w-full text-xs text-gray-400 hover:text-white flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-700 transition">
            <i class="fas fa-times-circle"></i> Fechar
          </button>
        </div>
      </div>

      <!-- ÁREA DE CONTEÚDO -->
      <div class="flex-1 flex flex-col overflow-hidden">
        <div id="cfgConteudo" class="flex-1 overflow-y-auto p-6 bg-gray-50"></div>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function _menuItem(id, icon, label) {
  return `<button id="cfgMenu_${id}" onclick="_abrirSecaoConfig('${id}')"
    class="cfg-menu-item w-full text-left text-xs text-gray-400 hover:text-white flex items-center gap-2.5 px-3 py-2.5 rounded-lg hover:bg-gray-700 transition font-medium">
    <i class="fas ${icon} w-4 text-center"></i> ${label}
  </button>`;
}

function _abrirSecaoConfig(secao) {
  // Destaca item ativo no menu
  document.querySelectorAll('.cfg-menu-item').forEach(b => {
    b.classList.remove('bg-teal-600', 'text-white');
    b.classList.add('text-gray-400');
  });
  const btn = document.getElementById('cfgMenu_' + secao);
  if (btn) { btn.classList.add('bg-teal-600', 'text-white'); btn.classList.remove('text-gray-400'); }

  const area = document.getElementById('cfgConteudo');
  area.innerHTML = `<div class="flex items-center justify-center h-40 text-gray-400">
    <i class="fas fa-spinner fa-spin mr-2"></i> Carregando…</div>`;

  const renderizadores = {
    usuarios: _renderSecaoUsuarios,
    emails:   _renderSecaoEmails,
    sla:      _renderSecaoSLA,
    setores:  _renderSecaoSetores,
    listas:   _renderSecaoListas,
    gatilhos: _renderSecaoGatilhos
  };
  if (renderizadores[secao]) renderizadores[secao](area);
}

// ─────────────────────────────────────────────────────────
// SEÇÃO 1 — USUÁRIOS
// ─────────────────────────────────────────────────────────
function _renderSecaoUsuarios(area) {
  google.script.run
    .withSuccessHandler(usuarios => {
      const linhas = (usuarios || []).map(u => {
        const ativo = u.ativo === 'SIM';
        return `<tr class="border-b border-gray-100 hover:bg-gray-50 text-sm">
          <td class="px-4 py-3">
            <p class="font-semibold text-gray-800">${escapeHtml(u.nome)}</p>
            <p class="text-xs text-gray-400">${escapeHtml(u.email)}</p>
          </td>
          <td class="px-4 py-3">
            <span class="${u.perfil === 'ADMIN' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'} text-[10px] font-bold px-2 py-0.5 rounded-full">
              ${escapeHtml(u.perfil)}
            </span>
          </td>
          <td class="px-4 py-3">
            <span class="${ativo ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'} text-[10px] font-bold px-2 py-0.5 rounded-full">
              ${ativo ? 'ATIVO' : 'INATIVO'}
            </span>
          </td>
          <td class="px-4 py-3">
            <div class="flex gap-2">
              <button onclick="_cfgResetSenha('${escapeHtml(u.email)}')"
                      class="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 font-semibold px-2.5 py-1.5 rounded-lg transition">
                <i class="fas fa-key mr-1"></i>Senha
              </button>
              <button onclick="_cfgAlterarStatus('${escapeHtml(u.email)}', ${!ativo})"
                      class="text-xs ${ativo ? 'bg-red-50 hover:bg-red-100 text-red-600' : 'bg-green-50 hover:bg-green-100 text-green-700'} font-semibold px-2.5 py-1.5 rounded-lg transition">
                <i class="fas ${ativo ? 'fa-user-slash' : 'fa-user-check'} mr-1"></i>${ativo ? 'Desativar' : 'Ativar'}
              </button>
            </div>
          </td>
        </tr>`;
      }).join('');

      area.innerHTML = `
        <div class="flex items-center justify-between mb-5">
          <h2 class="text-lg font-bold text-gray-800 flex items-center gap-2">
            <i class="fas fa-users text-teal-600"></i> Usuários do Sistema
          </h2>
          <button onclick="_cfgNovoUsuario()"
                  class="bg-teal-600 hover:bg-teal-700 text-white font-bold px-4 py-2 rounded-lg text-sm flex items-center gap-2 transition">
            <i class="fas fa-user-plus"></i> Novo Usuário
          </button>
        </div>
        <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <table class="w-full text-left">
            <thead class="bg-gray-50 border-b border-gray-200">
              <tr>
                <th class="px-4 py-3 text-xs font-bold text-gray-500 uppercase">Usuário</th>
                <th class="px-4 py-3 text-xs font-bold text-gray-500 uppercase">Perfil</th>
                <th class="px-4 py-3 text-xs font-bold text-gray-500 uppercase">Status</th>
                <th class="px-4 py-3 text-xs font-bold text-gray-500 uppercase">Ações</th>
              </tr>
            </thead>
            <tbody>${linhas || '<tr><td colspan="4" class="px-4 py-8 text-center text-gray-400 text-sm">Nenhum usuário cadastrado.</td></tr>'}</tbody>
          </table>
        </div>`;
    })
    .withFailureHandler(e => { area.innerHTML = _erroHtml(e.message); })
    .listarUsuarios(tokenSessao);
}

function _cfgNovoUsuario() {
  _cfgAbrirSubModal('Novo Usuário', `
    <div class="space-y-4">
      <div>
        <label class="block text-xs font-bold text-gray-600 mb-1">E-mail *</label>
        <input type="email" id="cfgNuEmail" placeholder="usuario@hrn.com"
               class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-teal-500 outline-none">
      </div>
      <div>
        <label class="block text-xs font-bold text-gray-600 mb-1">Nome completo *</label>
        <input type="text" id="cfgNuNome"
               class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-teal-500 outline-none">
      </div>
      <div>
        <label class="block text-xs font-bold text-gray-600 mb-1">Senha (mín. 8 caracteres) *</label>
        <input type="password" id="cfgNuSenha"
               class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-teal-500 outline-none">
      </div>
      <div>
        <label class="block text-xs font-bold text-gray-600 mb-1">Perfil *</label>
        <select id="cfgNuPerfil" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-teal-500 outline-none">
          <option value="FARMACEUTICO">Farmacêutico</option>
          <option value="ADMIN">Administrador</option>
        </select>
      </div>
    </div>`,
    'Criar Usuário', () => {
      const dados = {
        email:  document.getElementById('cfgNuEmail').value.trim(),
        nome:   document.getElementById('cfgNuNome').value.trim(),
        senha:  document.getElementById('cfgNuSenha').value.trim(),
        perfil: document.getElementById('cfgNuPerfil').value
      };
      if (!dados.email || !dados.nome || !dados.senha) { mostrarToast('Preencha todos os campos.', 'erro'); return; }
      if (dados.senha.length < 8) { mostrarToast('Senha deve ter ao menos 8 caracteres.', 'erro'); return; }
      google.script.run
        .withSuccessHandler(res => { mostrarToast(res.mensagem, res.sucesso ? 'sucesso' : 'erro'); if (res.sucesso) { _fecharSubModal(); _abrirSecaoConfig('usuarios'); } })
        .withFailureHandler(e => mostrarToast(e.message, 'erro'))
        .criarUsuario(dados, tokenSessao);
    });
}

function _cfgResetSenha(email) {
  _cfgAbrirSubModal('Redefinir Senha', `
    <p class="text-xs text-gray-400 mb-4">${escapeHtml(email)}</p>
    <div>
      <label class="block text-xs font-bold text-gray-600 mb-1">Nova senha (mín. 8 caracteres) *</label>
      <input type="password" id="cfgRsSenha"
             class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-teal-500 outline-none">
    </div>`,
    'Salvar', () => {
      const senha = document.getElementById('cfgRsSenha').value.trim();
      if (senha.length < 8) { mostrarToast('Senha deve ter ao menos 8 caracteres.', 'erro'); return; }
      google.script.run
        .withSuccessHandler(res => { mostrarToast(res.mensagem, res.sucesso ? 'sucesso' : 'erro'); if (res.sucesso) _fecharSubModal(); })
        .withFailureHandler(e => mostrarToast(e.message, 'erro'))
        .trocarSenhaUsuario(email, senha, tokenSessao);
    });
}

function _cfgAlterarStatus(email, novoAtivo) {
  if (!confirm(`Confirma ${novoAtivo ? 'ativar' : 'desativar'} o usuário ${email}?`)) return;
  google.script.run
    .withSuccessHandler(res => { mostrarToast(res.mensagem, res.sucesso ? 'sucesso' : 'erro'); if (res.sucesso) _abrirSecaoConfig('usuarios'); })
    .withFailureHandler(e => mostrarToast(e.message, 'erro'))
    .alterarStatusUsuario(email, novoAtivo, tokenSessao);
}

// ─────────────────────────────────────────────────────────
// SEÇÃO 2 — E-MAILS
// ─────────────────────────────────────────────────────────
function _renderSecaoEmails(area) {
  google.script.run
    .withSuccessHandler(cfg => {
      const geral = cfg.geral || {};
      area.innerHTML = `
        <h2 class="text-lg font-bold text-gray-800 flex items-center gap-2 mb-5">
          <i class="fas fa-envelope text-teal-600"></i> E-mails de Alerta
        </h2>
        <div class="space-y-4 max-w-xl">
          <div class="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <label class="block text-xs font-bold text-gray-600 mb-1">E-mail da Coordenação</label>
            <p class="text-[10px] text-gray-400 mb-2">Destinatário dos alertas de SLA vencido e notificações críticas.</p>
            <input type="email" id="cfgEmailCoord" value="${escapeHtml(geral.EMAIL_COORDENACAO || '')}"
                   class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-teal-500 outline-none">
          </div>
          <div class="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <label class="block text-xs font-bold text-gray-600 mb-1">Alertas Ativos</label>
            <p class="text-[10px] text-gray-400 mb-2">Ativar/desativar o envio de todos os e-mails automáticos.</p>
            <select id="cfgAlertasAtivos" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-teal-500 outline-none">
              <option value="SIM" ${geral.ALERTAS_ATIVOS === 'SIM' ? 'selected' : ''}>Ativados</option>
              <option value="NAO" ${geral.ALERTAS_ATIVOS === 'NAO' ? 'selected' : ''}>Desativados</option>
            </select>
          </div>
          <button onclick="_cfgSalvarEmails()"
                  class="bg-teal-600 hover:bg-teal-700 text-white font-bold px-5 py-2.5 rounded-lg text-sm flex items-center gap-2 transition">
            <i class="fas fa-save"></i> Salvar Configurações de E-mail
          </button>
        </div>`;
    })
    .withFailureHandler(e => { area.innerHTML = _erroHtml(e.message); })
    .getConfig();
}

function _cfgSalvarEmails() {
  const dados = {
    EMAIL_COORDENACAO: document.getElementById('cfgEmailCoord').value.trim(),
    ALERTAS_ATIVOS:    document.getElementById('cfgAlertasAtivos').value
  };
  google.script.run
    .withSuccessHandler(res => { mostrarToast(res.mensagem, res.sucesso ? 'sucesso' : 'erro'); if (res.sucesso) invalidarConfigCache(); })
    .withFailureHandler(e => mostrarToast(e.message, 'erro'))
    .salvarConfigGeral(dados, tokenSessao);
}

// ─────────────────────────────────────────────────────────
// SEÇÃO 3 — SLA
// ─────────────────────────────────────────────────────────
function _renderSecaoSLA(area) {
  google.script.run
    .withSuccessHandler(cfg => {
      const sla = (cfg.geral || {}).SLA_PADRAO_HORAS || '48';
      area.innerHTML = `
        <h2 class="text-lg font-bold text-gray-800 flex items-center gap-2 mb-5">
          <i class="fas fa-clock text-teal-600"></i> Configuração de SLA
        </h2>
        <div class="max-w-sm space-y-4">
          <div class="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <label class="block text-xs font-bold text-gray-600 mb-1">Prazo padrão (horas)</label>
            <p class="text-[10px] text-gray-400 mb-3">Tempo máximo para investigação após o evento. Padrão: 48h.</p>
            <div class="flex items-center gap-3">
              <input type="number" id="cfgSlaHoras" value="${escapeHtml(sla)}" min="1" max="720"
                     class="w-28 border border-gray-300 rounded-lg px-3 py-2 text-sm text-center font-bold focus:ring-2 focus:ring-teal-500 outline-none">
              <span class="text-sm text-gray-500">horas</span>
            </div>
            <div class="mt-3 flex gap-2 flex-wrap">
              ${[24, 48, 72, 120].map(h => `<button onclick="document.getElementById('cfgSlaHoras').value=${h}"
                class="text-xs bg-gray-100 hover:bg-teal-100 hover:text-teal-700 text-gray-600 font-semibold px-3 py-1.5 rounded-lg transition">${h}h</button>`).join('')}
            </div>
          </div>
          <button onclick="_cfgSalvarSLA()"
                  class="bg-teal-600 hover:bg-teal-700 text-white font-bold px-5 py-2.5 rounded-lg text-sm flex items-center gap-2 transition">
            <i class="fas fa-save"></i> Salvar SLA
          </button>
        </div>`;
    })
    .withFailureHandler(e => { area.innerHTML = _erroHtml(e.message); })
    .getConfig();
}

function _cfgSalvarSLA() {
  const horas = parseInt(document.getElementById('cfgSlaHoras').value || '48', 10);
  if (isNaN(horas) || horas < 1) { mostrarToast('Informe um valor válido em horas.', 'erro'); return; }
  google.script.run
    .withSuccessHandler(res => { mostrarToast(res.mensagem, res.sucesso ? 'sucesso' : 'erro'); if (res.sucesso) { SLA_PADRAO_HORAS = horas; invalidarConfigCache(); } })
    .withFailureHandler(e => mostrarToast(e.message, 'erro'))
    .salvarConfigGeral({ SLA_PADRAO_HORAS: String(horas) }, tokenSessao);
}

// ─────────────────────────────────────────────────────────
// SEÇÃO 4 — SETORES
// ─────────────────────────────────────────────────────────
function _renderSecaoSetores(area) {
  google.script.run
    .withSuccessHandler(cfg => {
      const setores = (cfg.setores || []).sort((a, b) => a.setor.localeCompare(b.setor));
      const linhas = setores.map((s, i) => `
        <tr class="border-b border-gray-100 hover:bg-gray-50 text-sm" id="setorLinha_${i}">
          <td class="px-4 py-2.5">
            <input type="text" value="${escapeHtml(s.setor)}" data-campo="setor" data-idx="${i}"
                   class="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-teal-400 outline-none bg-transparent hover:bg-white">
          </td>
          <td class="px-4 py-2.5">
            <input type="text" value="${escapeHtml(s.farmaceutico)}" data-campo="farmaceutico" data-idx="${i}"
                   class="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-teal-400 outline-none bg-transparent hover:bg-white">
          </td>
          <td class="px-4 py-2.5">
            <input type="email" value="${escapeHtml(s.email)}" data-campo="email" data-idx="${i}"
                   class="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-teal-400 outline-none bg-transparent hover:bg-white">
          </td>
          <td class="px-4 py-2.5 text-center">
            <button onclick="_cfgRemoverSetor(${i})"
                    class="text-red-400 hover:text-red-600 transition text-xs">
              <i class="fas fa-trash"></i>
            </button>
          </td>
        </tr>`).join('');

      area.innerHTML = `
        <div class="flex items-center justify-between mb-5">
          <h2 class="text-lg font-bold text-gray-800 flex items-center gap-2">
            <i class="fas fa-hospital text-teal-600"></i> Setores e Responsáveis
          </h2>
          <button onclick="_cfgAdicionarSetor()"
                  class="bg-teal-600 hover:bg-teal-700 text-white font-bold px-4 py-2 rounded-lg text-sm flex items-center gap-2 transition">
            <i class="fas fa-plus"></i> Adicionar Setor
          </button>
        </div>
        <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden mb-4">
          <table class="w-full text-left" id="tabelaSetores">
            <thead class="bg-gray-50 border-b">
              <tr>
                <th class="px-4 py-3 text-xs font-bold text-gray-500 uppercase">Setor</th>
                <th class="px-4 py-3 text-xs font-bold text-gray-500 uppercase">Farmacêutico Responsável</th>
                <th class="px-4 py-3 text-xs font-bold text-gray-500 uppercase">E-mail</th>
                <th class="px-4 py-3 text-xs font-bold text-gray-500 uppercase w-10"></th>
              </tr>
            </thead>
            <tbody id="setoresBody">${linhas}</tbody>
          </table>
        </div>
        <button onclick="_cfgSalvarSetores()"
                class="bg-teal-600 hover:bg-teal-700 text-white font-bold px-5 py-2.5 rounded-lg text-sm flex items-center gap-2 transition">
          <i class="fas fa-save"></i> Salvar Setores
        </button>`;
    })
    .withFailureHandler(e => { area.innerHTML = _erroHtml(e.message); })
    .getConfig();
}

function _cfgAdicionarSetor() {
  const tbody = document.getElementById('setoresBody');
  if (!tbody) return;
  const i = tbody.rows.length;
  const tr = document.createElement('tr');
  tr.className = 'border-b border-gray-100 hover:bg-gray-50 text-sm';
  tr.id = 'setorLinha_' + i;
  tr.innerHTML = `
    <td class="px-4 py-2.5"><input type="text" data-campo="setor" data-idx="${i}" placeholder="NOME DO SETOR"
       class="w-full border border-teal-300 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-teal-400 outline-none bg-teal-50"></td>
    <td class="px-4 py-2.5"><input type="text" data-campo="farmaceutico" data-idx="${i}" placeholder="Nome do Farmacêutico"
       class="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-teal-400 outline-none bg-transparent hover:bg-white"></td>
    <td class="px-4 py-2.5"><input type="email" data-campo="email" data-idx="${i}" placeholder="email@hrn.com"
       class="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-teal-400 outline-none bg-transparent hover:bg-white"></td>
    <td class="px-4 py-2.5 text-center"><button onclick="this.closest('tr').remove()" class="text-red-400 hover:text-red-600 text-xs"><i class="fas fa-trash"></i></button></td>`;
  tbody.appendChild(tr);
  tr.querySelector('input').focus();
}

function _cfgRemoverSetor(idx) {
  const linha = document.getElementById('setorLinha_' + idx);
  if (linha) linha.remove();
}

function _cfgSalvarSetores() {
  const tbody = document.getElementById('setoresBody');
  if (!tbody) return;
  const setores = [];
  tbody.querySelectorAll('tr').forEach(tr => {
    const campos = {};
    tr.querySelectorAll('input[data-campo]').forEach(inp => { campos[inp.dataset.campo] = inp.value.trim(); });
    if (campos.setor) setores.push(campos);
  });
  if (!setores.length) { mostrarToast('Adicione ao menos um setor.', 'erro'); return; }
  google.script.run
    .withSuccessHandler(res => { mostrarToast(res.mensagem, res.sucesso ? 'sucesso' : 'erro'); if (res.sucesso) invalidarConfigCache(); })
    .withFailureHandler(e => mostrarToast(e.message, 'erro'))
    .salvarSetores(setores, tokenSessao);
}

// ─────────────────────────────────────────────────────────
// SEÇÃO 5 — LISTAS / DROPDOWNS
// ─────────────────────────────────────────────────────────
const _CAMPOS_LISTA = {
  gravidade:       'Gravidade',
  desfecho:        'Desfecho',
  conclusao:       'Conclusão',
  motivo_descarte: 'Motivo de Descarte',
  readministrado:  'Readministrado?',
  evolucao:        'Evolução Pós Condutas'
};

function _renderSecaoListas(area) {
  google.script.run
    .withSuccessHandler(cfg => {
      const listas = cfg.listas || {};
      const blocos = Object.entries(_CAMPOS_LISTA).map(([campo, label]) => {
        const itens = (listas[campo] || []).map((op, i) =>
          `<div class="flex items-center gap-2 mb-1.5" id="listaItem_${campo}_${i}">
            <input type="text" value="${escapeHtml(op)}" data-lista="${campo}" data-idx="${i}"
                   class="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:ring-1 focus:ring-teal-400 outline-none">
            <button onclick="document.getElementById('listaItem_${campo}_${i}').remove()"
                    class="text-red-400 hover:text-red-600 transition flex-shrink-0">
              <i class="fas fa-times text-xs"></i>
            </button>
          </div>`).join('');
        return `
          <div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4" id="blocoLista_${campo}">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-bold text-gray-700">${label}</h3>
              <button onclick="_cfgAdicionarItemLista('${campo}')"
                      class="text-xs text-teal-600 hover:text-teal-800 font-semibold flex items-center gap-1">
                <i class="fas fa-plus"></i> Adicionar
              </button>
            </div>
            <div id="listaItens_${campo}">${itens}</div>
          </div>`;
      }).join('');

      area.innerHTML = `
        <div class="flex items-center justify-between mb-5">
          <h2 class="text-lg font-bold text-gray-800 flex items-center gap-2">
            <i class="fas fa-list text-teal-600"></i> Listas e Dropdowns
          </h2>
          <button onclick="_cfgSalvarListas()"
                  class="bg-teal-600 hover:bg-teal-700 text-white font-bold px-4 py-2 rounded-lg text-sm flex items-center gap-2 transition">
            <i class="fas fa-save"></i> Salvar Todas
          </button>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">${blocos}</div>`;
    })
    .withFailureHandler(e => { area.innerHTML = _erroHtml(e.message); })
    .getConfig();
}

function _cfgAdicionarItemLista(campo) {
  const container = document.getElementById('listaItens_' + campo);
  if (!container) return;
  const idx = container.querySelectorAll('[data-lista]').length;
  const div = document.createElement('div');
  div.className = 'flex items-center gap-2 mb-1.5';
  div.innerHTML = `
    <input type="text" data-lista="${campo}" data-idx="${idx}" placeholder="Nova opção…"
           class="flex-1 border border-teal-300 rounded-lg px-3 py-1.5 text-xs focus:ring-1 focus:ring-teal-400 outline-none bg-teal-50">
    <button onclick="this.parentElement.remove()" class="text-red-400 hover:text-red-600 flex-shrink-0">
      <i class="fas fa-times text-xs"></i>
    </button>`;
  container.appendChild(div);
  div.querySelector('input').focus();
}

function _cfgSalvarListas() {
  const listas = {};
  Object.keys(_CAMPOS_LISTA).forEach(campo => {
    const container = document.getElementById('listaItens_' + campo);
    if (!container) return;
    listas[campo] = Array.from(container.querySelectorAll('input[data-lista]'))
      .map(inp => inp.value.trim()).filter(Boolean);
  });
  google.script.run
    .withSuccessHandler(res => { mostrarToast(res.mensagem, res.sucesso ? 'sucesso' : 'erro'); if (res.sucesso) invalidarConfigCache(); })
    .withFailureHandler(e => mostrarToast(e.message, 'erro'))
    .salvarListas(listas, tokenSessao);
}

// ─────────────────────────────────────────────────────────
// SEÇÃO 6 — GATILHOS
// ─────────────────────────────────────────────────────────
function _renderSecaoGatilhos(area) {
  google.script.run
    .withSuccessHandler(gatilhos => {
      const itens = (gatilhos || []).map((g, i) => `
        <div class="flex items-center gap-2 mb-2" id="gatilhoItem_${i}">
          <input type="text" value="${escapeHtml(g.medicamento || g)}" data-idx="${i}"
                 class="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm uppercase focus:ring-1 focus:ring-teal-400 outline-none">
          <button onclick="document.getElementById('gatilhoItem_${i}').remove()"
                  class="text-red-400 hover:text-red-600 transition flex-shrink-0">
            <i class="fas fa-trash text-sm"></i>
          </button>
        </div>`).join('');

      area.innerHTML = `
        <div class="flex items-center justify-between mb-5">
          <h2 class="text-lg font-bold text-gray-800 flex items-center gap-2">
            <i class="fas fa-pills text-teal-600"></i> Medicamentos Gatilho (Trigger Tools)
          </h2>
          <button onclick="_cfgAdicionarGatilho()"
                  class="bg-teal-600 hover:bg-teal-700 text-white font-bold px-4 py-2 rounded-lg text-sm flex items-center gap-2 transition">
            <i class="fas fa-plus"></i> Adicionar
          </button>
        </div>
        <p class="text-xs text-gray-400 mb-4">Medicamentos monitorados pelo ETL. Alterações refletem na próxima execução do pipeline.</p>
        <div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4 mb-4">
          <div id="gatilhosContainer">${itens || '<p class="text-sm text-gray-400 text-center py-4">Nenhum gatilho cadastrado.</p>'}</div>
        </div>
        <button onclick="_cfgSalvarGatilhos()"
                class="bg-teal-600 hover:bg-teal-700 text-white font-bold px-5 py-2.5 rounded-lg text-sm flex items-center gap-2 transition">
          <i class="fas fa-save"></i> Salvar Gatilhos
        </button>`;
    })
    .withFailureHandler(e => { area.innerHTML = _erroHtml(e.message); })
    .listarGatilhos(tokenSessao);
}

function _cfgAdicionarGatilho() {
  const container = document.getElementById('gatilhosContainer');
  if (!container) return;
  const idx = container.querySelectorAll('[data-idx]').length;
  const div = document.createElement('div');
  div.className = 'flex items-center gap-2 mb-2';
  div.innerHTML = `
    <input type="text" data-idx="${idx}" placeholder="NOME DO MEDICAMENTO" style="text-transform:uppercase"
           class="flex-1 border border-teal-300 rounded-lg px-3 py-2 text-sm uppercase focus:ring-1 focus:ring-teal-400 outline-none bg-teal-50">
    <button onclick="this.parentElement.remove()" class="text-red-400 hover:text-red-600 flex-shrink-0">
      <i class="fas fa-trash text-sm"></i>
    </button>`;
  container.appendChild(div);
  div.querySelector('input').focus();
}

function _cfgSalvarGatilhos() {
  const container = document.getElementById('gatilhosContainer');
  if (!container) return;
  const gatilhos = Array.from(container.querySelectorAll('input[data-idx]'))
    .map(inp => inp.value.trim().toUpperCase()).filter(Boolean);
  google.script.run
    .withSuccessHandler(res => { mostrarToast(res.mensagem, res.sucesso ? 'sucesso' : 'erro'); })
    .withFailureHandler(e => mostrarToast(e.message, 'erro'))
    .salvarGatilhos(gatilhos, tokenSessao);
}

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────
function _erroHtml(msg) {
  return `<div class="flex flex-col items-center justify-center h-40 text-red-400">
    <i class="fas fa-exclamation-triangle text-2xl mb-2"></i>
    <p class="text-sm">${escapeHtml(msg)}</p>
  </div>`;
}

/** Invalida o cache de config no servidor para refletir edições imediatamente. */
function invalidarConfigCache() {
  google.script.run.invalidarConfig();
}

/** Sub-modal reutilizável para formulários pequenos dentro do modal de config. */
function _cfgAbrirSubModal(titulo, conteudo, labelBtn, onConfirmar) {
  const anterior = document.getElementById('cfgSubModal');
  if (anterior) anterior.remove();
  const div = document.createElement('div');
  div.id = 'cfgSubModal';
  div.className = 'absolute inset-0 bg-black/50 flex items-center justify-center z-10 rounded-2xl';
  div.innerHTML = `
    <div class="bg-white rounded-xl shadow-2xl w-full max-w-sm mx-4 p-6">
      <h3 class="text-base font-bold text-gray-800 mb-4 border-b pb-3">${escapeHtml(titulo)}</h3>
      <div class="mb-5">${conteudo}</div>
      <div class="flex justify-end gap-3">
        <button onclick="_fecharSubModal()"
                class="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg font-semibold text-sm hover:bg-gray-200 transition">
          Cancelar
        </button>
        <button id="cfgSubModalBtn"
                class="px-4 py-2 bg-teal-600 text-white rounded-lg font-semibold text-sm hover:bg-teal-700 transition">
          ${escapeHtml(labelBtn)}
        </button>
      </div>
    </div>`;
  document.getElementById('modalConfig').querySelector('.rounded-2xl').style.position = 'relative';
  document.getElementById('modalConfig').querySelector('.rounded-2xl').appendChild(div);
  document.getElementById('cfgSubModalBtn').onclick = onConfirmar;
}

function _fecharSubModal() {
  const sub = document.getElementById('cfgSubModal');
  if (sub) sub.remove();
}
</script>
```

---

## 📄 Arquivo [16/32]: js_core.html

```html
<script>
// =========================================================
// js_core.html — v2.5
//
// NOVIDADE v2.5 (UX navbar):
//   _exibirNomeUsuario() agora popula avatar circular com
//   iniciais (#avatarUsuario) + tooltip desktop (#tooltipUsuario)
//   + popover mobile (#popoverUsuario), no lugar do nome por
//   extenso fixo na navbar. _gerarIniciais() extrai primeira +
//   última palavra do nome, ignorando preposições curtas
//   (de/da/do/dos/das). btnAtualizar (Sincronizar) passa a ser
//   ícone-only — texto "Sincronizando..." sai do innerHTML nos
//   3 pontos de troca de estado (loading/sucesso/erro).
//
// NOVIDADE v2.4 (P1.2 — atualização otimista local):
//   atualizarCasoLocal(casoAtualizado) — merge de um único caso em
//   casosGlobais + re-render local, sem round-trip completo ao servidor.
//   Usada por js_triagem.html e js_investigacao.html após uma escrita
//   pontual bem-sucedida, no lugar de carregarCasos().
//
// CORREÇÕES ANTERIORES (v2.3):
//   FIX-SESSAO-1/2/3/4 — ver histórico de versões anteriores.
//
// Responsabilidade: estado global, constantes compartilhadas,
// funções de infraestrutura (escapeHtml, SLA, carregamento),
// controle de abas e mapa setor → farmacêutico responsável.
// =========================================================

// ---------------------------------------------------------
// STATUS — espelha SCHEMA.STATUS (Schema.gs) — fonte única da verdade
// ---------------------------------------------------------
const STATUS = {
  TRIAGEM:     "PENDENTE TRIAGEM",
  INVESTIGACAO:"EM INVESTIGAÇÃO",
  CONCLUIDO:   "CONCLUÍDO",
  DESCARTADO:  "DESCARTADO"
};
const ST = STATUS;

// ---------------------------------------------------------
// CONSTANTES DE NEGÓCIO
// ---------------------------------------------------------
let SLA_PADRAO_HORAS = 48;
const CARDS_POR_PAGINA = 15;

// ---------------------------------------------------------
// ESTADO GLOBAL
// ---------------------------------------------------------
let casosGlobais         = [];
let delegacaoConfigurada = false;
let configGlobal         = null;

const paginaAtual = { triagem: 1, investigacao: 1, concluidos: 1 };
const casosFiltrados = { triagem: [], investigacao: [], concluidos: [] };

let mapaSetorResponsavel = {};
let listaCanonicaFarmas  = [];
let tokenSessao          = null;

// ---------------------------------------------------------
// SEGURANÇA: ESCAPE XSS (P0)
// ---------------------------------------------------------
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

// ---------------------------------------------------------
// FORMATAÇÃO CENTRAL DE DATA — EXIBIÇÃO (dd/MM/yyyy HH:mm)
// Hora só aparece se existir na origem — sem inventar 00:00.
//
// Fonte de dados é heterogênea por origem: ETL/BA grava
// "dd/MM/yyyy HH:mm:ss", formulários DE gravam "yyyy-MM-dd"
// (input type=date) e o Firestore pode devolver ISO completo.
// TODA exibição de data no frontend passa por aqui — NUNCA
// formatar espalhado no ponto de render.
//
// ESCOPO: só camada de EXIBIÇÃO. Não usar para:
//   - inputs type=date (browser exige yyyy-MM-dd);
//   - valores enviados ao backend (formato de armazenamento
//     não muda);
//   - E2B (YYYYMMDD ICH, boundary protegido em E2b.gs).
// ---------------------------------------------------------
function formatarDataExibicao(valor) {
  const v = String(valor == null ? '' : valor).trim();
  if (!v || v === 'N/I' || v === '-') return '';

  // dd/MM/yyyy [HH:mm[:ss]] → mantém data, anexa HH:mm se existir na origem.
  const br = v.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2}))?/);
  if (br) return br[1] + '/' + br[2] + '/' + br[3] + (br[4] ? ' ' + br[4] + ':' + br[5] : '');

  // yyyy-MM-dd [THH:mm | " HH:mm"] → inverte, anexa HH:mm se existir.
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (iso) return iso[3] + '/' + iso[2] + '/' + iso[1] + (iso[4] ? ' ' + iso[4] + ':' + iso[5] : '');

  // Fallback: qualquer coisa que o Date parseie.
  const d = new Date(v);
  if (!isNaN(d)) {
    const p = n => String(n).padStart(2, '0');
    const base = p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
    const temHora = d.getHours() || d.getMinutes() || d.getSeconds();
    return temHora ? base + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) : base;
  }

  return v; // não reconhecido → devolve cru, sem esconder dado
}

// ---------------------------------------------------------
// CONVERSÃO PARA INPUTS type="datetime-local"
// value exigido pelo browser: "yyyy-MM-ddTHH:mm".
// Aceita os formatos armazenados (com/sem hora, BR/ISO, "T" ou espaço).
// Legado só-data ganha T00:00 — necessário pro input aceitar o valor;
// a hora só persiste se o usuário salvar de novo.
// ---------------------------------------------------------
function paraInputDateTimeLocal(valor) {
  const v = String(valor == null ? '' : valor).trim();
  if (!v || v === 'N/I' || v === '-') return '';

  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3] + 'T' + (iso[4] || '00') + ':' + (iso[5] || '00');

  const br = v.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2}))?/);
  if (br) return br[3] + '-' + br[2] + '-' + br[1] + 'T' + (br[4] || '00') + ':' + (br[5] || '00');

  return '';
}

/** Agora local em "yyyy-MM-ddTHH:mm" — pré-preenchimento de datetime-local.
 *  NÃO usar toISOString(): é UTC e vira o dia às 21h locais (UTC-3). */
function agoraInputDateTimeLocal() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
         'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}


// ---------------------------------------------------------
// INICIALIZAÇÃO E AUTENTICAÇÃO
// ---------------------------------------------------------
function _mostrarLogin() {
  document.getElementById('view-login').classList.remove('hidden');
  document.getElementById('view-login').classList.add('flex');
  document.getElementById('app-container').classList.add('hidden');
  document.getElementById('app-container').classList.remove('flex');
}

function inicializar() {
  tokenSessao = sessionStorage.getItem('vigi_token');

  if (!tokenSessao) {
    _mostrarLogin();
    return;
  }

  google.script.run
    .withSuccessHandler(function(valido) {
      if (valido) {
        const nomeGuardado = sessionStorage.getItem('vigi_nome');
        if (nomeGuardado) _exibirNomeUsuario(nomeGuardado);
        iniciarAppSeguro();
      } else {
        sessionStorage.removeItem('vigi_token');
        sessionStorage.removeItem('vigi_nome');
        sessionStorage.removeItem('vigi_perfil');
        tokenSessao = null;
        _mostrarLogin();
      }
    })
    .withFailureHandler(function() {
      sessionStorage.removeItem('vigi_token');
      sessionStorage.removeItem('vigi_nome');
      sessionStorage.removeItem('vigi_perfil');
      tokenSessao = null;
      _mostrarLogin();
    })
    .validarSessao(tokenSessao); // FIX: funções com sufixo "_" não são
                                 // invocáveis via google.script.run — a chamada
                                 // antiga caía sempre no failure handler e
                                 // deslogava o usuário a cada reload.
}

function iniciarAppSeguro() {
  document.getElementById('view-login').classList.add('hidden');
  document.getElementById('view-login').classList.remove('flex');

  const containerApp = document.getElementById('app-container');
  containerApp.classList.remove('hidden');
  containerApp.classList.add('flex');
  _configurarAbaAdmin();
  construirNaranjo();
  carregarConfig();
}

function _configurarAbaAdmin() {
  const perfil = sessionStorage.getItem('vigi_perfil') || '';
  const btnAdmin = document.getElementById('btnAbaAdmin');
  if (btnAdmin) btnAdmin.classList.toggle('hidden', perfil !== 'ADMIN');
}

function realizarLogin(event) {
  event.preventDefault();
  const email = document.getElementById('loginEmail').value;
  const senha  = document.getElementById('loginSenha').value;
  const btn    = document.getElementById('btnLogin');

  const originalHtml = btn.innerHTML;
  btn.innerHTML  = '<i class="fas fa-circle-notch fa-spin"></i>';
  btn.disabled   = true;

  google.script.run
    .withSuccessHandler(res => {
      if (res.sucesso) {
        sessionStorage.setItem('vigi_token', res.token);
        sessionStorage.setItem('vigi_nome', res.nome);
        sessionStorage.setItem('vigi_perfil', res.perfil || 'FARMACEUTICO');
        tokenSessao = res.token;
        _exibirNomeUsuario(res.nome || '');
        mostrarToast('Bem-vindo(a), ' + res.nome, 'sucesso');
        iniciarAppSeguro();
      } else {
        mostrarToast(res.erro, 'erro');
        btn.innerHTML = originalHtml;
        btn.disabled  = false;
      }
    })
    .withFailureHandler(() => {
      mostrarToast('Falha na comunicação com o servidor.', 'erro');
      btn.innerHTML = originalHtml;
      btn.disabled  = false;
    })
    .autenticarUsuario(email, senha);
}

// ---------------------------------------------------------
// AVATAR DO USUÁRIO — bolinha com iniciais + tooltip/popover
// com nome completo (substitui nome por extenso fixo na navbar)
// ---------------------------------------------------------
function _gerarIniciais(nome) {
  const partes = String(nome || '').trim().split(/\s+/).filter(p =>
    p.length > 2 || !/^(de|da|do|dos|das)$/i.test(p)
  );
  if (partes.length === 0) return '?';
  if (partes.length === 1) return partes[0].substring(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

function _exibirNomeUsuario(nome) {
  if (!nome) return;
  const avatar  = document.getElementById('avatarUsuario');
  const lbl     = document.getElementById('lblUsuarioLogado');
  const tooltip = document.getElementById('tooltipUsuario');
  if (avatar)  avatar.textContent  = _gerarIniciais(nome);
  if (lbl)     lbl.textContent     = nome;
  if (tooltip) tooltip.textContent = nome;
}

function _posicionarTooltip(el, tooltip) {
  const r = el.getBoundingClientRect();
  tooltip.style.top   = (r.bottom + 8) + 'px';
  tooltip.style.left  = 'auto';
  tooltip.style.right = (window.innerWidth - r.right) + 'px';
}

function _mostrarTooltipUsuario() {
  // Desktop: hover. Em telas touch (sem hover real) o navegador não dispara
  // mouseenter, então isso não conflita com o toggle por clique no mobile.
  const avatar  = document.getElementById('avatarUsuario');
  const tooltip = document.getElementById('tooltipUsuario');
  if (!avatar || !tooltip) return;
  _posicionarTooltip(avatar, tooltip);
  tooltip.classList.remove('hidden');
}

function _esconderTooltipUsuario() {
  const tooltip = document.getElementById('tooltipUsuario');
  if (tooltip) tooltip.classList.add('hidden');
}

function _toggleTooltipUsuario() {
  // Mobile/click: toggle explícito, reaproveita mesmo posicionamento.
  const avatar  = document.getElementById('avatarUsuario');
  const tooltip = document.getElementById('tooltipUsuario');
  if (!avatar || !tooltip) return;
  const estaEscondido = tooltip.classList.contains('hidden');
  if (estaEscondido) {
    _posicionarTooltip(avatar, tooltip);
    tooltip.classList.remove('hidden');
  } else {
    tooltip.classList.add('hidden');
  }
}

function fazerLogout() {
  const t = tokenSessao || sessionStorage.getItem('vigi_token');

  sessionStorage.removeItem('vigi_token');
  sessionStorage.removeItem('vigi_nome');
  sessionStorage.removeItem('vigi_perfil');
  tokenSessao = null;

  const _recarregar = () => window.location.reload();

  if (t && window.google && google.script && google.script.run) {
    google.script.run
      .withSuccessHandler(_recarregar)
      .withFailureHandler(_recarregar)
      .encerrarSessao(t);
  } else {
    _recarregar();
  }
}

// ---------------------------------------------------------
// CARREGAMENTO DE CONFIGURAÇÃO
// ---------------------------------------------------------
function carregarConfig() {
  google.script.run
    .withSuccessHandler(cfg => {
      aplicarConfig(cfg);
      carregarCasos();
    })
    .withFailureHandler(e => {
      console.warn('getConfig falhou:', e.message);
      carregarCasos();
    })
    .getConfig();
}

function aplicarConfig(cfg) {
  configGlobal = cfg;

  mapaSetorResponsavel = {};
  listaCanonicaFarmas  = [];
  const setores  = (cfg && cfg.setores) ? cfg.setores : [];
  const farmaSet = new Set();

  setores.forEach(s => {
    if (!s.setor) return;
    const chave = s.setor.toUpperCase().trim();
    mapaSetorResponsavel[chave] = {
      farmaceutico: (s.farmaceutico || '').trim(),
      email:        (s.email        || '').trim()
    };
    if (s.farmaceutico && s.farmaceutico.trim()) {
      farmaSet.add(s.farmaceutico.trim());
    }
  });
  listaCanonicaFarmas = [...farmaSet].sort();
  _popularFiltroFarmaceutico();

  if (cfg && cfg.geral && cfg.geral.SLA_PADRAO_HORAS) {
    SLA_PADRAO_HORAS = Number(cfg.geral.SLA_PADRAO_HORAS) || 48;
  }

  if (cfg && cfg.listas) {
    _popularSelect('invReadministrado', cfg.listas.readministrado);
    _popularSelect('invEvolucao',       cfg.listas.evolucao);
    _popularSelect('invGravidade',      cfg.listas.gravidade);
    _popularSelect('invDesfecho',       cfg.listas.desfecho);
    _popularSelect('invConclusao',      cfg.listas.conclusao);
    _popularSelect('trgMotivoDescarte', cfg.listas.motivo_descarte);
  }
}

function _popularSelect(id, lista) {
  const el = document.getElementById(id);
  if (!el || !Array.isArray(lista)) return;
  const atual = el.value;
  el.innerHTML = '<option value="">Selecione…</option>';
  lista.forEach(opt => {
    el.innerHTML += `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`;
  });
  if (lista.includes(atual)) el.value = atual;
}

// ---------------------------------------------------------
// HELPER — farmacêutico canônico de um setor
// ---------------------------------------------------------
function getFarmaceuticoPorSetor(setor) {
  if (!setor) return '';
  const resp = mapaSetorResponsavel[setor.toUpperCase().trim()];
  return resp ? resp.farmaceutico : '';
}

function _popularFiltroFarmaceutico() {
  const select   = document.getElementById('filtroFarmaceutico');
  if (!select) return;
  const anterior = select.value;
  select.innerHTML = '<option value="TODOS">Todos os Farmacêuticos</option>';
  listaCanonicaFarmas.forEach(f => {
    select.innerHTML += `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`;
  });
  if (listaCanonicaFarmas.includes(anterior)) select.value = anterior;
}

// ---------------------------------------------------------
// CONTROLE DE ABAS
// ---------------------------------------------------------
function alternarAba(aba) {
  ['kanban','dashboard','admin'].forEach(function(v) {
    const el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('hidden', aba !== v);
  });

  const barraFiltros = document.getElementById('barraFiltros');
  if (barraFiltros) barraFiltros.classList.toggle('hidden', aba === 'admin');

  document.getElementById('btnAbaKanban').className =
    'px-5 py-3 rounded-t-lg font-bold text-sm transition ' +
    (aba === 'kanban' ? 'aba-ativa' : 'aba-inativa');

  document.getElementById('btnAbaDash').className =
    'px-5 py-3 rounded-t-lg font-bold text-sm transition ' +
    (aba === 'dashboard' ? 'aba-ativa' : 'aba-inativa');

  const btnAdmin = document.getElementById('btnAbaAdmin');
  if (btnAdmin) btnAdmin.className =
    'px-5 py-3 rounded-t-lg font-bold text-sm transition ' +
    (aba === 'admin' ? 'aba-ativa' : 'aba-inativa');

  if (aba === 'dashboard') desenharGraficos();
  if (aba === 'admin') carregarUsuarios();
}

// ---------------------------------------------------------
// CARREGAMENTO DE DADOS PROTEGIDO (sincronização completa)
// Usado apenas no login e no botão manual "Sincronizar" — ações
// pontuais de escrita agora usam atualizarCasoLocal() (ver abaixo).
//
// btnAtualizar é ícone-only (ver navbar em index.html): loading
// usa fa-spin no próprio ícone, sem texto "Sincronizando...".
// ---------------------------------------------------------
function carregarCasos() {
  const btn = document.getElementById('btnAtualizar');
  if (btn) btn.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i>';

  mostrarSkeletons();

  google.script.run
    .withSuccessHandler(processarDados)
    .withFailureHandler(e => {
      limparSkeletons();
      const msg = (e && e.message) ? e.message : String(e);
      console.error('[carregarCasos] Falha:', msg);

      const ehSessaoExpirada =
        msg.includes('Sessão expirada') ||
        msg.includes('não autorizada')  ||
        msg.includes('consolidar base Kanban');

      if (ehSessaoExpirada) {
        sessionStorage.removeItem('vigi_token');
        sessionStorage.removeItem('vigi_nome');
        sessionStorage.removeItem('vigi_perfil');
        tokenSessao = null;
        mostrarToast('Sessão expirada. Redirecionando...', 'erro');
        setTimeout(() => window.location.reload(), 1500);
      } else {
        mostrarToast('Erro ao carregar casos: ' + msg, 'erro');
        if (btn) btn.innerHTML = '<i class="fas fa-sync-alt"></i>';
      }
    })
    .getTodosOsCasos(tokenSessao);
}

function processarDados(casos) {
  casosGlobais = casos;

  const btn = document.getElementById('btnAtualizar');
  if (btn) btn.innerHTML = '<i class="fas fa-sync-alt"></i>';

  const selectSetor = document.getElementById('filtroSetor');
  const setorAtual  = selectSetor.value;
  const setores     = [...new Set(casos.map(c => c.setor))].filter(Boolean).sort();
  selectSetor.innerHTML = '<option value="TODOS">Todos os Setores</option>';
  setores.forEach(s => {
    selectSetor.innerHTML += `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`;
  });
  if (setores.includes(setorAtual)) selectSetor.value = setorAtual;

  _popularFiltroFarmaceutico();

  paginaAtual.triagem = paginaAtual.investigacao = paginaAtual.concluidos = 1;
  processarFiltros();
}

// ---------------------------------------------------------
// P1.2 — ATUALIZAÇÃO OTIMISTA LOCAL
//
// Substitui carregarCasos() após uma ação de escrita pontual em UM caso
// (triagem, investigação). registrarTriagem/registrarInvestigacao agora
// retornam o caso já atualizado (resumo) — este merge evita um novo
// full-scan de casos_ram só para refletir uma mudança de um único card.
// ---------------------------------------------------------
function atualizarCasoLocal(casoAtualizado) {
  if (!casoAtualizado || !casoAtualizado.id) return;

  const idx = casosGlobais.findIndex(c => c.id === casoAtualizado.id);
  if (idx === -1) {
    casosGlobais.push(casoAtualizado);
  } else {
    casosGlobais[idx] = casoAtualizado;
  }

  // Setor/farmacêutico podem ter mudado — repopula os filtros também
  const selectSetor = document.getElementById('filtroSetor');
  if (selectSetor) {
    const setorAtual = selectSetor.value;
    const setores = [...new Set(casosGlobais.map(c => c.setor))].filter(Boolean).sort();
    selectSetor.innerHTML = '<option value="TODOS">Todos os Setores</option>';
    setores.forEach(s => {
      selectSetor.innerHTML += `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`;
    });
    if (setores.includes(setorAtual)) selectSetor.value = setorAtual;
  }

  paginaAtual.triagem = paginaAtual.investigacao = paginaAtual.concluidos = 1;
  processarFiltros();
}

// ---------------------------------------------------------
// SLA — CÁLCULO
// ---------------------------------------------------------
function calcularSLA(caso) {
  if (!caso.data_evento || caso.data_evento === 'Data N/I')
    return { status: 'SEM', restanteH: null };

  let dataEvento = null;
  const m = caso.data_evento.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (m) {
    dataEvento = new Date(
      parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]),
      parseInt(m[4]), parseInt(m[5])
    );
  } else {
    const iso = caso.data_evento.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
    if (iso) {
      // Parse manual — "yyyy-MM-dd HH:mm" (espaço) é NaN no Safari/iOS.
      dataEvento = new Date(
        parseInt(iso[1]), parseInt(iso[2]) - 1, parseInt(iso[3]),
        parseInt(iso[4] || '0'), parseInt(iso[5] || '0')
      );
    } else {
      dataEvento = new Date(caso.data_evento);
    }
  }
  if (isNaN(dataEvento)) return { status: 'SEM', restanteH: null };

  const restanteH = (dataEvento.getTime() + SLA_PADRAO_HORAS * 3600000 - Date.now()) / 3600000;
  if (restanteH < 0)   return { status: 'VENCIDO',  restanteH };
  if (restanteH < 12)  return { status: 'VENCENDO', restanteH };
  return { status: 'OK', restanteH };
}

function formatarTempoSLA(h) {
  if (h === null) return '';
  const abs = Math.abs(h);
  if (abs < 1)  return `${Math.round(abs * 60)}min`;
  if (abs < 24) return `${Math.round(abs)}h`;
  return `${Math.floor(abs / 24)}d ${Math.round(abs % 24)}h`;
}

function badgeSLAHtml(caso) {
  const { status, restanteH } = calcularSLA(caso);
  const tempo = formatarTempoSLA(restanteH);
  const cfg = {
    OK:       { cls: 'badge-sla-ok',   ico: 'fa-clock',               label: `${tempo} restante`   },
    VENCENDO: { cls: 'badge-sla-warn', ico: 'fa-exclamation-triangle', label: `Vence em ${tempo}`   },
    VENCIDO:  { cls: 'badge-sla-late', ico: 'fa-fire',                 label: `Vencido há ${tempo}` },
    SEM:      { cls: 'badge-sla-sem',  ico: 'fa-minus-circle',         label: 'Sem SLA'             }
  };
  const c = cfg[status];
  return `<span class="${c.cls} text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 w-fit">
    <i class="fas ${c.ico}"></i> ${c.label}
  </span>`;
}

// ---------------------------------------------------------
// TOAST — notificação não-intrusiva
// ---------------------------------------------------------
function mostrarToast(msg, tipo) {
  const cor = tipo === 'erro' ? 'bg-red-600 text-white' : 'bg-green-600 text-white';
  const ico = tipo === 'erro' ? 'fa-exclamation-triangle' : 'fa-check-circle';
  const toast = document.createElement('div');
  toast.className =
    `fixed bottom-6 left-1/2 -translate-x-1/2 ${cor} text-sm font-bold
     px-5 py-3 rounded-xl shadow-xl z-[9999] fade-in flex items-center gap-2`;
  toast.innerHTML = `<i class="fas ${ico}"></i> ${escapeHtml(msg)}`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}
</script>
```

---

## 📄 Arquivo [17/32]: js_dashboard.html

```html
<script>
/**
 * @fileoverview js_dashboard.html
 * Responsabilidade: EXCLUSIVAMENTE o dashboard de gestão.
 *
 * ATUALIZAÇÃO (Produtividade e Filtros Globais):
 * - O dashboard consome `obterDadosFiltradosDash()` que respeita os inputs
 *   de Setor, Farmacêutico, Data De e Data Até da barra principal.
 * - O gráfico de setores compara "Total Rastreado" com "Casos Concluídos".
 *
 * REVISÃO 07/2026 — Rankings e métricas de SLA de triagem:
 *   FIX  — "Top Medicamentos Suspeitos" agora exclui STATUS.TRIAGEM. Antes
 *          da triagem farmacêutica, c.medicamento ainda é o gatilho bruto
 *          do ETL (DB_Antidotos), não o medicamento suspeito clinicamente
 *          avaliado (só é sobrescrito em registrarTriagem() → Cases.gs).
 *   NOVO — Ranking de produção por setor e por farmacêutico (tabelas).
 *   NOVO — Gráfico de conversão Gatilho → RAM, restrito a tipo === 'BA'
 *          (Busca Ativa); Demanda Espontânea já nasce pré-suspeita, não
 *          se aplica o conceito de "conversão de gatilho".
 *   NOVO — Gravidade das notificações de RAM (conclusao CONFIRMADO/
 *          PROVÁVEL) segmentada por setor, barras empilhadas.
 *   NOVO — Tempo médio de análise (triagem) e contagem de atrasados,
 *          calculados a partir de c.dataTriagem (timestamp dedicado,
 *          carimbado 1x em registrarTriagem() — ver Cases.gs/Schema.gs).
 *          Restrito a tipo === 'BA' e já triados (status !== TRIAGEM),
 *          já que só a fase Triagem tem prazo regulatório (SLA_PADRAO_HORAS).
 *
 * Depende de: js_core (casosGlobais, STATUS, escapeHtml,
 *   getFarmaceuticoPorSetor, SLA_PADRAO_HORAS, formatarTempoSLA)
 */

// Instâncias dos gráficos (necessárias para destruir antes de redesenhar)
let _grafDesfechos = null;
let _grafGravidade = null;
let _grafSetores = null;
let _grafMedicamentos = null;
let _grafGatilhoRam = null;
let _grafGravidadeSetor = null;

// Lógica de filtro combinada, herdando as regras idênticas ao js_kanban
function obterDadosFiltradosDash() {
  const setor = document.getElementById('filtroSetor').value;
  const farmaceut = document.getElementById('filtroFarmaceutico').value;
  const dataDe = document.getElementById('filtroDe').value;
  const dataAte = document.getElementById('filtroAte').value;

  return casosGlobais.filter(c => {
    // 1. Filtro de Setor
    if (setor !== 'TODOS' && c.setor !== setor) return false;

    // 2. Filtro de Farmacêutico (Usa o responsável canônico DO SETOR ou o digitado)
    if (farmaceut !== 'TODOS') {
      const canonico = getFarmaceuticoPorSetor(c.setor); // vem do js_core
      const doCaso = (c.farmaceutico || "").trim();
      const bate = (canonico === farmaceut) || (doCaso === farmaceut);
      if (!bate) return false;
    }

    // 3. Filtro de Período (Mês/Data)
    if (dataDe || dataAte) {
      const p = (c.data_evento || "").match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      if (p) {
        const dEv = new Date(parseInt(p[3]), parseInt(p[2]) - 1, parseInt(p[1]));
        if (dataDe && dEv < new Date(dataDe)) return false;
        if (dataAte && dEv > new Date(dataAte)) return false;
      }
    }

    return true;
  });
}

// ---------------------------------------------------------
// HELPERS DE DATA — parsing tolerante para métricas de SLA
// ---------------------------------------------------------

/** Parseia "dd/MM/yyyy HH:mm" (data_evento) → Date | null */
function _parseDataEventoBR(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  if (m) {
    return new Date(
      parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]),
      parseInt(m[4] || 0), parseInt(m[5] || 0)
    );
  }
  const d = new Date(str);
  return isNaN(d) ? null : d;
}

/** Parseia o ISO retornado por _mapearCasoResumo_ para dataTriagem → Date | null */
function _parseDataTriagemISO(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d) ? null : d;
}

/** RAM efetivamente confirmada — mesma regra usada no cálculo de calc.ram */
function _ehRamConfirmada(c) {
  return c.status === STATUS.CONCLUIDO &&
    (c.conclusao === 'CONFIRMADO' || c.conclusao === 'PROVÁVEL');
}

// ---------------------------------------------------------
// DESENHAR / ATUALIZAR GRÁFICOS
// ---------------------------------------------------------
function desenharGraficos() {
  const dados = obterDadosFiltradosDash();

  // Acumuladores
  const calc = {
    ram: 0, descarte: 0, analise: 0,
    gravidade: { LEVE: 0, MODERADA: 0, GRAVE: 0, FATAL: 0 },
    setores: {},
    produtividadeSetor: {},   // Conta apenas STATUS.CONCLUIDO para medir produtividade por setor
    meds: {},
    farmaceuticos: {},        // NOVO — produção (casos concluídos) por farmacêutico
    gatilho: { total: 0, viraramRam: 0, descartados: 0, emAnalise: 0 }, // NOVO — só tipo 'BA'
    gravidadeSetor: {},       // NOVO — setor → {LEVE,MODERADA,GRAVE,FATAL}, só RAM confirmada
    slaAnalise: { somaHoras: 0, qtd: 0, atrasados: 0 } // NOVO — só tipo 'BA', já triados
  };

  dados.forEach(c => {
    // Desfecho Global
    if (c.status === STATUS.DESCARTADO || c.conclusao === 'NÃO RELACIONADO AO MEDICAMENTO') {
      calc.descarte++;
    } else if (_ehRamConfirmada(c)) {
      calc.ram++;
    } else {
      calc.analise++;
    }

    // Setores (Todos exceto descartados)
    if (c.setor && c.status !== STATUS.DESCARTADO && c.conclusao !== 'NÃO RELACIONADO AO MEDICAMENTO') {
      calc.setores[c.setor] = (calc.setores[c.setor] || 0) + 1;
    }

    // Produtividade: Mede o que a equipe do setor de fato conseguiu concluir
    if (c.setor && c.status === STATUS.CONCLUIDO) {
      calc.produtividadeSetor[c.setor] = (calc.produtividadeSetor[c.setor] || 0) + 1;
    }

    // NOVO — Produtividade por farmacêutico (atribuição real do caso concluído)
    if (c.status === STATUS.CONCLUIDO) {
      const f = (c.farmaceutico || '').trim();
      if (f) calc.farmaceuticos[f] = (calc.farmaceuticos[f] || 0) + 1;
    }

    // Gravidade global (apenas concluídos)
    if (c.status === STATUS.CONCLUIDO) {
      const g = (c.gravidade || "").toUpperCase().trim();
      if (calc.gravidade[g] !== undefined) calc.gravidade[g]++;
    }

    // NOVO — Gravidade por setor, restrito a notificações de RAM confirmadas
    if (_ehRamConfirmada(c) && c.setor) {
      const g = (c.gravidade || "").toUpperCase().trim();
      if (!calc.gravidadeSetor[c.setor]) {
        calc.gravidadeSetor[c.setor] = { LEVE: 0, MODERADA: 0, GRAVE: 0, FATAL: 0 };
      }
      if (calc.gravidadeSetor[c.setor][g] !== undefined) calc.gravidadeSetor[c.setor][g]++;
    }

    // FIX — Medicamento suspeito: só conta após a triagem farmacêutica.
    // Em STATUS.TRIAGEM, c.medicamento ainda é o gatilho bruto do ETL, não
    // o medicamento suspeito clinicamente avaliado (ver header do arquivo).
    if (c.medicamento && c.medicamento !== "N/I" &&
        c.status !== STATUS.TRIAGEM && c.status !== STATUS.DESCARTADO) {
      calc.meds[c.medicamento] = (calc.meds[c.medicamento] || 0) + 1;
    }

    // NOVO — Conversão Gatilho → RAM (só Busca Ativa)
    if (c.tipo === 'BA') {
      calc.gatilho.total++;
      if (_ehRamConfirmada(c)) {
        calc.gatilho.viraramRam++;
      } else if (c.status === STATUS.DESCARTADO) {
        calc.gatilho.descartados++;
      } else {
        calc.gatilho.emAnalise++;
      }
    }

    // NOVO — Tempo de análise (triagem) e atraso, só Busca Ativa já triada
    if (c.tipo === 'BA' && c.dataTriagem && c.status !== STATUS.TRIAGEM) {
      const dEvento = _parseDataEventoBR(c.data_evento);
      const dTriagem = _parseDataTriagemISO(c.dataTriagem);
      if (dEvento && dTriagem) {
        const horas = (dTriagem.getTime() - dEvento.getTime()) / 3600000;
        if (horas >= 0) {
          calc.slaAnalise.somaHoras += horas;
          calc.slaAnalise.qtd++;
          if (horas > SLA_PADRAO_HORAS) calc.slaAnalise.atrasados++;
        }
      }
    }
  });

  // Atualizar KPI cards existentes
  document.getElementById('dashCardTotal').innerText = dados.length;
  document.getElementById('dashCardRAMs').innerText = calc.ram;
  document.getElementById('dashCardDescartes').innerText = calc.descarte;
  document.getElementById('dashCardPendentes').innerText = calc.analise;

  // NOVO — KPI de tempo médio de análise e atrasados
  const tempoMedioH = calc.slaAnalise.qtd ? (calc.slaAnalise.somaHoras / calc.slaAnalise.qtd) : null;
  const elTempoMedio = document.getElementById('dashCardTempoMedio');
  if (elTempoMedio) elTempoMedio.innerText = tempoMedioH === null ? '—' : formatarTempoSLA(tempoMedioH);
  const elAtrasados = document.getElementById('dashCardAtrasados');
  if (elAtrasados) elAtrasados.innerText = calc.slaAnalise.atrasados;
  const elAtrasadosSub = document.getElementById('dashCardAtrasadosSub');
  if (elAtrasadosSub) {
    elAtrasadosSub.innerText = calc.slaAnalise.qtd
      ? `${calc.slaAnalise.atrasados} de ${calc.slaAnalise.qtd} gatilho(s) triado(s) no período`
      : 'Sem gatilhos triados no período';
  }

  // Destruir gráficos anteriores para evitar memory leak
  [_grafDesfechos, _grafGravidade, _grafSetores, _grafMedicamentos, _grafGatilhoRam, _grafGravidadeSetor]
    .forEach(g => { if (g) g.destroy(); });
  _grafDesfechos = _grafGravidade = _grafSetores = _grafMedicamentos = _grafGatilhoRam = _grafGravidadeSetor = null;

  Chart.defaults.font.family = "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";

  // Gráfico 1 - Desfecho dos gatilhos (rosca)
  _grafDesfechos = new Chart(document.getElementById('graficoDesfechos').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: ['RAM Confirmada', 'Falso Positivo', 'Em Análise'],
      datasets: [{
        data: [calc.ram, calc.descarte, calc.analise],
        backgroundColor: ['#ef4444', '#9ca3af', '#f97316'],
        borderWidth: 0
      }]
    },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
  });

  // Gráfico 2 - Distribuição de gravidade (pizza)
  _grafGravidade = new Chart(document.getElementById('graficoGravidade').getContext('2d'), {
    type: 'pie',
    data: {
      labels: ['Leve', 'Moderada', 'Grave', 'Fatal'],
      datasets: [{
        data: [calc.gravidade.LEVE, calc.gravidade.MODERADA, calc.gravidade.GRAVE, calc.gravidade.FATAL],
        backgroundColor: ['#fcd34d', '#f97316', '#dc2626', '#112937'],
        borderWidth: 0
      }]
    },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
  });

  // Gráfico 3 - Produtividade e Eventos por Setor (barras agrupadas, top 5)
  const topSetores = Object.keys(calc.setores)
    .sort((a, b) => calc.setores[b] - calc.setores[a])
    .slice(0, 5);

  _grafSetores = new Chart(document.getElementById('graficoSetores').getContext('2d'), {
    type: 'bar',
    data: {
      labels: topSetores,
      datasets: [
        {
          label: 'Total Rastreado',
          data: topSetores.map(s => calc.setores[s]),
          backgroundColor: '#e5e7eb'
        },
        {
          label: 'Casos Concluídos',
          data: topSetores.map(s => calc.produtividadeSetor[s] || 0),
          backgroundColor: '#0ea5e9'
        }
      ]
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } }
    }
  });

  // Gráfico 4 - Top medicamentos suspeitos (barras horizontais, top 5)
  // Agora só considera casos já triados (fix — ver header do arquivo)
  const topMeds = Object.keys(calc.meds)
    .sort((a, b) => calc.meds[b] - calc.meds[a])
    .slice(0, 5);

  _grafMedicamentos = new Chart(document.getElementById('graficoMedicamentos').getContext('2d'), {
    type: 'bar',
    data: {
      labels: topMeds,
      datasets: [{
        label: 'Suspeitas (confirmadas na triagem)',
        data: topMeds.map(m => calc.meds[m]),
        backgroundColor: '#8b5cf6'
      }]
    },
    options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });

  // NOVO — Gráfico 5: Conversão Gatilho → RAM (só Busca Ativa)
  _grafGatilhoRam = new Chart(document.getElementById('graficoGatilhoRam').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: ['Viraram RAM', 'Falso Positivo', 'Em Análise'],
      datasets: [{
        data: [calc.gatilho.viraramRam, calc.gatilho.descartados, calc.gatilho.emAnalise],
        backgroundColor: ['#dc2626', '#9ca3af', '#f97316'],
        borderWidth: 0
      }]
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom' },
        title: {
          display: true,
          text: `${calc.gatilho.total} gatilho(s) rastreado(s) no período`,
          font: { size: 11, weight: 'normal' },
          color: '#6b7280',
          padding: { top: 4 }
        }
      }
    }
  });

  // NOVO — Gráfico 6: Notificações de RAM por setor × gravidade (barras empilhadas, top 8)
  const setoresRam = Object.keys(calc.gravidadeSetor)
    .sort((a, b) => {
      const totA = Object.values(calc.gravidadeSetor[a]).reduce((s, v) => s + v, 0);
      const totB = Object.values(calc.gravidadeSetor[b]).reduce((s, v) => s + v, 0);
      return totB - totA;
    })
    .slice(0, 8);

  _grafGravidadeSetor = new Chart(document.getElementById('graficoGravidadeSetor').getContext('2d'), {
    type: 'bar',
    data: {
      labels: setoresRam,
      datasets: [
        { label: 'Leve',     data: setoresRam.map(s => calc.gravidadeSetor[s].LEVE),     backgroundColor: '#fcd34d' },
        { label: 'Moderada', data: setoresRam.map(s => calc.gravidadeSetor[s].MODERADA), backgroundColor: '#f97316' },
        { label: 'Grave',    data: setoresRam.map(s => calc.gravidadeSetor[s].GRAVE),    backgroundColor: '#dc2626' },
        { label: 'Fatal',    data: setoresRam.map(s => calc.gravidadeSetor[s].FATAL),    backgroundColor: '#112937' }
      ]
    },
    options: {
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }
      },
      plugins: { legend: { position: 'bottom' } }
    }
  });

  // NOVO — Rankings em tabela
  _renderizarRankingSetores(calc.setores, calc.produtividadeSetor);
  _renderizarRankingFarmaceuticos(calc.farmaceuticos);
}

// ---------------------------------------------------------
// NOVO — Ranking de produção por setor (tabela, top 10)
// ---------------------------------------------------------
function _renderizarRankingSetores(setores, produtividade) {
  const corpo = document.getElementById('rankingSetoresBody');
  if (!corpo) return;

  const linhas = Object.keys(setores)
    .map(s => ({ setor: s, total: setores[s], concluidos: produtividade[s] || 0 }))
    .sort((a, b) => b.concluidos - a.concluidos)
    .slice(0, 10);

  corpo.innerHTML = linhas.length === 0
    ? '<tr><td colspan="5" class="text-center text-gray-400 py-3">Sem dados no período.</td></tr>'
    : linhas.map((l, i) => {
        const pct = l.total ? Math.round((l.concluidos / l.total) * 100) : 0;
        const corPct = pct >= 70 ? 'text-teal-600' : (pct >= 40 ? 'text-orange-500' : 'text-red-500');
        return `<tr class="border-b border-gray-100">
          <td class="py-1.5 px-2 text-gray-400 font-bold">${i + 1}º</td>
          <td class="py-1.5 px-2 font-semibold text-gray-700">${escapeHtml(l.setor)}</td>
          <td class="py-1.5 px-2 text-center">${l.concluidos}</td>
          <td class="py-1.5 px-2 text-center text-gray-400">${l.total}</td>
          <td class="py-1.5 px-2 text-right font-bold ${corPct}">${pct}%</td>
        </tr>`;
      }).join('');
}

// ---------------------------------------------------------
// NOVO — Ranking de produção por farmacêutico (tabela, top 10)
// ---------------------------------------------------------
function _renderizarRankingFarmaceuticos(farmaceuticos) {
  const corpo = document.getElementById('rankingFarmaceuticosBody');
  if (!corpo) return;

  const total = Object.values(farmaceuticos).reduce((s, v) => s + v, 0);
  const linhas = Object.keys(farmaceuticos)
    .map(f => ({ nome: f, concluidos: farmaceuticos[f] }))
    .sort((a, b) => b.concluidos - a.concluidos)
    .slice(0, 10);

  corpo.innerHTML = linhas.length === 0
    ? '<tr><td colspan="4" class="text-center text-gray-400 py-3">Sem casos concluídos no período.</td></tr>'
    : linhas.map((l, i) => {
        const pct = total ? Math.round((l.concluidos / total) * 100) : 0;
        return `<tr class="border-b border-gray-100">
          <td class="py-1.5 px-2 text-gray-400 font-bold">${i + 1}º</td>
          <td class="py-1.5 px-2 font-semibold text-gray-700">${escapeHtml(l.nome)}</td>
          <td class="py-1.5 px-2 text-center">${l.concluidos}</td>
          <td class="py-1.5 px-2 text-right text-gray-400">${pct}%</td>
        </tr>`;
      }).join('');
}
</script>
```

---

## 📄 Arquivo [18/32]: js_investigacao.html

```html
<script>
// =========================================================
// js_investigacao.html — v2.3
//
// P2: casosGlobais agora contém apenas o RESUMO de cada caso (ver
// Cases.gs). abrirInvestigacao() foi dividida em duas etapas:
//   1. Preenche o cabeçalho read-only IMEDIATAMENTE com dados já em
//      memória (prontuário, setor, medicamento, tipo, data, iniciais).
//   2. Busca o DETALHE COMPLETO via getCasoDetalhado(id, token) e só
//      então preenche história clínica, Naranjo, notificador etc.
// O modal abre instantaneamente; o formulário aparece "carregando" por
// uma fração de segundo enquanto o detalhe chega — ganho de percepção
// de velocidade sem esperar o payload pesado antes de abrir o modal.
//
// P1.2: enviarInvestigacao() usa atualizarCasoLocal() em vez de
// carregarCasos().
//
// FASE 8 (Exportação E2B(R3) para VigiMed) — v2.3:
//   Adicionados 5 campos novos: reacaoTermo, doseMedicamento,
//   doseUnidade, viaAdministracao, dataInicioReacao. Tocados em
//   _limparFormularioInvestigacao, _preencherFormularioInvestigacao,
//   _coletarFormulario e enviarInvestigacao (reacaoTermo agora
//   obrigatório para finalizar, junto com Gravidade/Desfecho/Conclusão).
//
//   DEPENDÊNCIA: os 5 <input>/<select> correspondentes (ids
//   invReacaoTermo, invDoseMedicamento, invDoseUnidade,
//   invViaAdministracao, invDataInicioReacao) precisam existir no
//   markup do modal (index.html) — este arquivo é só a lógica, o HTML
//   do modal vive em outro partial. Sem esses elementos no DOM, os
//   getElementById(...) retornam null e o código aqui já trata isso
//   com checagem defensiva (if (el) ...) — não quebra, mas o dado
//   também não é coletado/exibido até o HTML ser adicionado.
//
// Depende de: js_core (escapeHtml, casosGlobais, mostrarToast,
//             atualizarCasoLocal, getFarmaceuticoPorSetor, STATUS,
//             tokenSessao)
// =========================================================

// ---------------------------------------------------------
// CONFIGURAÇÃO DO NARANJO
// ---------------------------------------------------------
const NARANJO_CONFIG = [
  { id: 1,  pergunta: 'Há relatos prévios sobre esta reação?',
    tooltip: 'Existem publicações científicas, bulas ou comunicações anteriores que relatem essa reação adversa para este medicamento?',
    sim: { valor: 1,  label: 'Sim (+1)' }, nao: { valor: 0,  label: 'Não (0)'  }, ns: { valor: 0, label: 'NS (0)' } },
  { id: 2,  pergunta: 'A reação apareceu após o uso do medicamento?',
    tooltip: 'A reação adversa ocorreu após o início do uso do medicamento suspeito? Estabeleça a relação temporal de causa e efeito.',
    sim: { valor: 2,  label: 'Sim (+2)' }, nao: { valor: -1, label: 'Não (-1)' }, ns: { valor: 0, label: 'NS (0)' } },
  { id: 3,  pergunta: 'A reação melhorou ao suspender o medicamento ou usar antagonista?',
    tooltip: 'Houve melhora clínica após a suspensão do medicamento suspeito ou após uso de antídoto/antagonista específico?',
    sim: { valor: 1,  label: 'Sim (+1)' }, nao: { valor: 0,  label: 'Não (0)'  }, ns: { valor: 0, label: 'NS (0)' } },
  { id: 4,  pergunta: 'A reação reapareceu ao readministrar o medicamento?',
    tooltip: 'Quando o medicamento foi readministrado (rechallenge), a reação adversa voltou a ocorrer? Resposta "Não" penaliza o escore.',
    sim: { valor: 2,  label: 'Sim (+2)' }, nao: { valor: -1, label: 'Não (-1)' }, ns: { valor: 0, label: 'NS (0)' } },
  { id: 5,  pergunta: 'Existem causas alternativas que poderiam ter causado a reação?',
    tooltip: 'A reação poderia ser explicada pela doença de base, por outra medicação, ou por outros fatores clínicos não relacionados ao medicamento suspeito?',
    sim: { valor: -1, label: 'Sim (-1)' }, nao: { valor: 2,  label: 'Não (+2)' }, ns: { valor: 0, label: 'NS (0)' } },
  { id: 6,  pergunta: 'A reação reapareceu ao dar placebo?',
    tooltip: 'Se o paciente recebeu placebo no lugar do medicamento, a reação continuou ocorrendo? Se sim, sugere que o medicamento não é a causa.',
    sim: { valor: -1, label: 'Sim (-1)' }, nao: { valor: 1,  label: 'Não (+1)' }, ns: { valor: 0, label: 'NS (0)' } },
  { id: 7,  pergunta: 'O medicamento foi detectado no sangue em concentração tóxica?',
    tooltip: 'Exames laboratoriais (nível sérico, dosagem) confirmaram concentração do medicamento acima do intervalo terapêutico ou em nível tóxico?',
    sim: { valor: 1,  label: 'Sim (+1)' }, nao: { valor: 0,  label: 'Não (0)'  }, ns: { valor: 0, label: 'NS (0)' } },
  { id: 8,  pergunta: 'A reação foi mais grave ao aumentar a dose?',
    tooltip: 'Existe relação dose-resposta? Aumento da dose intensificou a reação; redução da dose a atenuou? Isso reforça a causalidade.',
    sim: { valor: 1,  label: 'Sim (+1)' }, nao: { valor: 0,  label: 'Não (0)'  }, ns: { valor: 0, label: 'NS (0)' } },
  { id: 9,  pergunta: 'O paciente já apresentou reação semelhante ao mesmo medicamento?',
    tooltip: 'Há histórico prévio do paciente com reação adversa semelhante ao ser exposto ao mesmo agente farmacológico ou a agentes da mesma classe?',
    sim: { valor: 1,  label: 'Sim (+1)' }, nao: { valor: 0,  label: 'Não (0)'  }, ns: { valor: 0, label: 'NS (0)' } },
  { id: 10, pergunta: 'A reação adversa foi confirmada por evidência objetiva?',
    tooltip: 'Exames complementares (laboratoriais, imagem, biópsia, etc.) confirmaram objetivamente a reação adversa de forma inequívoca?',
    sim: { valor: 1,  label: 'Sim (+1)' }, nao: { valor: 0,  label: 'Não (0)'  }, ns: { valor: 0, label: 'NS (0)' } }
];

const NARANJO_FAIXAS = [
  { min: -Infinity, max: 0, label: 'DUVIDOSA',  css: 'bg-gray-100 text-gray-700 border-gray-300',     ponto: 'Escore ≤ 0 — causalidade improvável'          },
  { min: 1,  max: 4,        label: 'POSSÍVEL',  css: 'bg-yellow-50 text-yellow-800 border-yellow-300', ponto: 'Escore 1–4 — possível relação causal'          },
  { min: 5,  max: 8,        label: 'PROVÁVEL',  css: 'bg-orange-50 text-orange-800 border-orange-400', ponto: 'Escore 5–8 — relação provavelmente causal'     },
  { min: 9,  max: Infinity, label: 'DEFINIDA',  css: 'bg-red-50 text-red-800 border-red-400',          ponto: 'Escore ≥ 9 — relação definitivamente causal'   }
];

const CAMPOS_PROGRESSO = [
  'invHistoriaClinica', 'invRelatoEvento',     'invExames',
  'invReadministrado',  'invEvolucao',
  'invGravidade',       'invDesfecho',         'invConclusao',
  'invFarmaceutico',    'invObservacoes',      'invLote',
  'invLaboratorio',
  'invReacaoTermo',     'invDoseMedicamento',  'invDoseUnidade',
  'invViaAdministracao','invDataInicioReacao'
];

// ---------------------------------------------------------
// ESTADO INTERNO
// ---------------------------------------------------------
let _invIdAtual         = '';
let _classNaranjoFinal  = 'DUVIDOSA';
let _autosaveTimer      = null;
const _rascunhosEmMemoria = new Map();

// ---------------------------------------------------------
// CONSTRUÇÃO DINÂMICA DO NARANJO
// ---------------------------------------------------------
function construirNaranjo() {
  const container = document.getElementById('naranjoPerguntas');
  if (!container) return;
  container.innerHTML = '';

  NARANJO_CONFIG.forEach(q => {
    const row = document.createElement('div');
    row.className = 'naranjo-row flex items-center justify-between py-2 border-b border-gray-100 gap-3';
    row.setAttribute('data-tooltip', q.tooltip);
    row.innerHTML = `
      <p class="text-xs text-gray-700 flex-1 leading-snug select-none">
        <span class="font-bold text-gray-400 mr-1">${q.id}.</span>${escapeHtml(q.pergunta)}
        <i class="fas fa-info-circle text-gray-300 ml-1 text-[10px]"></i>
      </p>
      <select class="naranjo-select text-xs border rounded-lg px-2 py-1.5 min-w-[110px]
        focus:ring-2 focus:ring-blue-400 transition" onchange="calcularNaranjo()">
        <option value="${q.ns.valor}">${escapeHtml(q.ns.label)}</option>
        <option value="${q.sim.valor}">${escapeHtml(q.sim.label)}</option>
        <option value="${q.nao.valor}">${escapeHtml(q.nao.label)}</option>
      </select>`;
    container.appendChild(row);
  });
}

// ---------------------------------------------------------
// NARANJO — CÁLCULO E BADGE
// ---------------------------------------------------------
function calcularNaranjo() {
  let score = 0;
  document.querySelectorAll('.naranjo-select').forEach(s => { score += parseInt(s.value) || 0; });

  const faixa = NARANJO_FAIXAS.find(f => score >= f.min && score <= f.max) || NARANJO_FAIXAS[0];
  _classNaranjoFinal = faixa.label;

  const c = document.getElementById('naranjoFaixaContainer');
  c.className = `flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-bold
    transition-all duration-300 ${faixa.css}`;

  document.getElementById('naranjoEscore').textContent        = score > 0 ? `+${score}` : `${score}`;
  document.getElementById('naranjoClassificacao').textContent  = faixa.label;
  document.getElementById('naranjoInterpretacao').textContent  = faixa.ponto;

  agendarAutosave();
}

// ---------------------------------------------------------
// HELPER — calcula idade a partir de data de nascimento
// ---------------------------------------------------------
function _calcularIdade(nascimento) {
  if (!nascimento || nascimento === 'N/I') return '';
  let d;
  const m1 = String(nascimento).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  const m2 = String(nascimento).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m1)      d = new Date(parseInt(m1[3]), parseInt(m1[2]) - 1, parseInt(m1[1]));
  else if (m2) d = new Date(parseInt(m2[1]), parseInt(m2[2]) - 1, parseInt(m2[3]));
  else         d = new Date(nascimento);
  if (isNaN(d)) return '';
  const hoje  = new Date();
  let anos    = hoje.getFullYear() - d.getFullYear();
  const m     = hoje.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && hoje.getDate() < d.getDate())) anos--;
  if (anos < 0 || anos > 130) return '';
  return `${anos} anos`;
}

// ---------------------------------------------------------
// ABRIR MODAL — ETAPA 1: cabeçalho instantâneo (dados resumo em memória)
// ---------------------------------------------------------
function abrirInvestigacao(id) {
  const caso = casosGlobais.find(c => c.id === id);
  if (!caso) return;

  _invIdAtual = id;

  // Cabeçalho read-only — dados de resumo já disponíveis, sem espera
  document.getElementById('invProntuario').innerText  = caso.prontuario;
  document.getElementById('invSetor').innerText       = caso.setor;
  document.getElementById('invMedicamento').innerText = caso.medicamento;
  document.getElementById('invTipoBadge').innerText   = caso.tipo;
  document.getElementById('invDataEvento').innerText  = formatarDataExibicao(caso.data_evento) || '-';
  document.getElementById('invSubtitulo').textContent = `ID: ${caso.id} · ${caso.setor}`;
  _aplicarModoSomenteLeitura(caso.status === STATUS.CONCLUIDO);

  const elIniciais = document.getElementById('invIniciais');
  const elIdade    = document.getElementById('invIdade');
  if (elIniciais) elIniciais.innerText = caso.paciente || '-';
  if (elIdade) {
    const idade = _calcularIdade(caso.data_nascimento || caso.nascimento);
    elIdade.innerText = idade || (caso.data_nascimento && caso.data_nascimento !== 'N/I'
      ? caso.data_nascimento : '-');
  }

  _limparFormularioInvestigacao();
  document.getElementById('modalInvestigacao').classList.remove('hidden');
  _mostrarCarregandoInvestigacao(true);

  // ETAPA 2: busca o detalhe completo (P2) — só agora traz história
  // clínica, Naranjo, PII do notificador etc. Payload pesado fica fora
  // da sincronização geral do Kanban.
  google.script.run
    .withSuccessHandler(casoCompleto => {
      _mostrarCarregandoInvestigacao(false);
      _preencherFormularioInvestigacao(casoCompleto);
    })
    .withFailureHandler(err => {
      _mostrarCarregandoInvestigacao(false);
      mostrarToast('Erro ao carregar detalhes do caso: ' + (err.message || err), 'erro');
      fecharModalInvestigacao();
    })
    .getCasoDetalhado(id, tokenSessao);
}



/**
 * Alterna um leve estado de "carregando" no formulário enquanto o
 * detalhe completo é buscado. Elementos são OPCIONAIS — se
 * #invCarregandoDetalhe ou #formInvestigacaoCampos não existirem no
 * index.html, a função simplesmente não faz nada (sem quebrar).
 * Sugestão: adicionar um <div id="invCarregandoDetalhe" class="hidden">
 * com um spinner no topo do modal, e envolver os campos do formulário
 * num container id="formInvestigacaoCampos" para o efeito de opacidade.
 */
function _mostrarCarregandoInvestigacao(mostrar) {
  const elSpinner = document.getElementById('invCarregandoDetalhe');
  if (elSpinner) elSpinner.classList.toggle('hidden', !mostrar);
  const elForm = document.getElementById('formInvestigacaoCampos');
  if (elForm) elForm.classList.toggle('opacity-40', mostrar);
}

function _limparFormularioInvestigacao() {
  ['invHistoriaClinica','invRelatoEvento','invExames','invNumVigimed',
   'invDataVigimed','invObservacoes','invLote','invLaboratorio','invFarmaceutico',
   'invReacaoTermo','invDoseMedicamento','invDoseUnidade',
   'invViaAdministracao','invDataInicioReacao',
   'invDataInicioAdministracao','invDataNascimento'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.querySelectorAll('.naranjo-select').forEach(s => s.value = '0');
  calcularNaranjo();
  const bloco = document.getElementById('invBlocoNotificador');
  if (bloco) bloco.classList.add('hidden');
}

function _preencherFormularioInvestigacao(caso) {
  document.getElementById('invHistoriaClinica').value = caso.historiaClinica || '';
  document.getElementById('invRelatoEvento').value    = caso.relatoEvento    || '';
  document.getElementById('invExames').value          = caso.exames          || '';
  document.getElementById('invNumVigimed').value      = caso.numVigimed      || '';
  document.getElementById('invDataVigimed').value     = paraInputDateTimeLocal(caso.dataVigimed);
  document.getElementById('invObservacoes').value     = caso.observacoes     || '';
  const elLote = document.getElementById('invLote');
  if (elLote) elLote.value = caso.lote || '';
  const elLab = document.getElementById('invLaboratorio');
  if (elLab) elLab.value = caso.laboratorio || '';

  // Fase 8 / Exportação E2B(R3) — campos opcionais, preenche se existirem no DOM
  const elReacaoTermo = document.getElementById('invReacaoTermo');
  if (elReacaoTermo) elReacaoTermo.value = caso.reacaoTermo || '';
  const elDose = document.getElementById('invDoseMedicamento');
  if (elDose) elDose.value = caso.doseMedicamento || '';
  const elDoseUnidade = document.getElementById('invDoseUnidade');
  if (elDoseUnidade) elDoseUnidade.value = caso.doseUnidade || '';
  const elVia = document.getElementById('invViaAdministracao');
  if (elVia) elVia.value = caso.viaAdministracao || '';
  const elDataReacao = document.getElementById('invDataInicioReacao');
  if (elDataReacao) elDataReacao.value = paraInputDateTimeLocal(caso.dataInicioReacao);
  const elDataAdm = document.getElementById('invDataInicioAdministracao');
  if (elDataAdm) elDataAdm.value = paraInputDateTimeLocal(caso.dataInicioAdministracao);
  const elNasc = document.getElementById('invDataNascimento');
  if (elNasc) elNasc.value = caso.nascimento || '';

  _setSelectSeguro('invReadministrado', caso.readministrado);
  _setSelectSeguro('invEvolucao',       caso.evolucao);
  _setSelectSeguro('invDesfecho',       caso.desfecho);
  _setSelectSeguro('invConclusao',      caso.conclusao);
  _setSelectSeguro('invGravidade',      caso.gravidade);

  const farmaDoCaso   = (caso.farmaceutico || '').trim();
  const farmaCanonica = getFarmaceuticoPorSetor(caso.setor);
  document.getElementById('invFarmaceutico').value = farmaDoCaso || farmaCanonica;
  _sinalizarFarmaceuticoAutopreenchido(!!((!farmaDoCaso) && farmaCanonica));

  const selects = document.querySelectorAll('.naranjo-select');
  if (caso.naranjoRespostas) {
    const resp = caso.naranjoRespostas.split('|');
    selects.forEach((s, i) => { s.value = resp[i] !== undefined ? resp[i] : '0'; });
  } else {
    selects.forEach(s => s.value = '0');
  }
  calcularNaranjo();

  _carregarRascunhoMemoria(_invIdAtual);
  atualizarProgresso();
  _preencherBlocoNotificador(caso);
}

// ---------------------------------------------------------
// MODO SOMENTE LEITURA (casos CONCLUÍDOS)
// ---------------------------------------------------------
function _aplicarModoSomenteLeitura(somenteLeitura) {
  const form = document.getElementById('formInvestigacao');
  if (form) {
    form.querySelectorAll('input, select, textarea').forEach(el => {
      if (el.id === 'invNumVigimed' || el.id === 'invDataVigimed') return; // regidos à parte
      el.disabled = somenteLeitura;
    });
  }
  document.querySelectorAll('.naranjo-select').forEach(s => s.disabled = somenteLeitura);

  const btnRascunho    = document.getElementById('btnRascunho');
  const btnFinalizar   = document.getElementById('btnFinalizar');
  const btnReabrir     = document.getElementById('btnReabrir');
  const btnExportarE2B = document.getElementById('btnExportarE2B');
  const blocoVigimed   = document.getElementById('invBlocoConclusaoVigimed');

  if (btnRascunho)     btnRascunho.classList.toggle('hidden', somenteLeitura);
  if (btnFinalizar)    btnFinalizar.classList.toggle('hidden', somenteLeitura);
  if (btnReabrir)      btnReabrir.classList.toggle('hidden', !somenteLeitura);
  if (btnExportarE2B)  btnExportarE2B.classList.toggle('hidden', !somenteLeitura);
  if (blocoVigimed)    blocoVigimed.classList.toggle('hidden', !somenteLeitura);
}

// ---------------------------------------------------------
// REABRIR CASO CONCLUÍDO
// ---------------------------------------------------------
function reabrirCaso() {
  if (!_invIdAtual) return;
  if (!confirm('Retornar este caso para "Em Investigação"? Os campos voltarão a ficar editáveis.')) return;

  const btn = document.getElementById('btnReabrir');
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  btn.disabled  = true;

  google.script.run
    .withSuccessHandler(casoAtualizado => {
      btn.innerHTML = originalHtml;
      btn.disabled  = false;
      atualizarCasoLocal(casoAtualizado);
      _aplicarModoSomenteLeitura(false);
      mostrarToast('Caso reaberto para investigação.', 'sucesso');
    })
    .withFailureHandler(err => {
      btn.innerHTML = originalHtml;
      btn.disabled  = false;
      mostrarToast('Erro ao reabrir: ' + (err.message || err), 'erro');
    })
    .reabrirInvestigacao(_invIdAtual, tokenSessao);
}

// ---------------------------------------------------------
// REGISTRAR IMPORTAÇÃO VIGIMED (tela de conclusão)
// ---------------------------------------------------------
function salvarImportacaoVigimed() {
  if (!_invIdAtual) return;

  const numVigimed  = document.getElementById('invNumVigimed').value.trim();
  const dataVigimed = document.getElementById('invDataVigimed').value;
  if (!numVigimed || !dataVigimed) {
    mostrarToast('Informe o número e a data da importação no VigiMed.', 'erro');
    return;
  }

  const btn = document.getElementById('btnSalvarVigimed');
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  btn.disabled  = true;

  google.script.run
    .withSuccessHandler(casoAtualizado => {
      btn.innerHTML = originalHtml;
      btn.disabled  = false;
      atualizarCasoLocal(casoAtualizado);
      mostrarToast('Importação VigiMed registrada.', 'sucesso');
    })
    .withFailureHandler(err => {
      btn.innerHTML = originalHtml;
      btn.disabled  = false;
      mostrarToast('Erro ao registrar: ' + (err.message || err), 'erro');
    })
    .registrarImportacaoVigimed({ idCaso: _invIdAtual, numVigimed, dataVigimed }, tokenSessao);
}

/**
 * Fase 6 — Preenche o bloco read-only com o relato ORIGINAL da assistência.
 */
function _preencherBlocoNotificador(caso) {
  const bloco = document.getElementById('invBlocoNotificador');
  if (!bloco) return;

  const temDados = caso.relatoNotificador || caso.condutaNotificador || caso.notifNome;
  if (caso.tipo !== 'DE' && !temDados) { bloco.classList.add('hidden'); return; }

  document.getElementById('invNotifRelato').textContent  = caso.relatoNotificador  || '—';
  document.getElementById('invNotifConduta').textContent = caso.condutaNotificador || '—';

  const partes = [];
  if (caso.notifNome)       partes.push('Notificado por: ' + caso.notifNome);
  if (caso.notifCategoria)  partes.push('(' + caso.notifCategoria + ')');
  if (caso.dataNotificacao) partes.push('em ' + caso.dataNotificacao);
  if (caso.notifEmail)      partes.push('· feedback: ' + caso.notifEmail);
  document.getElementById('invNotifMeta').textContent = partes.join(' ');

  bloco.classList.remove('hidden');
}

function _setSelectSeguro(id, valor) {
  const el = document.getElementById(id);
  if (!el || !valor) return;
  if ([...el.options].some(o => o.value === valor)) {
    el.value = valor;
  }
}

function _sinalizarFarmaceuticoAutopreenchido(auto) {
  const el = document.getElementById('invFarmaceutico');
  if (!el) return;
  if (auto) {
    el.classList.add('border-teal-400', 'bg-teal-50');
    el.title = 'Preenchido automaticamente com o farmacêutico responsável pelo setor (DB_Setores). Edite se necessário.';
  } else {
    el.classList.remove('border-teal-400', 'bg-teal-50');
    el.title = '';
  }
}

// ---------------------------------------------------------
// FECHAR MODAL
// ---------------------------------------------------------
function fecharModalInvestigacao() {
  if (_autosaveTimer) clearTimeout(_autosaveTimer);
  document.getElementById('modalInvestigacao').classList.add('hidden');
  _invIdAtual = '';
}

// ---------------------------------------------------------
// PROGRESSO
// ---------------------------------------------------------
function atualizarProgresso() {
  let preenchidos = 0;
  CAMPOS_PROGRESSO.forEach(id => {
    const el = document.getElementById(id);
    if (el && el.value && el.value.trim()) preenchidos++;
  });

  let narRespondidas = 0;
  document.querySelectorAll('.naranjo-select').forEach(s => {
    if (s.value !== '0') narRespondidas++;
  });
  if (narRespondidas >= 5) preenchidos = Math.min(preenchidos + 1, CAMPOS_PROGRESSO.length);

  const total = CAMPOS_PROGRESSO.length;
  const pct   = Math.round((preenchidos / total) * 100);

  document.getElementById('barraProgresso').style.width = pct + '%';
  document.getElementById('barraProgresso').className =
    'h-2 rounded-full transition-all duration-300 ' +
    (pct < 40 ? 'bg-red-400' : pct < 70 ? 'bg-yellow-400' : 'bg-green-500');

  document.getElementById('textoProgresso').textContent    = `${preenchidos} de ${total} campos`;
  document.getElementById('textoProgressoPct').textContent = `${pct}%`;
}

// ---------------------------------------------------------
// AUTOSAVE (debounce 2s) — memória em vez de localStorage
// ---------------------------------------------------------
function agendarAutosave() {
  if (_autosaveTimer) clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(_salvarRascunhoMemoria, 2000);
}

function _salvarRascunhoMemoria() {
  if (!_invIdAtual) return;
  _rascunhosEmMemoria.set(_invIdAtual, {
    ts:    Date.now(),
    dados: _coletarFormulario(false)
  });
  _mostrarIndicadorAutosave();
}

function _carregarRascunhoMemoria(id) {
  const entry = _rascunhosEmMemoria.get(id);
  if (!entry) return;

  const { dados } = entry;
  const mesclar = (elId, val) => {
    const el = document.getElementById(elId);
    if (el && val && !el.value) el.value = val;
  };
  mesclar('invHistoriaClinica', dados.historiaClinica);
  mesclar('invRelatoEvento',    dados.relatoEvento);
  mesclar('invExames',          dados.exames);
  mesclar('invFarmaceutico',    dados.farmaceutico);
  mesclar('invObservacoes',     dados.observacoes);
  mesclar('invLote',            dados.lote);
  mesclar('invLaboratorio',     dados.laboratorio);
  atualizarProgresso();
}

function _mostrarIndicadorAutosave() {
  const el = document.getElementById('autosaveStatus');
  if (!el) return;
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 2500);
}

// ---------------------------------------------------------
// COLETAR DADOS DO FORMULÁRIO
// ---------------------------------------------------------
function _coletarFormulario(encerrar) {
  const respNaranjo = Array.from(document.querySelectorAll('.naranjo-select'))
    .map(s => s.value).join('|');

  return {
    idCaso:          _invIdAtual,
    historiaClinica: document.getElementById('invHistoriaClinica').value,
    relatoEvento:    document.getElementById('invRelatoEvento').value,
    exames:          document.getElementById('invExames').value,
    readministrado:  document.getElementById('invReadministrado').value,
    evolucao:        document.getElementById('invEvolucao').value,
    desfecho:        document.getElementById('invDesfecho').value,
    conclusao:       document.getElementById('invConclusao').value,
    naranjo:         _classNaranjoFinal,
    naranjoRespostas: respNaranjo,
    gravidade:       document.getElementById('invGravidade').value,
    farmaceutico:    document.getElementById('invFarmaceutico').value,
    numVigimed:      document.getElementById('invNumVigimed').value,
    dataVigimed:     document.getElementById('invDataVigimed').value,
    observacoes:     document.getElementById('invObservacoes').value,
    lote:            (document.getElementById('invLote')        || {}).value || '',
    laboratorio:     (document.getElementById('invLaboratorio') || {}).value || '',

    // Fase 8 / Exportação E2B(R3)
    reacaoTermo:       (document.getElementById('invReacaoTermo')      || {}).value || '',
    doseMedicamento:   (document.getElementById('invDoseMedicamento')  || {}).value || '',
    doseUnidade:       (document.getElementById('invDoseUnidade')      || {}).value || '',
    viaAdministracao:  (document.getElementById('invViaAdministracao') || {}).value || '',
    dataInicioReacao:  (document.getElementById('invDataInicioReacao')|| {}).value || '',
    dataInicioAdministracao: (document.getElementById('invDataInicioAdministracao') || {}).value || '',
    nascimento:              (document.getElementById('invDataNascimento')          || {}).value || '',

    encerrar:        encerrar
  };
}

// ---------------------------------------------------------
// ENVIO COM VALIDAÇÃO INTELIGENTE
// ---------------------------------------------------------
function enviarInvestigacao(finalizar) {
  if (finalizar) {
    const obrigatorios = [
      { id: 'invHistoriaClinica',  label: 'História Clínica'          },
      { id: 'invRelatoEvento',     label: 'Relato do Evento'          },
      { id: 'invExames',           label: 'Exames Complementares'     },
      { id: 'invReadministrado',   label: 'Readministração'           },
      { id: 'invEvolucao',         label: 'Evolução'                  },
      { id: 'invGravidade',        label: 'Gravidade'                 },
      { id: 'invDesfecho',         label: 'Desfecho'                  },
      { id: 'invConclusao',        label: 'Conclusão'                 },
      { id: 'invFarmaceutico',     label: 'Farmacêutico(a)'           },
      { id: 'invReacaoTermo',      label: 'Reação (termo curto)'      },
      { id: 'invDoseMedicamento',  label: 'Dose'                      },
      { id: 'invDoseUnidade',      label: 'Unidade da Dose'           },
      { id: 'invViaAdministracao', label: 'Via de Administração'      },
      { id: 'invDataInicioReacao', label: 'Data de Início da Reação'  }
    ];
    const faltando = obrigatorios.filter(c => !document.getElementById(c.id).value);

    const narRespondidas = Array.from(document.querySelectorAll('.naranjo-select'))
      .filter(s => s.value !== '0').length;
    if (narRespondidas < 10) {
      mostrarToast('Para finalizar, responda todas as 10 perguntas do Algoritmo de Naranjo.', 'erro');
      return;
    }
    if (faltando.length > 0) {
      mostrarToast(`Para finalizar, preencha: ${faltando.map(c => c.label).join(', ')}.`, 'erro');
      faltando.forEach(c => {
        const el = document.getElementById(c.id);
        el.classList.add('border-red-400', 'ring-2', 'ring-red-200');
        el.addEventListener('change', () => {
          el.classList.remove('border-red-400', 'ring-2', 'ring-red-200');
        }, { once: true });
      });
      return;
    }
  }

  const btn = finalizar
    ? document.getElementById('btnFinalizar')
    : document.getElementById('btnRascunho');
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  btn.disabled  = true;

  google.script.run
    .withSuccessHandler(casoAtualizado => {
      btn.innerHTML = originalHtml;
      btn.disabled  = false;
      if (finalizar) _rascunhosEmMemoria.delete(_invIdAtual);
      fecharModalInvestigacao();
      atualizarCasoLocal(casoAtualizado);
      mostrarToast(finalizar ? 'Investigação finalizada.' : 'Rascunho salvo.', 'sucesso');
    })
    .withFailureHandler(err => {
      mostrarToast('Erro ao salvar: ' + err.message, 'erro');
      btn.innerHTML = originalHtml;
      btn.disabled  = false;
    })
    .registrarInvestigacao(_coletarFormulario(finalizar), tokenSessao);
}

// ---------------------------------------------------------
// EXPORTAÇÃO E2B(R3) — Fase 8
// ---------------------------------------------------------
function exportarE2B() {
  if (!_invIdAtual) return;

  const btn = document.getElementById('btnExportarE2B');
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  btn.disabled  = true;

  google.script.run
    .withSuccessHandler(resultado => {
      btn.innerHTML = originalHtml;
      btn.disabled  = false;

      if (resultado.avisos && resultado.avisos.length) {
        mostrarToast('XML gerado com avisos: ' + resultado.avisos.join(' | '), 'erro');
      } else {
        mostrarToast('XML E2B gerado: ' + resultado.nomeArquivo, 'sucesso');
      }

      // Download via Blob — google.script.run não retorna arquivo diretamente,
      // então construímos o Blob no cliente e disparamos o download.
      const blob = new Blob([resultado.xml], { type: 'application/xml' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = resultado.nomeArquivo;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    })
    .withFailureHandler(err => {
      btn.innerHTML = originalHtml;
      btn.disabled  = false;
      mostrarToast('Erro ao gerar E2B: ' + (err.message || err), 'erro');
    })
    .gerarXmlE2B(_invIdAtual, tokenSessao);
}
</script>
```

---

## 📄 Arquivo [19/32]: js_kanban.html

```html
<script>
// =========================================================
// js_kanban.html — v2.2
//
// ATUALIZAÇÃO DESTA VERSÃO:
//   B1 — construirCard() exibe iniciais do paciente e idade
//        calculada (a partir de data_nascimento) logo abaixo
//        do prontuário. Renderização condicional: se os campos
//        vierem como "N/I" ou vazios, a linha não é exibida
//        para não poluir cards de casos BA antigos.
//   B2 — Coluna "Em Investigação" não exibe mais badge de SLA.
//        Prazo regulatório vale só para a fase Triagem (entrada
//        do gatilho até avaliação inicial); investigação clínica
//        não tem prazo fixo institucional. Card mostra apenas
//        "Em análise desde <data>". Ordenação da coluna passa a
//        ser por data_evento (mais antigo primeiro, FIFO) em vez
//        de status de SLA. Filtro "Qualquer prazo" (filtroSLA)
//        passa a filtrar somente casos em Triagem.
//
// Depende de: js_core (escapeHtml, STATUS, calcularSLA,
//   badgeSLAHtml, casosGlobais, casosFiltrados, paginaAtual,
//   CARDS_POR_PAGINA, mapaSetorResponsavel, getFarmaceuticoPorSetor)
// Chama: abrirTriagem (js_triagem), abrirInvestigacao (js_investigacao)
// =========================================================

// ---------------------------------------------------------
// SKELETONS
// ---------------------------------------------------------
function mostrarSkeletons() {
  ['coluna-triagem', 'coluna-investigacao', 'coluna-concluidos'].forEach(id => {
    const col = document.getElementById(id);
    col.innerHTML = '';
    for (let i = 0; i < 4; i++) col.innerHTML += '<div class="skeleton skeleton-card"></div>';
  });
}

function limparSkeletons() {
  ['coluna-triagem', 'coluna-investigacao', 'coluna-concluidos'].forEach(id => {
    document.getElementById(id).innerHTML = '';
  });
}

// ---------------------------------------------------------
// FILTROS E BUSCA
// ---------------------------------------------------------
function limparFiltros() {
  document.getElementById('inputBusca').value          = '';
  document.getElementById('filtroSetor').value         = 'TODOS';
  document.getElementById('filtroFarmaceutico').value  = 'TODOS';
  document.getElementById('filtroSLA').value           = 'TODOS';
  document.getElementById('filtroDe').value            = '';
  document.getElementById('filtroAte').value           = '';
  processarFiltros();
}

function processarFiltros() {
  const busca     = document.getElementById('inputBusca').value.trim().toLowerCase();
  const setor     = document.getElementById('filtroSetor').value;
  const farmaceut = document.getElementById('filtroFarmaceutico').value;
  const slaFiltro = document.getElementById('filtroSLA').value;
  const dataDe    = document.getElementById('filtroDe').value;
  const dataAte   = document.getElementById('filtroAte').value;

  const casosFiltradosLocal = casosGlobais.filter(c => {
    if (busca) {
      const pront = String(c.prontuario   || '').toLowerCase();
      const med   = String(c.medicamento  || '').toLowerCase();
      const inic  = String(c.paciente     || '').toLowerCase();
      if (!pront.includes(busca) && !med.includes(busca) && !inic.includes(busca)) return false;
    }

    if (setor !== 'TODOS' && c.setor !== setor) return false;

    if (farmaceut !== 'TODOS') {
      const canonico = getFarmaceuticoPorSetor(c.setor);
      const doCaso   = (c.farmaceutico || '').trim();
      if (canonico !== farmaceut && doCaso !== farmaceut) return false;
    }

    // B2 — filtro de prazo agora só se aplica a casos em Triagem;
    // Investigação não tem SLA exibido, então não deve ser
    // afetada/escondida por este filtro.
    if (slaFiltro !== 'TODOS' && c.status === STATUS.TRIAGEM && calcularSLA(c).status !== slaFiltro) return false;

    if (dataDe || dataAte) {
      const p = (c.data_evento || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      if (p) {
        const dEv = new Date(parseInt(p[3]), parseInt(p[2]) - 1, parseInt(p[1]));
        if (dataDe && dEv < new Date(dataDe)) return false;
        if (dataAte && dEv > new Date(dataAte)) return false;
      }
    }

    return true;
  });

  const ordenarPorSLA = lista => lista.slice().sort((a, b) => {
    const ord = { VENCIDO: 0, VENCENDO: 1, SEM: 2, OK: 3 };
    return (ord[calcularSLA(a).status] ?? 4) - (ord[calcularSLA(b).status] ?? 4);
  });

  // B2 — Investigação ordena por data do evento (mais antigo primeiro),
  // já que não existe mais ranking por SLA nesta coluna.
  const ordenarPorDataEvento = lista => lista.slice().sort((a, b) => {
    const pa = new Date((a.data_evento || '').replace(/^(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1'));
    const pb = new Date((b.data_evento || '').replace(/^(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1'));
    return (isNaN(pa) ? 0 : pa) - (isNaN(pb) ? 0 : pb);
  });

  casosFiltrados.triagem      = ordenarPorSLA(casosFiltradosLocal.filter(c => c.status === STATUS.TRIAGEM));
  casosFiltrados.investigacao = ordenarPorDataEvento(casosFiltradosLocal.filter(c => c.status === STATUS.INVESTIGACAO));
  casosFiltrados.concluidos   = casosFiltradosLocal.filter(
    c => c.status === STATUS.CONCLUIDO || c.status === STATUS.DESCARTADO
  );

  document.getElementById('contadorResultados').textContent =
    `${casosFiltradosLocal.length} caso${casosFiltradosLocal.length !== 1 ? 's' : ''} exibido${casosFiltradosLocal.length !== 1 ? 's' : ''}`;

  paginaAtual.triagem = paginaAtual.investigacao = paginaAtual.concluidos = 1;
  renderizarColuna('triagem');
  renderizarColuna('investigacao');
  renderizarColuna('concluidos');

  if (!document.getElementById('view-dashboard').classList.contains('hidden')) {
    desenharGraficos();
  }
}

// ---------------------------------------------------------
// LAZY RENDER
// ---------------------------------------------------------
function renderizarColuna(tipo) {
  configurarDelegacaoKanban();
  const col   = document.getElementById(`coluna-${tipo}`);
  const casos = casosFiltrados[tipo];
  const slice = casos.slice(0, paginaAtual[tipo] * CARDS_POR_PAGINA);

  col.innerHTML = casos.length === 0
    ? construirEmptyState(tipo)
    : slice.map(c => construirCard(c)).join('');

  const idCont = {
    triagem:      'contador-triagem',
    investigacao: 'contador-investigacao',
    concluidos:   'contador-concluidos'
  }[tipo];
  document.getElementById(idCont).textContent = casos.length;

  const idBtn = {
    triagem:      'btnMaisTriagem',
    investigacao: 'btnMaisInvestigacao',
    concluidos:   'btnMaisConcluidos'
  }[tipo];
  const btn   = document.getElementById(idBtn);
  if (btn) {
    const restam = casos.length - slice.length;
    btn.classList.toggle('hidden', restam <= 0);
    if (restam > 0)
      btn.innerHTML = `<i class="fas fa-chevron-down mr-1"></i> Ver mais ${restam} casos`;
  }
}

function carregarMais(tipo) {
  paginaAtual[tipo]++;
  renderizarColuna(tipo);
}

// ---------------------------------------------------------
// EMPTY STATES
// ---------------------------------------------------------
function construirEmptyState(tipo) {
  const cfg = {
    triagem: {
      ico: 'fa-check-circle', cor: 'text-orange-300',
      titulo: 'Nenhum caso aguardando triagem',
      sub: 'Os gatilhos detectados pelo robô aparecerão aqui.'
    },
    investigacao: {
      ico: 'fa-search', cor: 'text-blue-300',
      titulo: 'Nenhum caso em investigação',
      sub: 'Casos triados como RAM serão movidos para cá.'
    },
    concluidos: {
      ico: 'fa-archive', cor: 'text-gray-400',
      titulo: 'Nenhum caso finalizado',
      sub: 'Casos concluídos ou descartados aparecerão aqui.'
    }
  };
  const c = cfg[tipo] || cfg.concluidos;
  return `
    <div class="flex flex-col items-center justify-center py-12 text-center">
      <i class="fas ${c.ico} text-4xl ${c.cor} mb-3"></i>
      <p class="font-semibold text-gray-500 text-sm">${c.titulo}</p>
      <p class="text-xs text-gray-400 mt-1 max-w-[180px]">${c.sub}</p>
    </div>`;
}

// ---------------------------------------------------------
// CONSTRUÇÃO DOS CARDS
//
// B1 — Exibe iniciais do paciente e idade calculada abaixo
//      do prontuário. Renderização condicional: só aparece
//      quando o dado está disponível (≠ "N/I" e ≠ vazio),
//      evitando poluição visual em casos BA antigos.
// B2 — SLA (badgeSLAHtml) só é calculado/exibido para casos
//      em STATUS.TRIAGEM. Investigação exibe tempo decorrido
//      neutro ("Em análise desde"), sem conotação de atraso.
// ---------------------------------------------------------
function construirCard(caso) {
  const isDE  = caso.tipo === 'DE';
  const id    = escapeHtml(caso.id);
  const tipo  = escapeHtml(caso.tipo);
  const pront = escapeHtml(caso.prontuario);
  const setor = escapeHtml(caso.setor);
  const med   = escapeHtml(caso.medicamento);
  const data  = escapeHtml(formatarDataExibicao(caso.data_evento)); // dd/MM/yyyy unificado (util em js_core)

  // B1 — Iniciais + idade
  const iniciais = (caso.paciente && caso.paciente !== 'N/I') ? caso.paciente : '';
  const idade    = _calcularIdade(caso.data_nascimento || caso.nascimento || '');
  const pacHtml  = (iniciais || idade)
    ? `<p class="text-[10px] text-gray-500 mt-0.5 truncate">
         ${iniciais ? `<span class="font-semibold">${escapeHtml(iniciais)}</span>` : ''}
         ${iniciais && idade ? ' · ' : ''}
         ${idade ? `<span>${escapeHtml(idade)}</span>` : ''}
       </p>`
    : '';

  // Farmacêutico canônico
  const farmaCanonica = getFarmaceuticoPorSetor(caso.setor);
  const farmaNome     = farmaCanonica || caso.farmaceutico || '';
  const farmaHtml     = farmaNome
    ? `<p class="text-[10px] text-gray-400 mt-1 truncate flex items-center gap-1">
         <i class="fas fa-user-md text-gray-300"></i>
         <span class="font-semibold">${escapeHtml(farmaNome)}</span>
       </p>`
    : '';

  // Badge de tipo: DE = roxo, BA = vermelho
  const tipoCss = isDE ? 'bg-purple-100 text-purple-800' : 'bg-red-100 text-red-800';
  const tipoIco = isDE ? 'fa-user-nurse'                 : 'fa-robot';

  const base = `
    <div class="kanban-card bg-white p-3 rounded-lg shadow-sm border border-gray-200 fade-in">
      <div class="flex justify-between items-start mb-2">
        <span class="${tipoCss} text-[10px] font-bold px-2 py-0.5 rounded-full uppercase flex items-center gap-1">
          <i class="fas ${tipoIco}"></i> ${tipo}
        </span>
        <span class="text-[10px] text-gray-400 font-semibold">${data}</span>
      </div>
      <h3 class="font-bold text-gray-800 text-sm">Pront: <span class="text-teal-700">${pront}</span></h3>
      ${pacHtml}
      <p class="text-xs text-gray-500 truncate">Setor: <span class="font-semibold text-gray-700">${setor}</span></p>`;

  if (caso.status === STATUS.TRIAGEM) {
    return base + `
      <p class="text-xs text-red-600 font-medium mt-1 truncate">
        <i class="fas fa-exclamation-circle mr-1"></i>Gatilho: ${med}
      </p>
      ${farmaHtml}
      <div class="mt-2">${badgeSLAHtml(caso)}</div>
      <button data-acao="triar" data-id="${id}"
        class="w-full bg-orange-500 hover:bg-orange-600 text-white text-xs font-bold py-1.5
               rounded-lg mt-3 shadow-sm transition flex items-center justify-center gap-1">
        Triar Caso <i class="fas fa-filter"></i>
      </button>
    </div>`;
  }

  if (caso.status === STATUS.INVESTIGACAO) {
    return base + `
      <p class="text-xs text-teal-700 font-bold mt-1 truncate">
        <i class="fas fa-pills mr-1"></i>Suspeito: ${med}
      </p>
      ${farmaHtml}
      <p class="text-[10px] text-gray-400 mt-2 flex items-center gap-1">
        <i class="fas fa-hourglass-half"></i> Em análise desde ${data}
      </p>
      <button data-acao="investigar" data-id="${id}"
        class="w-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold py-1.5
               rounded-lg mt-3 shadow-sm transition flex items-center justify-center gap-1">
        Investigar <i class="fas fa-microscope"></i>
      </button>
    </div>`;
  }

  // Concluído / Descartado
  const isDesc      = caso.status === STATUS.DESCARTADO;
  const stsCss      = isDesc ? 'text-gray-500' : 'text-green-700';
  const stsIco      = isDesc ? 'fa-ban'         : 'fa-check-circle';
  const conclusaoHtml = caso.conclusao
    ? `<p class="text-[10px] text-gray-400 mt-0.5">${escapeHtml(caso.conclusao)}</p>` : '';

  const vigimedHtml = (!isDesc)
    ? (caso.numVigimed
        ? `<span class="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full mt-2">
             <i class="fas fa-check-circle"></i> Importado VigiMed
           </span>`
        : `<span class="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full mt-2">
             <i class="fas fa-clock"></i> Pendente Importação VigiMed
           </span>`)
    : '';

  return base + `
    <p class="text-xs font-bold ${stsCss} mt-1 uppercase flex items-center gap-1">
      <i class="fas ${stsIco}"></i> ${escapeHtml(caso.status)}
    </p>
    ${conclusaoHtml}
    ${vigimedHtml}
    ${farmaHtml}
    <button data-acao="investigar" data-id="${id}"
      class="w-full bg-gray-200 hover:bg-gray-300 text-gray-600 text-xs font-bold py-1.5
             rounded-lg mt-3 shadow-sm transition flex items-center justify-center gap-1">
      Ver detalhes <i class="fas fa-eye"></i>
    </button>
  </div>`;
}

// ---------------------------------------------------------
// HELPER — calcula idade (duplicado de js_investigacao para
// manter independência de módulo, conforme arquitetura)
// ---------------------------------------------------------
function _calcularIdade(nascimento) {
  if (!nascimento || nascimento === 'N/I') return '';
  let d;
  const m1 = String(nascimento).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  const m2 = String(nascimento).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m1)      d = new Date(parseInt(m1[3]), parseInt(m1[2]) - 1, parseInt(m1[1]));
  else if (m2) d = new Date(parseInt(m2[1]), parseInt(m2[2]) - 1, parseInt(m2[3]));
  else         d = new Date(nascimento);
  if (isNaN(d)) return '';
  const hoje = new Date();
  let anos   = hoje.getFullYear() - d.getFullYear();
  const m    = hoje.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && hoje.getDate() < d.getDate())) anos--;
  if (anos < 0 || anos > 130) return '';
  return `${anos} anos`;
}

// ---------------------------------------------------------
// DELEGAÇÃO DE EVENTOS (configurada UMA vez)
// ---------------------------------------------------------
function configurarDelegacaoKanban() {
  if (delegacaoConfigurada) return;
  ['coluna-triagem', 'coluna-investigacao', 'coluna-concluidos'].forEach(idCol => {
    const col = document.getElementById(idCol);
    if (!col) return;
    col.addEventListener('click', ev => {
      const btn = ev.target.closest('button[data-acao]');
      if (!btn) return;
      const id   = btn.getAttribute('data-id');
      const acao = btn.getAttribute('data-acao');
      if (acao === 'triar')     abrirTriagem(id);
      if (acao === 'investigar') abrirInvestigacao(id);
    });
  });
  delegacaoConfigurada = true;
}
</script>
```

---

## 📄 Arquivo [20/32]: js_notificacao_interna.html

```html
<script>
// =========================================================
// js_notificacao_interna.html — v1.0 (Fase C)
//
// NOVA FUNCIONALIDADE:
//   Modal de notificação de RAM direta no Kanban, acessível
//   ao farmacêutico autenticado sem sair do painel.
//   - Casos entram diretamente em STATUS.INVESTIGACAO (DE),
//     sem passar pela fila de triagem de trigger tools.
//   - Setor pré-populado pelo filtro ativo (se existir).
//   - Farmacêutico pré-preenchido com o nome da sessão (E2)
//     ou pelo mapa canônico do setor selecionado.
//   - Reutiliza salvarDemandaEspontanea() do backend, com
//     campo origem: "KANBAN" para rastreabilidade.
//   - Segue o padrão modular: sem lógica de negócio inline,
//     sem hardcode de status ou listas.
//
// Depende de: js_core (escapeHtml, mostrarToast, carregarCasos,
//             tokenSessao, getFarmaceuticoPorSetor, configGlobal)
// =========================================================

// ---------------------------------------------------------
// ABRIR MODAL
// ---------------------------------------------------------
function abrirNotificacaoInterna() {
  const modal = document.getElementById('modalNotificacaoInterna');
  if (!modal) return;

  // Reset completo do formulário
  document.getElementById('formNotificacaoInterna').reset();
  document.getElementById('niAreaErro').classList.add('hidden');

  // Pré-preencher setor pelo filtro ativo do Kanban
  const filtroSetorAtivo = document.getElementById('filtroSetor')?.value;
  const selectSetor      = document.getElementById('niSetor');

  // Popular select de setores via configGlobal (já carregado em _aplicarConfig)
  if (selectSetor) {
    selectSetor.innerHTML = '<option value="">Selecione o setor…</option>';
    const setores = (configGlobal && configGlobal.setores) ? configGlobal.setores : [];
    setores.forEach(s => {
      const opt = document.createElement('option');
      opt.value       = escapeHtml(s.setor);
      opt.textContent = s.setor;
      selectSetor.appendChild(opt);
    });
    // Pré-seleciona se filtro do Kanban estiver ativo
    if (filtroSetorAtivo && filtroSetorAtivo !== 'TODOS') {
      selectSetor.value = filtroSetorAtivo;
      _niAtualizarFarmaceutico(filtroSetorAtivo);
    }
  }

  // Pré-preencher farmacêutico com nome da sessão (E2) ou mapa canônico
  _niPreencherFarmaceutico('');

  modal.classList.remove('hidden');
  modal.classList.add('flex');

  // Foco no primeiro campo
  setTimeout(() => {
    const primeiro = document.getElementById('niProntuario');
    if (primeiro) primeiro.focus();
  }, 100);
}

// ---------------------------------------------------------
// FECHAR MODAL
// ---------------------------------------------------------
function fecharNotificacaoInterna() {
  const modal = document.getElementById('modalNotificacaoInterna');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

// ---------------------------------------------------------
// ATUALIZAR FARMACÊUTICO QUANDO SETOR MUDA
// ---------------------------------------------------------
function _niAtualizarFarmaceutico(setor) {
  const farmaCanonica = getFarmaceuticoPorSetor(setor);
  _niPreencherFarmaceutico(farmaCanonica);
}

function _niPreencherFarmaceutico(farmaCanonica) {
  const el        = document.getElementById('niFarmaceutico');
  const nomeLogado = sessionStorage.getItem('vigi_nome') || '';

  // Prioridade: 1. canônico do setor, 2. nome logado, 3. vazio
  const valor = farmaCanonica || nomeLogado;
  if (el) {
    el.value = valor;
    // Indicador visual se veio do mapa canônico
    if (farmaCanonica) {
      el.classList.add('border-teal-400', 'bg-teal-50');
      el.title = 'Farmacêutico responsável pelo setor (DB_Setores). Edite se necessário.';
    } else {
      el.classList.remove('border-teal-400', 'bg-teal-50');
      el.title = '';
    }
  }
}

// ---------------------------------------------------------
// ENVIO
// ---------------------------------------------------------
function enviarNotificacaoInterna(event) {
  event.preventDefault();

  // Coleta e validação básica
  const prontuario  = document.getElementById('niProntuario').value.trim();
  const iniciais    = document.getElementById('niIniciais').value.trim();
  const nascimento  = document.getElementById('niNascimento').value.trim();
  const setor       = document.getElementById('niSetor').value.trim();
  const dataEvento  = document.getElementById('niDataEvento').value.trim();
  const medicamento = document.getElementById('niMedicamento').value.trim();
  const descricao   = document.getElementById('niDescricao').value.trim();
  const condutas    = document.getElementById('niCondutas').value.trim();
  const farmaceutico = document.getElementById('niFarmaceutico').value.trim();

  const erros = [];
  if (!prontuario)  erros.push('Prontuário');
  if (!iniciais)    erros.push('Iniciais');
  if (!setor)       erros.push('Setor');
  if (!medicamento) erros.push('Medicamento');
  if (!descricao)   erros.push('Descrição do evento');

  if (erros.length > 0) {
    const elErro = document.getElementById('niAreaErro');
    elErro.textContent = `Preencha os campos obrigatórios: ${erros.join(', ')}.`;
    elErro.classList.remove('hidden');
    return;
  }

  document.getElementById('niAreaErro').classList.add('hidden');

  const btn = document.getElementById('btnEnviarNI');
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin mr-2"></i> Enviando…';
  btn.disabled  = true;

  // Monta payload compatível com salvarDemandaEspontanea()
  // Campo extra "origem: KANBAN" para rastreabilidade no log
  const dados = {
    prontuario:            prontuario,
    iniciais:              iniciais,
    nascimento:            nascimento,
    setor:                 setor,
    dataEvento:            dataEvento,
    medicamento:           medicamento,
    descricao:             descricao,
    condutas:              condutas,
    // notificador = farmacêutico logado (campo reutilizado)
    notificador:           farmaceutico || sessionStorage.getItem('vigi_nome') || '',
    categoriaProfissional: 'Farmacêutico',
    // Marca de origem para diferenciar no log
    origem:                'KANBAN'
  };

  google.script.run
    .withSuccessHandler(() => {
      btn.innerHTML = originalHtml;
      btn.disabled  = false;
      fecharNotificacaoInterna();
      mostrarToast(`Caso DE registrado para prontuário ${prontuario}. Já em investigação.`, 'sucesso');
      carregarCasos();
    })
    .withFailureHandler(err => {
      btn.innerHTML = originalHtml;
      btn.disabled  = false;
      const elErro  = document.getElementById('niAreaErro');
      elErro.textContent = 'Erro ao enviar: ' + (err.message || err);
      elErro.classList.remove('hidden');
    })
    .salvarDemandaEspontanea(dados);
}
</script>
```

---

## 📄 Arquivo [21/32]: js_triagem.html

```html
<script>
// =========================================================
// js_triagem.html — v2.2
//
// P1.2: enviarTriagem() agora usa atualizarCasoLocal() (merge local do
// caso retornado por registrarTriagem) em vez de carregarCasos() — elimina
// o full-scan de casos_ram após uma triagem pontual.
//
// Depende de: js_core (casosGlobais, mostrarToast, atualizarCasoLocal,
//             tokenSessao, escapeHtml)
// =========================================================

let _triagemIdAtual = '';

// ---------------------------------------------------------
// ABRIR MODAL
// ---------------------------------------------------------
function abrirTriagem(id) {
  const caso = casosGlobais.find(c => c.id === id);
  if (!caso) return;

  _triagemIdAtual = id;

  document.getElementById('trgProntuario').innerText = caso.prontuario;
  document.getElementById('trgSetor').innerText      = caso.setor;
  document.getElementById('trgGatilho').innerText    = caso.medicamento;
  document.getElementById('trgIniciais').innerText = caso.paciente || 'N/I';

  document.getElementById('formTriagem').reset();
  toggleFormTriagem(null);

  document.getElementById('modalTriagem').classList.remove('hidden');
}

// ---------------------------------------------------------
// FECHAR MODAL
// ---------------------------------------------------------
function fecharModalTriagem() {
  document.getElementById('modalTriagem').classList.add('hidden');
  _triagemIdAtual = '';
}

// ---------------------------------------------------------
// TOGGLE: exibe sub-formulário correto
// ---------------------------------------------------------
function toggleFormTriagem(isRam) {
  document.getElementById('trgAreaSim').classList.toggle('hidden', isRam !== true);
  document.getElementById('trgAreaNao').classList.toggle('hidden', isRam !== false);
  document.getElementById('trgMedSuspeito').required    = isRam === true;
  document.getElementById('trgMotivoDescarte').required = isRam === false;
}

// ---------------------------------------------------------
// ENVIO
// ---------------------------------------------------------
function enviarTriagem(e) {
  e.preventDefault();

  const radioChecked = document.querySelector('input[name="trgHouveRam"]:checked');
  if (!radioChecked) {
    mostrarToast('Selecione se houve RAM ou não.', 'erro');
    return;
  }

  const btn = document.getElementById('btnSalvarTriagem');
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>';
  btn.disabled  = true;

  const dados = {
    idCaso:         _triagemIdAtual,
    houveRam:       radioChecked.value === 'SIM',
    medSuspeito:    document.getElementById('trgMedSuspeito').value,
    motivoDescarte: document.getElementById('trgMotivoDescarte').value
  };

  google.script.run
    .withSuccessHandler(casoAtualizado => {
      fecharModalTriagem();
      btn.innerHTML = '<i class="fas fa-check mr-1"></i> Salvar e Enviar';
      btn.disabled  = false;
      atualizarCasoLocal(casoAtualizado);
      mostrarToast('Triagem registrada com sucesso.', 'sucesso');
    })
    .withFailureHandler(err => {
      mostrarToast('Erro na triagem: ' + err.message, 'erro');
      btn.innerHTML = '<i class="fas fa-check mr-1"></i> Salvar e Enviar';
      btn.disabled  = false;
    })
    .registrarTriagem(dados, tokenSessao);
}
</script>
```

---

## 📄 Arquivo [22/32]: Manuntenção.gs

```javascript
/**
 * @fileoverview Manutencao.gs — utilitários administrativos de uso pontual.
 * NÃO é chamado pelo frontend. Rodar manualmente pelo editor do Apps Script.
 *
 * limparCasosAntigos_dryRun() — lista o que SERIA apagado, sem apagar nada.
 * limparCasosAntigos(confirmar) — apaga de fato. Exige confirmar === true.
 *
 * Critério: mantém casos_ram cujo data_evento é HOJE (fuso do script).
 * Todo o resto (Firestore + linha espelhada em DB_Casos_RAM) é removido.
 * log_auditoria NÃO é tocado — trilha LGPD/Vigimed preservada.
 */

function _hojeDDMMAAAA_() {
  const hoje = new Date();
  const dd = String(hoje.getDate()).padStart(2, '0');
  const mm = String(hoje.getMonth() + 1).padStart(2, '0');
  const aaaa = hoje.getFullYear();
  return `${dd}/${mm}/${aaaa}`;
}

function _casosForaDeHoje_() {
  const hojeStr = _hojeDDMMAAAA_();
  const todos = fsListarTodos_(SCHEMA.FS.CASOS);
  return todos.filter(c => {
    // CORREÇÃO CRÍTICA: no Firestore o campo chama-se `data` (ver objetoCaso em
    // Cases.gs/Ingest.gs). `data_evento` é apenas o nome MAPEADO para o frontend
    // (_mapearCasoResumo_). A versão anterior lia c.data_evento — sempre
    // undefined — logo TODO caso era classificado como "fora de hoje" e
    // limparCasosAntigos(true) apagaria 100% da base, inclusive os de hoje.
    // O campo pode ser Date (ETL/DE antigos) ou string 'dd/MM/yyyy HH:mm'.
    const bruto = c.data;
    const dataEvento = (bruto instanceof Date)
      ? Utilities.formatDate(bruto, Session.getScriptTimeZone(), 'dd/MM/yyyy')
      : String(bruto || '');
    return !dataEvento.startsWith(hojeStr);
  });
}

/** PASSO 1 — SEMPRE rodar isto primeiro. Só loga, não apaga nada. */
function limparCasosAntigos_dryRun() {
  const foraDeHoje = _casosForaDeHoje_();
  Logger.log(`Hoje: ${_hojeDDMMAAAA_()}`);
  Logger.log(`Total em casos_ram: ${fsListarTodos_(SCHEMA.FS.CASOS).length}`);
  Logger.log(`Seriam apagados (fora de hoje): ${foraDeHoje.length}`);
  foraDeHoje.forEach(c => {
    Logger.log(`  - ${c._id} | ${c.data_evento} | ${c.prontuario} | ${c.status}`);
  });
  return foraDeHoje.length;
}

/**
 * PASSO 2 — apaga de fato. Precisa chamar com confirmar === true.
 * Remove do Firestore (casos_ram) e a linha correspondente em DB_Casos_RAM
 * (planilha espelho), casando pelo ID_CASO (SCHEMA.COL.ID).
 */
function limparCasosAntigos(confirmar) {
  if (confirmar !== true) {
    throw new Error('Chame limparCasosAntigos(true) explicitamente para confirmar a exclusão. ' +
                     'Rode limparCasosAntigos_dryRun() antes para conferir o que será apagado.');
  }

  const foraDeHoje = _casosForaDeHoje_();
  const total = foraDeHoje.length;
  Logger.log(`Iniciando exclusão de ${total} casos (mantendo apenas data_evento = ${_hojeDDMMAAAA_()})`);

  const planilha = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SCHEMA.ABAS.CASOS);
  let apagados = 0;
  let falhas = 0;

  foraDeHoje.forEach(caso => {
    try {
      // 1. Apaga no Firestore
      fsDeleteDoc_(SCHEMA.FS.CASOS, caso._id);

      // 2. Apaga a linha espelho na planilha, se existir
      // CORREÇÃO: localizarLinhaCaso_ retorna -1 quando não encontra, e -1 é
      // truthy — a versão anterior chamava deleteRow(-1) e lançava exceção
      // (contava falha DEPOIS do doc Firestore já ter sido apagado).
      // Também sob comTrava_ (Regra de Ouro #2): deleteRow desloca índices e
      // pode colidir com o Mirror/ETL escrevendo na mesma aba.
      if (planilha) {
        comTrava_(function () {
          const linha = localizarLinhaCaso_(planilha, caso._id); // Utils.gs — TextFinder
          if (linha > 0) planilha.deleteRow(linha);
        });
      }

      apagados++;
    } catch (e) {
      falhas++;
      Logger.log(`FALHA ao apagar ${caso._id}: ${e.message}`);
    }
  });

  invalidarCasosCache_(); // P1.1 — cache do Kanban reflete a limpeza imediatamente

  // Log de auditoria da própria operação de limpeza (log_auditoria preservado)
  fsRegistrarLog_('LIMPEZA_MASSA', 'N/A',
    `Limpeza de base: ${apagados} casos removidos, ${falhas} falhas. Critério: data_evento != ${_hojeDDMMAAAA_()}`);

  Logger.log(`Concluído: ${apagados} apagados, ${falhas} falhas.`);
  return { apagados, falhas };
}

/** * PASSO 3 — Função auxiliar para disparar a limpeza pelo Editor.
 * Selecione esta função no menu superior e clique em Executar.
 */
function EXECUTAR_LIMPEZA_DE_FATO() {
  // Passa o parâmetro "true" exigido pela trava de segurança
  limparCasosAntigos(true);
}

```

---

## 📄 Arquivo [23/32]: Migracao schemae2b.gs

```javascript
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
```

---

## 📄 Arquivo [24/32]: MigracaoFirestore.gs

```javascript
/**
 * @fileoverview MigracaoFirestore.gs — Migração Sheets → Firestore (Fase 3/4).
 *
 * ORDEM DE EXECUÇÃO (do menor para o maior risco — ver plano de migração):
 *   1. migrarConfigGeralParaFirestore(dryRun)
 *   2. migrarSetoresParaFirestore(dryRun)
 *   3. migrarListasParaFirestore(dryRun)
 *   4. migrarNaranjoParaFirestore(dryRun)
 *   5. migrarUsuariosParaFirestore(dryRun)
 *   6. migrarCasosParaFirestore(dryRun)   ← NÚCLEO, rodar por último
 *
 * PADRÃO (idêntico ao já usado em migrarSenhasParaHash / migrarSchemaNotificador_v1):
 *   - dryRun=true (default): NÃO grava nada, só relata no Logger o que faria.
 *   - dryRun=false: aplica de fato.
 *   - Idempotente: documentos já existentes no Firestore com o mesmo ID são
 *     sobrescritos (fsSetDoc_ faz upsert), então rodar de novo não duplica.
 *   - A planilha original NUNCA é alterada por este script — é só leitura.
 *
 * IMPORTANTE: Sheets continua sendo a fonte de verdade até a Fase 4 (corte)
 * ser concluída e validada. Não desligue o Sheets antes de validar os dados
 * migrados no Firestore Console manualmente.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1) DB_Config_Geral (chave/valor) → coleção config_geral
// ─────────────────────────────────────────────────────────────────────────────

function migrarConfigGeralParaFirestore(dryRun) {
  const simular = dryRun !== false;
  const plan = getSheet_(SCHEMA.ABAS.GERAL);
  if (!plan) {
    Logger.log('migrarConfigGeralParaFirestore_: aba DB_Config_Geral não existe, nada a migrar.');
    return { migrados: 0, simulado: simular };
  }

  const dados = plan.getDataRange().getValues();
  let migrados = 0;

  for (let i = 1; i < dados.length; i++) {
    const chave = String(dados[i][0] || '').trim();
    const valor = String(dados[i][1] || '').trim();
    if (!chave) continue;

    if (simular) {
      Logger.log('Migraria config_geral/%s → { valor: "%s" }', chave, valor);
    } else {
      fsSetDoc_(SCHEMA.FS.GERAL, chave, { chave: chave, valor: valor });
    }
    migrados++;
  }

  Logger.log('%s — DB_Config_Geral: %s linha(s) migrada(s)', simular ? 'DRY-RUN' : 'APLICADO', migrados);
  return { migrados: migrados, simulado: simular };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) DB_Setores → coleção setores
// ─────────────────────────────────────────────────────────────────────────────

function migrarSetoresParaFirestore(dryRun) {
  const simular = dryRun !== false;
  const plan = getSheet_(SCHEMA.ABAS.SETORES);
  if (!plan) {
    Logger.log('migrarSetoresParaFirestore: aba DB_Setores não existe, nada a migrar.');
    return { migrados: 0, simulado: simular };
  }

  const dados = plan.getDataRange().getValues();
  const CS = SCHEMA.COL_SETORES;
  let migrados = 0;

  for (let i = 1; i < dados.length; i++) {
    const linha = dados[i];
    const setor = String(linha[CS.SETOR - 1] || '').trim();
    if (!setor) continue;

    const ativo        = String(linha[CS.ATIVO - 1] || 'SIM').trim().toUpperCase();
    const farmaceutico = String(linha[CS.FARMACEUTICO_RESPONSAVEL - 1] || '').trim();
    const email         = String(linha[CS.EMAIL_RESPONSAVEL - 1] || '').trim();

    // ID do documento: slug do setor + slug do e-mail. Setores como "TODOS"
    // podem ter múltiplas linhas (farmacêuticos diferentes recebendo alerta
    // de todos os setores) — usar só o nome do setor como ID causaria
    // colisão e sobrescrita silenciosa, perdendo registros. Setor+e-mail
    // garante unicidade preservando os 9 farmacêuticos de "TODOS", por ex.
    const slugSetor = setor.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');
    const slugEmail = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const idDoc = slugEmail ? (slugSetor + '__' + slugEmail) : slugSetor;

    const objeto = {
      setor: setor,
      ativo: ativo,
      farmaceuticoResponsavel: farmaceutico,
      emailResponsavel: email
    };

    if (simular) {
      Logger.log('Migraria setores/%s → %s', idDoc, JSON.stringify(objeto));
    } else {
      fsSetDoc_(SCHEMA.FS.SETORES, idDoc, objeto);
    }
    migrados++;
  }

  Logger.log('%s — DB_Setores: %s linha(s) migrada(s)', simular ? 'DRY-RUN' : 'APLICADO', migrados);
  return { migrados: migrados, simulado: simular };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) DB_Listas → coleção listas
//    Estrutura original: campo | opcao | ordem | ativo (uma linha por opção)
//    No Firestore, agrupamos por campo: 1 documento por campo, com array
//    de opções já ordenado — leitura mais eficiente que N linhas soltas.
// ─────────────────────────────────────────────────────────────────────────────

function migrarListasParaFirestore(dryRun) {
  const simular = dryRun !== false;
  const plan = getSheet_(SCHEMA.ABAS.LISTAS);
  if (!plan) {
    Logger.log('migrarListasParaFirestore: aba DB_Listas não existe, nada a migrar.');
    return { migrados: 0, simulado: simular };
  }

  const dados = plan.getDataRange().getValues();
  const porCampo = {};

  for (let i = 1; i < dados.length; i++) {
    const campo = String(dados[i][0] || '').trim();
    const opcao = String(dados[i][1] || '').trim();
    const ordem = Number(dados[i][2]) || 999;
    const ativo = String(dados[i][3] || 'SIM').trim().toUpperCase();
    if (!campo || !opcao) continue;
    if (ativo === 'NAO' || ativo === 'NÃO') continue;

    if (!porCampo[campo]) porCampo[campo] = [];
    porCampo[campo].push({ opcao: opcao, ordem: ordem });
  }

  let migrados = 0;
  Object.keys(porCampo).forEach(function (campo) {
    const opcoesOrdenadas = porCampo[campo]
      .sort(function (a, b) { return a.ordem - b.ordem; })
      .map(function (o) { return o.opcao; });

    const objeto = { campo: campo, opcoes: opcoesOrdenadas };

    if (simular) {
      Logger.log('Migraria listas/%s → %s', campo, JSON.stringify(objeto));
    } else {
      fsSetDoc_(SCHEMA.FS.LISTAS, campo, objeto);
    }
    migrados++;
  });

  Logger.log('%s — DB_Listas: %s campo(s) migrado(s)', simular ? 'DRY-RUN' : 'APLICADO', migrados);
  return { migrados: migrados, simulado: simular };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) DB_Naranjo → coleção naranjo (documento único com array de perguntas,
//    pois a lógica de negócio exige exatamente as 10 perguntas em ordem)
// ─────────────────────────────────────────────────────────────────────────────

function migrarNaranjoParaFirestore(dryRun) {
  const simular = dryRun !== false;
  const plan = getSheet_(SCHEMA.ABAS.NARANJO);
  if (!plan) {
    Logger.log('migrarNaranjoParaFirestore: aba DB_Naranjo não existe, nada a migrar (sistema usará DEFAULT_NARANJO).');
    return { migrados: 0, simulado: simular };
  }

  const dados = plan.getDataRange().getValues();
  const perguntas = [];

  // Colunas esperadas: ordem | pergunta | peso_sim | peso_nao | peso_ns
  for (let i = 1; i < dados.length; i++) {
    const pergunta = String(dados[i][1] || '').trim();
    if (!pergunta) continue;
    perguntas.push({
      pergunta: pergunta,
      sim: Number(dados[i][2]) || 0,
      nao: Number(dados[i][3]) || 0,
      ns:  Number(dados[i][4]) || 0
    });
  }

  if (perguntas.length !== 10) {
    Logger.log('migrarNaranjoParaFirestore: AVISO — aba tem %s pergunta(s), esperado 10. Migração abortada por segurança.', perguntas.length);
    return { migrados: 0, simulado: simular, abortado: true };
  }

  const objeto = { perguntas: perguntas };

  if (simular) {
    Logger.log('Migraria naranjo/algoritmo_padrao → %s', JSON.stringify(objeto));
  } else {
    fsSetDoc_(SCHEMA.FS.NARANJO, 'algoritmo_padrao', objeto);
  }

  Logger.log('%s — DB_Naranjo: 1 documento (10 perguntas) migrado', simular ? 'DRY-RUN' : 'APLICADO');
  return { migrados: 1, simulado: simular };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) DB_Usuarios → coleção usuarios
//    ATENÇÃO: contém hash de senha. Migração não altera o hash (copia como
//    está) — login continua funcionando igual após o corte.
// ─────────────────────────────────────────────────────────────────────────────

function migrarUsuariosParaFirestore(dryRun) {
  const simular = dryRun !== false;
  const plan = getSheetOuErro_(SCHEMA.ABAS.USUARIOS);
  const dados = plan.getDataRange().getValues();
  const CU = SCHEMA.COL_USUARIOS;
  let migrados = 0;

  for (let i = 1; i < dados.length; i++) {
    const email = String(cel(dados[i], CU.EMAIL) || '').trim().toLowerCase();
    if (!email) continue;

    const objeto = {
      email: email,
      senhaHash: String(cel(dados[i], CU.SENHA) || '').trim(),
      nome: String(cel(dados[i], CU.NOME) || '').trim(),
      ativo: String(cel(dados[i], CU.ATIVO) || 'SIM').trim().toUpperCase(),
      perfil: String(cel(dados[i], CU.PERFIL) || '').trim().toUpperCase()
    };

    // ID do documento = e-mail (lookup direto O(1) no login, sem query)
    if (simular) {
      Logger.log('Migraria usuarios/%s → { nome: "%s", perfil: "%s", ativo: "%s" } (senha omitida do log)',
        email, objeto.nome, objeto.perfil, objeto.ativo);
    } else {
      fsSetDoc_(SCHEMA.FS.USUARIOS, email, objeto);
    }
    migrados++;
  }

  Logger.log('%s — DB_Usuarios: %s usuário(s) migrado(s)', simular ? 'DRY-RUN' : 'APLICADO', migrados);
  return { migrados: migrados, simulado: simular };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6) DB_Casos_RAM → coleção casos_ram (NÚCLEO — rodar por último, com cautela)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Migra todos os casos. Usa o ID do caso (coluna SCHEMA.COL.ID) como ID do
 * documento Firestore — preserva os mesmos IDs já em uso pelo ETL/PowerShell,
 * então o robô não precisa de nenhuma alteração.
 *
 * SEGURANÇA: roda em lotes de fsLOTE_TAMANHO documentos por vez (evita
 * estourar o limite de tempo de execução do GAS em planilhas grandes).
 * Se a planilha tiver mais linhas que cabem em uma execução, rode de novo —
 * é idempotente, vai pular o que já foi migrado checando o parâmetro
 * `continuarDe` (índice de linha 1-based para retomar).
 */
const FS_MIGRACAO_LOTE_TAMANHO = 200;

function migrarCasosParaFirestore(dryRun, continuarDe) {
  const simular = dryRun !== false;
  const inicioLinha = continuarDe || 2; // linha 1 é cabeçalho

  const plan = getSheetOuErro_(SCHEMA.ABAS.CASOS);
  const ultimaLinha = plan.getLastRow();
  if (ultimaLinha < 2) {
    Logger.log('migrarCasosParaFirestore: planilha sem dados.');
    return { migrados: 0, simulado: simular, concluido: true };
  }

  const C = SCHEMA.COL;
  const fimLinha = Math.min(inicioLinha + FS_MIGRACAO_LOTE_TAMANHO - 1, ultimaLinha);
  const dados = plan.getRange(inicioLinha, 1, fimLinha - inicioLinha + 1, SCHEMA.LARGURA).getValues();

  let migrados = 0;
  let pulados = 0;

  dados.forEach(function (linha) {
    const idCaso = String(cel(linha, C.ID) || '').trim();
    if (!idCaso) { pulados++; return; }

    const objeto = {
      id: idCaso,
      data: cel(linha, C.DATA),
      tipo: String(cel(linha, C.TIPO) || ''),
      prontuario: String(cel(linha, C.PRONTUARIO) || ''),
      iniciais: String(cel(linha, C.INICIAIS) || ''),
      nascimento: cel(linha, C.NASCIMENTO),
      sexo: String(cel(linha, C.SEXO) || ''),
      setor: String(cel(linha, C.SETOR) || ''),
      medicamento: String(cel(linha, C.MEDICAMENTO) || ''),
      status: String(cel(linha, C.STATUS) || ''),
      sla: String(cel(linha, C.SLA) || ''),

      motivoDescarte: String(cel(linha, C.MOTIVO_DESCARTE) || ''),
      historiaClinica: String(cel(linha, C.HISTORIA) || ''),
      relato: String(cel(linha, C.RELATO) || ''),
      exames: String(cel(linha, C.EXAMES) || ''),
      readministrado: String(cel(linha, C.READMINISTRADO) || ''),
      evolucao: String(cel(linha, C.EVOLUCAO) || ''),
      desfecho: String(cel(linha, C.DESFECHO) || ''),
      conclusao: String(cel(linha, C.CONCLUSAO) || ''),
      naranjo: cel(linha, C.NARANJO),
      gravidade: String(cel(linha, C.GRAVIDADE) || ''),
      farmaceutico: String(cel(linha, C.FARMACEUTICO) || ''),
      numVigimed: String(cel(linha, C.NUM_VIGIMED) || ''),
      dataVigimed: cel(linha, C.DATA_VIGIMED),
      observacoes: String(cel(linha, C.OBSERVACOES) || ''),
      naranjoRespostas: String(cel(linha, C.NARANJO_RESP) || ''),
      lote:        String(cel(linha, C.LOTE)        || ''),
      laboratorio: String(cel(linha, C.LABORATORIO) || ''),

      relatoNotificador: String(cel(linha, C.RELATO_NOTIFICADOR) || ''),
      condutaNotificador: String(cel(linha, C.CONDUTA_NOTIFICADOR) || ''),

      // PII do notificador isolada em sub-objeto — facilita eliminação seletiva LGPD
      notificador: {
        nome: String(cel(linha, C.NOTIF_NOME) || ''),
        categoria: String(cel(linha, C.NOTIF_CATEGORIA) || ''),
        email: String(cel(linha, C.NOTIF_EMAIL) || ''),
        dataNotificacao: cel(linha, C.DATA_NOTIFICACAO)
      },

      auditoria: {
        atualizadoPor: String(cel(linha, C.ATUALIZADO_POR) || ''),
        atualizadoEm: cel(linha, C.ATUALIZADO_EM)
      }
    };

    if (simular) {
      if (migrados < 3) {
        // Loga só os 3 primeiros em dry-run pra não poluir — confirma formato
        Logger.log('Migraria casos_ram/%s → %s', idCaso, JSON.stringify(objeto));
      }
    } else {
      fsSetDoc_(SCHEMA.FS.CASOS, idCaso, objeto);
    }
    migrados++;
  });

  const concluido = fimLinha >= ultimaLinha;
  Logger.log(
    '%s — DB_Casos_RAM: linhas %s a %s migradas (%s caso(s), %s pulado(s) por ID vazio). %s',
    simular ? 'DRY-RUN' : 'APLICADO',
    inicioLinha, fimLinha, migrados, pulados,
    concluido ? 'MIGRAÇÃO COMPLETA.' : 'Rode de novo com continuarDe=' + (fimLinha + 1) + ' para continuar.'
  );

  return { migrados: migrados, pulados: pulados, simulado: simular, concluido: concluido, proximaLinha: concluido ? null : fimLinha + 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// ORQUESTRADOR — roda as migrações de baixo risco em sequência (1 a 5)
// NÃO inclui migrarCasosParaFirestore de propósito — esse roda separado,
// manualmente, depois de validar os resultados das outras 5 no Console.
// ─────────────────────────────────────────────────────────────────────────────

function migrarTudoBaixoRisco(dryRun) {
  const simular = dryRun !== false;
  Logger.log('=== INICIANDO MIGRAÇÃO (baixo risco) — modo: %s ===', simular ? 'DRY-RUN' : 'APLICADO');

  const r1 = migrarConfigGeralParaFirestore(simular);
  const r2 = migrarSetoresParaFirestore(simular);
  const r3 = migrarListasParaFirestore(simular);
  const r4 = migrarNaranjoParaFirestore(simular);
  const r5 = migrarUsuariosParaFirestore(simular);

  Logger.log('=== MIGRAÇÃO (baixo risco) CONCLUÍDA ===');
  return { configGeral: r1, setores: r2, listas: r3, naranjo: r4, usuarios: r5 };
}


function _aplicarMigracaoBaixoRisco() {
  migrarTudoBaixoRisco(false);
}

function _aplicarMigracaoCasos() {
  migrarCasosParaFirestore(false);
}

function migrarSchemaDataTriagem_v1fal() {
  migrarSchemaDataTriagem_v1(false);
}

/** Cria o cabeçalho da coluna 45 (DATA_TRIAGEM) em DB_Casos_RAM. Idempotente. */
function migrarSchemaDataTriagem_v1(dryRun) {
  const simular = dryRun !== false;
  const aba = getSheetOuErro_(SCHEMA.ABAS.CASOS);
  const col = SCHEMA.COL.DATA_TRIAGEM;
  const atual = aba.getRange(1, col).getValue();
  if (atual) {
    Logger.log('Coluna %s já tem cabeçalho: "%s" — nada a fazer.', col, atual);
    return { alterado: false };
  }
  if (simular) {
    Logger.log('DRY-RUN: gravaria "DATA_TRIAGEM" na coluna %s, linha 1.', col);
    return { alterado: false, simulado: true };
  }
  comTrava_(function () { aba.getRange(1, col).setValue('DATA_TRIAGEM'); });
  Logger.log('Cabeçalho gravado.');
  return { alterado: true };
}
```

---

## 📄 Arquivo [25/32]: migration.gs

```javascript
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
```

---

## 📄 Arquivo [26/32]: Mirror.gs

```javascript
/**
 * @fileoverview Mirror.gs — Espelho Firestore → Google Sheets (auditoria LGPD).
 *
 * OBJETIVO: garantir que toda escrita no Firestore (casos_ram, log_auditoria)
 * seja replicada nas abas DB_Casos_RAM e DB_Log do Sheets, mantendo o livro-
 * razão auditável sem depender de acesso ao console do Firebase.
 *
 * ARQUITETURA:
 *   1. Cada ponto de escrita em Cases.gs chama espelharCasoNoSheets_() após
 *      a escrita no Firestore.
 *   2. fsRegistrarLog_ chama espelharLogNoSheets_() após gravar no Firestore.
 *   3. Se a gravação no Sheets falhar, o payload é serializado em
 *      PropertiesService (fila MIRROR_RETRY_QUEUE) — máx. 50 itens / 9 KB.
 *   4. O trigger processarFilaEspelho() roda a cada 5 minutos e reprocessa
 *      os itens com falha em ordem FIFO, com até 3 tentativas por item.
 *      Após 3 falhas o item é descartado, registrado em console.error e
 *      um alerta é enviado por e-mail à coordenação (ver RETIFICAÇÃO abaixo).
 *
 * INTEGRAÇÃO — pontos de chamada já presentes em Cases.gs / Firestore.gs / Ingest.gs:
 *
 *   salvarDemandaEspontanea():
 *     após fsSetDoc_(SCHEMA.FS.CASOS, idCaso, objetoCaso)
 *     → espelharCasoNoSheets_(idCaso, objetoCaso, 'INSERT')
 *
 *   registrarTriagem():
 *     após fsRunTransaction_() bem-sucedido
 *     → espelharCasoNoSheets_(dados.idCaso, null, 'UPDATE')
 *
 *   registrarInvestigacao():
 *     após fsRunTransaction_() bem-sucedido
 *     → espelharCasoNoSheets_(dados.idCaso, null, 'UPDATE')
 *
 *   Ingest.gs (handleInsertDB):
 *     após fsSetDoc_/fsUpdateDoc_ do caso ETL
 *     → espelharCasoNoSheets_(idCaso, objetoCaso, 'INSERT')
 *
 *   Firestore.gs (fsRegistrarLog_):
 *     após fsSetDoc_() do log
 *     → espelharLogNoSheets_(payload do log)
 *
 * CONFIGURAÇÃO DO TRIGGER:
 *   Rode instalarTriggerEspelho() UMA VEZ no editor do Apps Script.
 *   Para remover: removerTriggerEspelho().
 *   VERIFICAÇÃO: rode verificarTriggerEspelho() a qualquer momento para
 *   confirmar se o trigger está instalado (causa raiz nº1 de "fila nunca
 *   reprocessa" é esse trigger nunca ter sido criado).
 *
 * CONSTRAINT PropertiesService:
 *   Cada valor: máx 9 KB. A fila serializa um array JSON.
 *   Se o payload de um caso ultrapassar 9 KB (improvável para este schema),
 *   o item é descartado imediatamente com console.error.
 *
 * RETIFICAÇÃO [Regra de Ouro #2 — Concorrência]:
 *   _gravarCasoNoSheets/_gravarLogNoSheets gravavam DIRETO no Sheets sem
 *   passar por comTrava_(). Com 22 usuários + robô PowerShell escrevendo
 *   simultâneo, TextFinder podia localizar linha desatualizada ou dois
 *   appendRow concorrentes duplicavam/perdiam linha — falha silenciosa que
 *   ia parar na fila de retry e, sem trigger instalado, nunca era
 *   reprocessada. Agora espelharCasoNoSheets_/espelharLogNoSheets_ e o
 *   reprocessamento da fila encapsulam a gravação em comTrava_(), igual ao
 *   resto do sistema.
 *
 * RETIFICAÇÃO [Visibilidade]:
 *   Falha de mirror antes só ia para console.error (ninguém lê). Ao
 *   descartar um item após MIRROR_RETRY_MAX tentativas, agora dispara
 *   e-mail para getConfig().geral.EMAIL_COORDENACAO.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────────────────
const MIRROR_RETRY_KEY      = 'MIRROR_RETRY_QUEUE';
const MIRROR_RETRY_MAX      = 3;   // tentativas antes de descartar
const MIRROR_FILA_MAX_ITENS = 50;  // limite de itens na fila

// ─────────────────────────────────────────────────────────────────────────────
// PONTO DE ENTRADA — CASOS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Espelha um caso no DB_Casos_RAM do Sheets.
 * Chamado após cada escrita no Firestore em Cases.gs e Ingest.gs.
 *
 * @param {string} idCaso
 * @param {Object|null} dadosObjeto — objeto já montado (INSERT) ou null (UPDATE:
 *   relê do Firestore para garantir consistência do espelho).
 * @param {'INSERT'|'UPDATE'} operacao
 */
function espelharCasoNoSheets_(idCaso, dadosObjeto, operacao) {
  try {
    // Para UPDATE relê o documento atual do Firestore — garante que o espelho
    // reflete o estado pós-transação, não dados parciais do caller.
    const doc = dadosObjeto || fsGetDoc_(SCHEMA.FS.CASOS, idCaso);
    if (!doc) {
      console.warn('Mirror: caso não encontrado no Firestore para espelhar — ' + idCaso);
      return;
    }

    // [RETIFICADO] gravação no Sheets agora sob comTrava_ — evita corrida
    // com frontend/ETL escrevendo na mesma aba ao mesmo tempo (Regra de Ouro #2).
    comTrava_(function () {
      _gravarCasoNoSheets(idCaso, doc, operacao);
    });

  } catch (e) {
    console.error('Mirror [espelharCasoNoSheets_] falhou para ' + idCaso + ': ' + e.message);
    _enfileirarRetry({ tipo: 'CASO', idCaso: idCaso, operacao: operacao || 'UPDATE', tentativas: 0 });
  }
}

/**
 * Espelha um evento de log no DB_Log do Sheets.
 * Chamado dentro de fsRegistrarLog_() após a escrita no Firestore.
 *
 * @param {{ data, usuario, acao, idCaso, detalhe }} payload
 */
function espelharLogNoSheets_(payload) {
  try {
    // [RETIFICADO] idem — gravação de log também sob comTrava_.
    comTrava_(function () {
      _gravarLogNoSheets(payload);
    });
  } catch (e) {
    console.error('Mirror [espelharLogNoSheets_] falhou: ' + e.message);
    _enfileirarRetry({ tipo: 'LOG', payload: payload, tentativas: 0 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GRAVAÇÃO NO SHEETS — CASOS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grava ou atualiza uma linha em DB_Casos_RAM respeitando SCHEMA.COL.*.
 * INSERT: appendRow. UPDATE: localiza por ID (coluna 1) via TextFinder e
 * sobrescreve a linha inteira (exceto ID e DATA, imutáveis).
 * IMPORTANTE: já deve ser chamada de dentro de comTrava_() pelo caller
 * (espelharCasoNoSheets_ / processarFilaEspelho) — esta função não trava
 * sozinha para evitar lock aninhado.
 */
function _gravarCasoNoSheets(idCaso, doc, operacao) {
  const aba = getSheet_(SCHEMA.ABAS.CASOS);
  if (!aba) throw new Error('Aba ' + SCHEMA.ABAS.CASOS + ' não encontrada.');

  const tz  = Session.getScriptTimeZone();

  // Formata datas
  const fmtData = function (val) {
    if (!val) return '';
    if (val instanceof Date) return Utilities.formatDate(val, tz, 'dd/MM/yyyy HH:mm');
    return String(val).trim();
  };
  const fmtDataVigi = function (val) {
    if (!val) return '';
    if (val instanceof Date) return Utilities.formatDate(val, tz, 'yyyy-MM-dd');
    return String(val).trim();
  };

  const notif = doc.notificador || {};

  // Monta linha posicional conforme SCHEMA.COL (46 colunas, 1-based → índice 0-based)
  const linha = new Array(SCHEMA.LARGURA).fill('');
  linha[SCHEMA.COL.ID                 - 1] = String(doc.id           || idCaso).trim();
  linha[SCHEMA.COL.DATA               - 1] = fmtData(doc.data);
  linha[SCHEMA.COL.TIPO               - 1] = String(doc.tipo         || 'BA').trim();
  linha[SCHEMA.COL.NOTIF_NOME         - 1] = String(notif.nome       || '').trim();
  linha[SCHEMA.COL.NOTIF_CATEGORIA    - 1] = String(notif.categoria  || '').trim();
  linha[SCHEMA.COL.DATA_NOTIFICACAO   - 1] = fmtData(notif.dataNotificacao);
  linha[SCHEMA.COL.PRONTUARIO         - 1] = String(doc.prontuario   || '').trim();
  linha[SCHEMA.COL.INICIAIS           - 1] = String(doc.iniciais     || '').trim();
  linha[SCHEMA.COL.NASCIMENTO         - 1] = String(doc.nascimento   || '').trim();
  linha[SCHEMA.COL.SEXO               - 1] = String(doc.sexo         || '').trim();
  linha[SCHEMA.COL.SETOR              - 1] = String(doc.setor        || '').trim();
  linha[SCHEMA.COL.MEDICAMENTO        - 1] = String(doc.medicamento  || '').trim();
  linha[SCHEMA.COL.LOTE               - 1] = String(doc.lote != null && doc.lote !== '' ? doc.lote : (doc.loteLaboratorio || '')).trim();
  linha[SCHEMA.COL.LABORATORIO        - 1] = String(doc.laboratorio  || '').trim();
  linha[SCHEMA.COL.RELATO_NOTIFICADOR - 1] = String(doc.relatoNotificador  || '').trim();
  linha[SCHEMA.COL.CONDUTA_NOTIFICADOR- 1] = String(doc.condutaNotificador || '').trim();
  linha[SCHEMA.COL.STATUS             - 1] = String(doc.status        || '').trim();
  linha[SCHEMA.COL.SLA                - 1] = String(doc.sla           || '').trim();
  linha[SCHEMA.COL.MOTIVO_DESCARTE    - 1] = String(doc.motivoDescarte|| '').trim();
  linha[SCHEMA.COL.HISTORIA           - 1] = String(doc.historiaClinica||'').trim();
  linha[SCHEMA.COL.RELATO             - 1] = String(doc.relato        || '').trim();
  linha[SCHEMA.COL.EXAMES             - 1] = String(doc.exames        || '').trim();
  linha[SCHEMA.COL.READMINISTRADO     - 1] = String(doc.readministrado|| '').trim();
  linha[SCHEMA.COL.EVOLUCAO           - 1] = String(doc.evolucao      || '').trim();
  linha[SCHEMA.COL.DESFECHO           - 1] = String(doc.desfecho      || '').trim();
  linha[SCHEMA.COL.CONCLUSAO          - 1] = String(doc.conclusao     || '').trim();
  linha[SCHEMA.COL.NARANJO            - 1] = String(doc.naranjo       || '').trim();
  linha[SCHEMA.COL.GRAVIDADE          - 1] = String(doc.gravidade     || '').trim();
  linha[SCHEMA.COL.FARMACEUTICO       - 1] = String(doc.farmaceutico  || '').trim();
  linha[SCHEMA.COL.NUM_VIGIMED        - 1] = String(doc.numVigimed    || '').trim();
  linha[SCHEMA.COL.DATA_VIGIMED       - 1] = fmtDataVigi(doc.dataVigimed);
  linha[SCHEMA.COL.OBSERVACOES        - 1] = String(doc.observacoes   || '').trim();
  linha[SCHEMA.COL.NARANJO_RESP       - 1] = String(doc.naranjoRespostas || '').trim();
  linha[SCHEMA.COL.ATUALIZADO_POR     - 1] = String(doc.auditoria && doc.auditoria.atualizadoPor || '').trim();
  linha[SCHEMA.COL.ATUALIZADO_EM      - 1] = fmtData(doc.auditoria && doc.auditoria.atualizadoEm);
  linha[SCHEMA.COL.NOTIF_EMAIL        - 1] = String(notif.email || '').trim();
// ── Fase 8 / Exportação E2B(R3) ────────────────────────────────────────
  linha[SCHEMA.COL.REACAO_TERMO       - 1] = String(doc.reacaoTermo       || '').trim();
  linha[SCHEMA.COL.DOSE_MEDICAMENTO   - 1] = String(doc.doseMedicamento   || '').trim();
  linha[SCHEMA.COL.DOSE_UNIDADE       - 1] = String(doc.doseUnidade       || '').trim();
  linha[SCHEMA.COL.VIA_ADMINISTRACAO  - 1] = String(doc.viaAdministracao  || '').trim();
  linha[SCHEMA.COL.DATA_INICIO_REACAO - 1] = fmtData(doc.dataInicioReacao);
  linha[SCHEMA.COL.DATA_INICIO_ADM    - 1] = fmtDataVigi(doc.dataInicioAdministracao);
  linha[SCHEMA.COL.ID_REACAO_E2B      - 1] = String(doc.idReacaoE2B       || '').trim();
  linha[SCHEMA.COL.ID_MEDICAMENTO_E2B - 1] = String(doc.idMedicamentoE2B  || '').trim();
  linha[SCHEMA.COL.SAFETYREPORTID_E2B - 1] = String(doc.safetyReportIdE2B || '').trim();
  // ── Dashboard de Produtividade (revisão 07/2026) ─────────────────────────
  linha[SCHEMA.COL.DATA_TRIAGEM       - 1] = fmtData(doc.dataTriagem);
  if (operacao === 'INSERT') {
    aba.appendRow(linha);
    return;
  }

  // UPDATE — localiza linha existente por ID via TextFinder (O(1) com índice)
  const finder = aba.createTextFinder(idCaso)
    .matchEntireCell(true)
    .matchCase(false);
  const resultado = finder.findNext();

  if (resultado) {
    const numLinha = resultado.getRow();
    aba.getRange(numLinha, 1, 1, SCHEMA.LARGURA).setValues([linha]);
  } else {
    // Caso não existe no Sheets ainda (ex: migrado do Firestore sem espelho)
    // — insere como novo ao invés de perder a atualização.
    console.warn('Mirror: ID ' + idCaso + ' não encontrado no Sheets — inserindo como novo.');
    aba.appendRow(linha);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GRAVAÇÃO NO SHEETS — LOG
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IMPORTANTE: já deve ser chamada de dentro de comTrava_() pelo caller
 * (espelharLogNoSheets_ / processarFilaEspelho) — esta função não trava
 * sozinha para evitar lock aninhado.
 */
function _gravarLogNoSheets(payload) {
  const aba = getSheet_(SCHEMA.ABAS.LOG);
  if (!aba) {
    // DB_Log é opcional — se não existir, não falha nem enfileira
    console.warn('Mirror: aba ' + SCHEMA.ABAS.LOG + ' não existe — log não espelhado.');
    return;
  }

  const tz = Session.getScriptTimeZone();
  const dataStr = payload.data instanceof Date
    ? Utilities.formatDate(payload.data, tz, 'dd/MM/yyyy HH:mm:ss')
    : String(payload.data || new Date()).trim();

  aba.appendRow([
    dataStr,
    String(payload.usuario || '').trim(),
    String(payload.acao    || '').trim(),
    String(payload.idCaso  || '').trim(),
    String(payload.detalhe || '').trim()
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// FILA DE RETRY (PropertiesService)
// ─────────────────────────────────────────────────────────────────────────────

function _enfileirarRetry(item) {
  try {
    // [RETIFICADO — Regra de Ouro #2] o read-modify-write da fila em
    // PropertiesService era feito SEM trava: dois enfileiramentos simultâneos
    // (22 usuários + ETL) liam a mesma fila e o último setProperty vencia,
    // PERDENDO silenciosamente o item do outro. Idem entre _enfileirarRetry
    // e processarFilaEspelho. Agora toda mutação da fila é atômica sob
    // comTrava_ (LockService).
    // ATENÇÃO: _enfileirarRetry só é chamado FORA de um lock ativo
    // (nos catch de espelhar* — o comTrava_ interno já liberou no finally —
    // e no pós-processamento da fila). Não chamar de dentro de comTrava_:
    // LockService não é reentrante.
    comTrava_(function () {
      const props = PropertiesService.getScriptProperties();
      const raw   = props.getProperty(MIRROR_RETRY_KEY);
      const fila  = raw ? JSON.parse(raw) : [];

      if (fila.length >= MIRROR_FILA_MAX_ITENS) {
        console.error('Mirror: fila de retry cheia (' + MIRROR_FILA_MAX_ITENS + ' itens). Item descartado: ' + JSON.stringify(item));
        return;
      }

      fila.push(item);
      const serializado = JSON.stringify(fila);

      // PropertiesService: limite de 9 KB por valor
      if (serializado.length > 9000) {
        console.error('Mirror: fila excede 9 KB após adicionar item. Item descartado: ' + JSON.stringify(item));
        return;
      }

      props.setProperty(MIRROR_RETRY_KEY, serializado);
    });
  } catch (e) {
    console.error('Mirror: falha ao enfileirar retry: ' + e.message + ' | Item: ' + JSON.stringify(item));
  }
}

/**
 * Processa a fila de retry — chamado pelo trigger a cada 5 minutos.
 * Tenta reprocessar cada item; após MIRROR_RETRY_MAX falhas, descarta e
 * alerta a coordenação por e-mail.
 * Itens bem-sucedidos são removidos da fila.
 */
function processarFilaEspelho() {
  const props = PropertiesService.getScriptProperties();

  // [RETIFICADO] SNAPSHOT atômico: lê E ZERA a fila sob trava. A versão
  // anterior lia a fila, processava por minutos e regravava filaRestante no
  // final — qualquer item enfileirado nesse intervalo era SOBRESCRITO e
  // perdido. Agora: itens novos durante o processamento entram numa fila
  // limpa (via _enfileirarRetry, também sob trava) e itens que falharem aqui
  // são re-enfileirados por _enfileirarRetry (merge atômico), nunca por
  // setProperty cego.
  let fila = null;
  comTrava_(function () {
    const raw = props.getProperty(MIRROR_RETRY_KEY);
    if (!raw) return;
    try { fila = JSON.parse(raw); } catch (e) {
      console.error('Mirror: fila corrompida — limpando. Erro: ' + e.message);
    }
    props.deleteProperty(MIRROR_RETRY_KEY);
  });

  if (!fila || !fila.length) return;

  const filaRestante = [];

  fila.forEach(function (item) {
    try {
      if (item.tipo === 'CASO') {
        // Relê do Firestore para garantir estado atual (pode ter mudado desde o enfileiramento)
        const doc = fsGetDoc_(SCHEMA.FS.CASOS, item.idCaso);
        if (!doc) throw new Error('Caso não encontrado no Firestore: ' + item.idCaso);
        // [RETIFICADO] gravação sob comTrava_
        comTrava_(function () {
          _gravarCasoNoSheets(item.idCaso, doc, item.operacao || 'UPDATE');
        });
        console.log('Mirror retry OK: CASO ' + item.idCaso);

      } else if (item.tipo === 'LOG') {
        // [RETIFICADO] gravação sob comTrava_
        comTrava_(function () {
          _gravarLogNoSheets(item.payload);
        });
        console.log('Mirror retry OK: LOG ' + (item.payload && item.payload.acao));

      } else {
        console.warn('Mirror: tipo de item desconhecido na fila — descartado: ' + JSON.stringify(item));
        return; // descarta sem recolocar
      }

    } catch (e) {
      item.tentativas = (item.tentativas || 0) + 1;
      if (item.tentativas >= MIRROR_RETRY_MAX) {
        console.error('Mirror: item descartado após ' + MIRROR_RETRY_MAX + ' tentativas: ' + JSON.stringify(item) + ' | Erro: ' + e.message);
        _alertarDescarteFinal_(item, e.message);
      } else {
        console.warn('Mirror retry falhou (tentativa ' + item.tentativas + '/' + MIRROR_RETRY_MAX + '): ' + e.message);
        filaRestante.push(item);
      }
    }
  });

  // Re-enfileira as falhas via _enfileirarRetry (merge atômico com itens
  // que possam ter chegado durante o processamento) — nunca setProperty cego.
  filaRestante.forEach(function (item) { _enfileirarRetry(item); });
}

/**
 * [NOVO — RETIFICAÇÃO Visibilidade] Alerta por e-mail quando um item é
 * descartado definitivamente da fila de retry. Sem isso a falha do espelho
 * era 100% silenciosa (só console.error, que ninguém consulta).
 * Falha ao enviar o e-mail não deve derrubar o processamento da fila —
 * por isso tem try/catch próprio.
 */
function _alertarDescarteFinal_(item, mensagemErro) {
  try {
    const cfg = getConfig();
    const destino = (cfg.geral && cfg.geral.EMAIL_COORDENACAO) || 'farmacia.clinica@hospital.com';
    const idRef = item.idCaso || (item.payload && item.payload.idCaso) || '-';

    MailApp.sendEmail({
      to: destino,
      subject: '[VigiRAM] Falha permanente no espelho Sheets (' + item.tipo + ')',
      body:
        'Um item foi descartado da fila de retry do Mirror após ' + MIRROR_RETRY_MAX + ' tentativas.\n\n' +
        'Tipo: ' + item.tipo + '\n' +
        'ID do caso: ' + idRef + '\n' +
        'Erro: ' + mensagemErro + '\n\n' +
        'Ação recomendada: verificar manualmente se o caso está correto no Firestore ' +
        'e, se necessário, rodar sincronizarTodosOsCasosParaSheets(false) para reconciliar.'
    });
  } catch (e) {
    console.error('Mirror: falha ao enviar alerta de descarte final: ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INSTALAÇÃO DO TRIGGER (rodar UMA VEZ no editor)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Instala o trigger que roda processarFilaEspelho() a cada 5 minutos.
 * Rode manualmente no editor do Apps Script: selecione esta função → Executar.
 * Idempotente: não cria duplicatas se já existir.
 */
function instalarTriggerEspelho() {
  const existentes = ScriptApp.getProjectTriggers();
  const jaExiste = existentes.some(function (t) {
    return t.getHandlerFunction() === 'processarFilaEspelho';
  });

  if (jaExiste) {
    Logger.log('Trigger processarFilaEspelho já instalado — nenhuma ação necessária.');
    return;
  }

  ScriptApp.newTrigger('processarFilaEspelho')
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log('✅ Trigger instalado: processarFilaEspelho a cada 5 minutos.');
}

/** Remove o trigger (use para manutenção ou desativação do espelho). */
function removerTriggerEspelho() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'processarFilaEspelho'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('Trigger processarFilaEspelho removido.');
}

/**
 * [NOVO] Confirma se o trigger de retry está instalado — rode manualmente
 * no editor sempre que suspeitar que o espelho parou de reprocessar falhas.
 */
function verificarTriggerEspelho() {
  const instalado = ScriptApp.getProjectTriggers()
    .some(function (t) { return t.getHandlerFunction() === 'processarFilaEspelho'; });
  Logger.log(instalado
    ? '✅ Trigger processarFilaEspelho está instalado.'
    : '⚠️ Trigger processarFilaEspelho NÃO está instalado — rode instalarTriggerEspelho().');
  return instalado;
}

// ─────────────────────────────────────────────────────────────────────────────
// SINCRONIZAÇÃO INICIAL (migração retroativa)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sincroniza TODOS os casos do Firestore para o Sheets de uma vez.
 * Use após instalar o Mirror para sincronizar o histórico existente.
 * Seguro de rodar múltiplas vezes — usa UPDATE (TextFinder) que sobrescreve
 * ou insere se não existir.
 *
 * @param {boolean} dryRun — true: só loga, não grava (padrão: true)
 */
function sincronizarTodosOsCasosParaSheets(dryRun) {
  const modo = (dryRun !== false);
  Logger.log('=== Sincronização Mirror: modo ' + (modo ? 'DRY-RUN' : 'APLICADO') + ' ===');

  const docs = fsListarTodos_(SCHEMA.FS.CASOS);
  Logger.log(docs.length + ' caso(s) encontrados no Firestore.');

  let ok = 0, erros = 0;

  docs.forEach(function (doc) {
    const id = doc.id || doc._id;
    if (!id) return;
    try {
      // [RETIFICADO] gravação sob comTrava_ também na sincronização em massa
      if (!modo) comTrava_(function () { _gravarCasoNoSheets(id, doc, 'UPDATE'); });
      ok++;
    } catch (e) {
      erros++;
      console.error('Sincronização: erro no caso ' + id + ': ' + e.message);
    }
  });

  Logger.log('Resultado: ' + ok + ' OK, ' + erros + ' erro(s).');
  if (modo) Logger.log('Dry-run concluído. Para aplicar, chame sincronizarTodosOsCasosParaSheets(false).');
  else Logger.log('Sincronização aplicada ao DB_Casos_RAM.');
}

/** Wrapper para execução manual no editor — DRY RUN (só loga, não grava) */
function sincronizarDryRun() {
  sincronizarTodosOsCasosParaSheets(true);
}

/** Wrapper para execução manual no editor — APLICA a sincronização no Sheets */
function sincronizarAplicado() {
  sincronizarTodosOsCasosParaSheets(false);
}
```

---

## 📄 Arquivo [27/32]: Notify.gs

```javascript
/**
 * @fileoverview Notify.gs — Alertas por e-mail de novos gatilhos (Fase 4: Firestore).
 *
 * MIGRAÇÃO: a única função que tocava Sheets diretamente era
 * resolverEmailsPorSetor_() (lia a aba legada DB_Config_Emails). Todo o
 * resto deste arquivo (enviarAlertasAgrupados, montagem de HTML, MailApp)
 * JÁ dependia exclusivamente de getConfig() — que foi migrado na Fase 4
 * anterior e já lê do Firestore. Portanto não precisou de nenhuma mudança
 * além da função abaixo.
 *
 * O e-mail legado (DB_Config_Emails) não fazia parte do plano de migração
 * de dados original porque já era tratado como fallback de baixa prioridade
 * (o canônico, DB_Setores, sempre sobrescreve). Se essa aba legada ainda
 * tiver dados relevantes no Sheets, rode migrarConfigEmailsLegadoParaFirestore
 * (definida no final deste arquivo) uma vez, em modo dry-run primeiro.
 * Caso a aba esteja vazia/não exista (comum, já que é legado consolidado em
 * DB_Setores conforme a documentação original), pode ignorar esse passo —
 * o sistema funciona normalmente só com o canônico.
 */

/**
 * Monta o mapa SETOR(maiúsculo) -> e-mail, unificando as fontes:
 *  1) config_emails_legado (Firestore — equivalente a DB_Config_Emails)
 *  2) DB_Setores via getConfig() (canônico — sobrescreve o legado)
 */
function resolverEmailsPorSetor_() {
  const map = {};

  // 1) Legado (Firestore) — opcional, pode não ter sido migrado/existir
  try {
    const legado = fsListarTodos_(SCHEMA.FS.EMAILS_LEGADO);
    legado.forEach(function (doc) {
      const setor = String(doc.setor || doc._id || '').toUpperCase().trim();
      const email = String(doc.email || '').trim();
      if (setor && email) map[setor] = email;
    });
  } catch (e) {
    // Coleção pode não existir ainda — comportamento idêntico ao Sheets
    // quando a aba DB_Config_Emails não existia (getSheet_ retornava null).
    console.warn('resolverEmailsPorSetor_: config_emails_legado indisponível (ok se nunca migrado): ' + e.message);
  }

  // 2) Canônico (DB_Setores via getConfig) — tem prioridade, já migrado
  const cfg = getConfig();
  (cfg.setores || []).forEach(function (s) {
    if (s.setor && s.email) map[s.setor.toUpperCase().trim()] = s.email;
  });

  return map;
}

/**
 * Envia um e-mail por setor com os novos gatilhos rastreados.
 * INALTERADO — já dependia só de getConfig(), resolverEmailsPorSetor_()
 * e ScriptApp/MailApp, nenhum dos quais toca Sheets diretamente.
 *
 * @param {Object} casosPorSetor - { "UTI ADULTO": [ {prontuario, iniciais_paciente, ...}, ... ] }
 */
function enviarAlertasAgrupados(casosPorSetor) {
  const cfg = getConfig();

  // Respeita o toggle de alertas
  if (String(cfg.geral.ALERTAS_ATIVOS || "SIM").toUpperCase() !== "SIM") return;

  const DIRETORIO = resolverEmailsPorSetor_();
  const EMAIL_COORDENACAO = cfg.geral.EMAIL_COORDENACAO || "farmacia.clinica@hospital.com";
  const LINK_SISTEMA = ScriptApp.getService().getUrl();

  for (const setor in casosPorSetor) {
    const emailDestino = DIRETORIO[setor] || EMAIL_COORDENACAO;
    const listaCasos = casosPorSetor[setor];
    const setorSeguro = escaparHtml_(setor);
    const assunto = `🚨 VigiRAM: ${listaCasos.length} Novo(s) Gatilho(s) em ${setor}`;

    let linhas = "";
    listaCasos.forEach(function (c) {
      linhas += `
        <tr>
          <td style="padding:10px;border-bottom:1px solid #ddd;text-align:center;">${escaparHtml_(c.prontuario)}</td>
          <td style="padding:10px;border-bottom:1px solid #ddd;text-align:center;">${escaparHtml_(c.iniciais_paciente)}</td>
          <td style="padding:10px;border-bottom:1px solid #ddd;text-align:center;color:#c2410c;font-weight:bold;">${escaparHtml_(c.medicamento_suspeito)}</td>
          <td style="padding:10px;border-bottom:1px solid #ddd;text-align:center;font-size:12px;">${escaparHtml_(c.data_evento)}</td>
        </tr>`;
    });

    const html = `
      <div style="font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;max-width:650px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.05);">
        <div style="background-color:#f97316;padding:20px;text-align:center;">
          <h2 style="color:white;margin:0;font-size:24px;">Alerta de Farmacovigilância</h2>
          <p style="color:#ffedd5;margin:5px 0 0 0;font-size:14px;">Busca Ativa (Trigger Tool)</p>
        </div>
        <div style="padding:25px;background-color:#ffffff;">
          <p style="color:#374151;font-size:16px;">Olá,</p>
          <p style="color:#374151;font-size:16px;">O robô do <b>VigiRAM</b> rastreou novos gatilhos para o seu setor (<strong>${setorSeguro}</strong>).</p>
          <table style="width:100%;border-collapse:collapse;margin-top:15px;">
            <thead>
              <tr style="background-color:#f9fafb;">
                <th style="padding:10px;text-align:center;font-size:12px;color:#6b7280;">Prontuário</th>
                <th style="padding:10px;text-align:center;font-size:12px;color:#6b7280;">Paciente</th>
                <th style="padding:10px;text-align:center;font-size:12px;color:#6b7280;">Medicamento</th>
                <th style="padding:10px;text-align:center;font-size:12px;color:#6b7280;">Data</th>
              </tr>
            </thead>
            <tbody>${linhas}</tbody>
          </table>
          <p style="text-align:center;margin-top:25px;">
            <a href="${LINK_SISTEMA}" style="background-color:#f97316;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">
              Abrir VigiRAM
            </a>
          </p>
        </div>
      </div>`;

    try {
      MailApp.sendEmail({ to: emailDestino, subject: assunto, htmlBody: html });
    } catch (e) {
      console.error('Falha ao enviar e-mail para ' + setor + ' (' + emailDestino + '): ' + e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRAÇÃO OPCIONAL — DB_Config_Emails (legado) → Firestore
// Só rode se essa aba ainda tiver dados relevantes no Sheets. Padrão
// dry-run, idêntico aos outros scripts de migração já usados.
// ─────────────────────────────────────────────────────────────────────────────

function migrarConfigEmailsLegadoParaFirestore(dryRun) {
  const simular = dryRun !== false;
  const plan = getSheet_(SCHEMA.ABAS.EMAILS);
  if (!plan) {
    Logger.log('migrarConfigEmailsLegadoParaFirestore: aba DB_Config_Emails não existe — nada a migrar (esperado, já consolidado em DB_Setores).');
    return { migrados: 0, simulado: simular };
  }

  const dados = plan.getDataRange().getValues();
  let migrados = 0;

  for (let i = 1; i < dados.length; i++) {
    const setor = String(dados[i][0] || '').toUpperCase().trim();
    const email = String(dados[i][1] || '').trim();
    if (!setor || !email) continue;

    const idDoc = setor.replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');

    if (simular) {
      Logger.log('Migraria config_emails_legado/%s → { setor: "%s", email: "%s" }', idDoc, setor, email);
    } else {
      fsSetDoc_(SCHEMA.FS.EMAILS_LEGADO, idDoc, { setor: setor, email: email });
    }
    migrados++;
  }

  Logger.log('%s — DB_Config_Emails: %s linha(s) migrada(s)', simular ? 'DRY-RUN' : 'APLICADO', migrados);
  return { migrados: migrados, simulado: simular };
}
```

---

## 📄 Arquivo [28/32]: Router.gs

```javascript
/**
 * @fileoverview Router.gs — Pontos de entrada HTTP. Só roteamento.
 * A lógica vive nos módulos Cases / Ingest / Notify. Segurança em Security.gs.
 *
 * FASE 7 (#2): doPost agora EXIGE assinatura HMAC (verificarAssinaturaETL_)
 * para as ações de escrita do ETL (uploadRaw, insertDB). Sem assinatura válida,
 * a requisição é rejeitada antes de qualquer escrita.
 */

/**
 * POST — envio de dados do PowerShell (ETL). Autenticado por HMAC.
 */
function doPost(e) {
  try {
    const acao = e.parameter.action;
    switch (acao) {
      case 'uploadRaw':
        verificarAssinaturaETL_(e); // Security.gs — lança se inválida
        return handleUploadRaw(e);  // Ingest.gs
      case 'insertDB':
        verificarAssinaturaETL_(e);
        return handleInsertDB(e);   // Ingest.gs
      default:
        throw new Error(`Ação POST não reconhecida ou ausente: ${acao}`);
    }
  } catch (erro) {
    return createJsonResponse({ status: 'erro', mensagem: erro.toString() });
  }
}

/**
 * GET — navegador (painel/formulário) ou consulta do robô.
 *
 * NOTA: getTriggers permanece como leitura pública (apenas nomes de
 * medicamentos-gatilho, baixa sensibilidade). Se desejar protegê-la também,
 * é possível assinar a query no PowerShell e validar aqui — fora do escopo atual.
 */
function doGet(e) {
  try {
    // 1. Rota do robô PowerShell
    if (e.parameter && e.parameter.action === 'getTriggers') {
      return handleGetTriggers(); // Ingest.gs
    }

    // 2. Formulário da assistência
    if (e.parameter && e.parameter.page === 'form') {
      const htmlForm = HtmlService.createTemplateFromFile('form').evaluate();
      htmlForm.setTitle('VigiRAM - Notificação');
      htmlForm.addMetaTag('viewport', 'width=device-width, initial-scale=1');
      return htmlForm;
    }

    // 3. Painel Kanban (padrão)
    const htmlIndex = HtmlService.createTemplateFromFile('index').evaluate();
    htmlIndex.setTitle('VigiRAM');
    htmlIndex.addMetaTag('viewport', 'width=device-width, initial-scale=1');
    htmlIndex.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
    return htmlIndex;

  } catch (erro) {
    return createJsonResponse({ erro: erro.toString() });
  }
}
```

---

## 📄 Arquivo [29/32]: Schema.gs

```javascript
/**
 * @fileoverview Schema.gs — FONTE ÚNICA DE VERDADE do VigiRAM.
 *
 * Toda posição de coluna, nome de status e nome de aba vive AQUI.
 * Nenhum outro arquivo deve conter número de coluna "mágico" ou status literal.
 *
 * Para inserir uma coluna nova no futuro: ajuste o número aqui e pronto.
 *
 * ATUALIZAÇÃO (Fase 3 / DB_Setores):
 *   Adicionado COL_SETORES — mapa das colunas da aba DB_Setores.
 *
 * ATUALIZAÇÃO (Fase 6 / Separação Assistência × Investigação + PII estruturada):
 *   Colunas reordenadas para refletir a nova estrutura da tabela de exportação/relatório.
 *   As colunas de PII do notificador e dados de assistência foram reposicionadas.
 *
 *   MOTIVO #7: registrarInvestigacao grava em RELATO e EVOLUCAO.
 *   Antes, salvarDemandaEspontanea também usava 13/16, então abrir a
 *   investigação de um caso DE sobrescrevia o relato do notificador. Agora o
 *   relato da assistência tem sua própria coluna (read-only no modal) e a investigação
 *   é livre para preencher o relato do evento sem perda.
 *
 *   MOTIVO #8: PII do notificador (nome/categoria/e-mail) deixava de ser
 *   estruturada — ia concatenada em texto livre na coluna OBSERVACOES,
 *   inviabilizando eliminação/retenção seletiva exigida pela LGPD. Agora cada
 *   atributo tem coluna própria, permitindo limpeza cirúrgica por campo.
 *
 *   SCHEMA.LARGURA reflete o total de colunas (usado para gravação em lote).
 *
 * ATUALIZAÇÃO (Fase 8 / Exportação E2B(R3) para VigiMed):
 *   Adicionadas colunas 35-42 (REACAO_TERMO até SAFETYREPORTID_E2B) — dados
 *   que o E2B(R3) exige e que não existiam como campo discreto até então
 *   (reação era só texto livre dentro de RELATO_NOTIFICADOR/RELATO).
 *
 *   Adicionado bloco SCHEMA.E2B — mapas de tradução entre os valores livres
 *   dos dropdowns existentes (DEFAULT_LISTAS em Config.gs) e os códigos
 *   fechados exigidos pelo padrão ICH E2B(R3)/HL7v3. Esses mapas NÃO leem
 *   config_geral/listas em runtime — se o admin adicionar uma opção nova em
 *   Gravidade/Desfecho pelo painel, o mapa aqui PRECISA ser atualizado junto,
 *   ou a geração do XML deve falhar explicitamente (ver E2B.gs).
 *
 *   MEDDRA_CODE foi propositalmente OMITIDO — sem licença MedDRA ativa, o
 *   campo fica de fora até decisão de ativar a licença.
 */
const SCHEMA = {

  // ── Nomes das abas da planilha ────────────────────────────────────────────
  ABAS: {
    CASOS:     "DB_Casos_RAM",
    ANTIDOTOS: "DB_Antidotos",        // gatilhos (Trigger Tool)
    EMAILS:    "DB_Config_Emails",    // legado (consolidado em DB_Setores)
    GERAL:     "DB_Config_Geral",     // parâmetros globais (chave/valor)
    SETORES:   "DB_Setores",          // lista canônica de setores + responsáveis
    LISTAS:    "DB_Listas",           // opções de todos os dropdowns
    NARANJO:   "DB_Naranjo",          // perguntas/pesos do Naranjo (opcional)
    LOG:       "DB_Log",              // trilha de auditoria (opcional)
    USUARIOS:  "DB_Usuarios"          // usuários do painel (Auth.gs)
  },

  // ── Nomes de coleção no Firestore (Fase 2 — migração gradual) ────────────
  // Espelha SCHEMA.ABAS, mas em formato compatível com Firestore (sem maiúsculas
  // obrigatórias, sem acento, snake_case por convenção).
  FS: {
    CASOS:         'casos_ram',
    GERAL:         'config_geral',
    SETORES:       'setores',
    LISTAS:        'listas',
    NARANJO:       'naranjo',
    LOG:           'log_auditoria',
    USUARIOS:      'usuarios',
    EMAILS_LEGADO: 'config_emails_legado'
  },

  // ── Posição das colunas em DB_Casos_RAM (1-based) ─────────────────────────
  // REORDENADO 07/2026 — reflete o cabeçalho FÍSICO da aba (blocos: paciente →
  // medicamento (dose/lote/laboratório/via/início adm.) → assistência →
  // investigação → conclusão → auditoria → E2B → triagem).
  // LOTE_LABORATORIO foi DIVIDIDO em LOTE + LABORATORIO — G.k.4.r.7 exige só o lote.
  COL: {
    ID:                  1,  // ID_CASO
    DATA:                2,  // DATA_EVENTO
    TIPO:                3,  // TIPO
    NOTIF_NOME:          4,  // NOTIF_NOME
    NOTIF_CATEGORIA:     5,  // NOTIF_CATEGORIA
    DATA_NOTIFICACAO:    6,  // DATA_NOTIFICACAO
    PRONTUARIO:          7,  // PRONTUARIO
    INICIAIS:            8,  // INICIAIS_PACIENTE
    NASCIMENTO:          9,  // DATA_NASCIMENTO
    SEXO:               10,  // SEXO — D.5 administrativeGenderCode (era col 43)
    SETOR:              11,  // SETOR
    MEDICAMENTO:        12,  // MEDICAMENTO_SUSPEITO
    DOSE_MEDICAMENTO:   13,  // DOSE_MEDICAMENTO (G.k.4.r.1a)
    DOSE_UNIDADE:       14,  // DOSE_UNIDADE (G.k.4.r.1b)
    LOTE:               15,  // LOTE — G.k.4.r.7 lotNumberText (separado de LABORATORIO)
    LABORATORIO:        16,  // LABORATORIO — fabricante/detentor (uso interno + narrativa E2B)
    VIA_ADMINISTRACAO:  17,  // VIA_ADMINISTRACAO (G.k.4.r.10.1)
    DATA_INICIO_ADM:    18,  // DATA_INICIO_ADMINISTRACAO (G.k.4.r.4) — distinto de DATA_INICIO_REACAO
    RELATO_NOTIFICADOR: 19,  // RELATO_NOTIFICADOR
    CONDUTA_NOTIFICADOR:20,  // CONDUTA_NOTIFICADOR
    STATUS:             21,  // STATUS
    SLA:                22,  // PRAZO_SLA
    MOTIVO_DESCARTE:    23,  // MOTIVO_DESCARTE
    HISTORIA:           24,  // HISTORIA_CLINICA
    RELATO:             25,  // RELATO_EVENTO (Farmacêutico)
    REACAO_TERMO:       26,  // REACAO_TERMO (E.i.1.1a)
    DATA_INICIO_REACAO: 27,  // DATA_INICIO_REACAO (E.i.4)
    EXAMES:             28,  // EXAMES_COMPLEMENTARES
    READMINISTRADO:     29,  // READMINISTRADO
    EVOLUCAO:           30,  // EVOLUCAO_POS_CONDUTAS (Farmacêutico)
    DESFECHO:           31,  // DESFECHO
    CONCLUSAO:          32,  // CONCLUSAO
    NARANJO:            33,  // NARANJO
    GRAVIDADE:          34,  // GRAVIDADE
    FARMACEUTICO:       35,  // FARMACEUTICO
    NUM_VIGIMED:        36,  // NUM_VIGIMED
    DATA_VIGIMED:       37,  // DATA_VIGIMED
    OBSERVACOES:        38,  // OBSERVACOES
    NARANJO_RESP:       39,  // NARANJO_RESPOSTAS
    ATUALIZADO_POR:     40,  // ATUALIZADO_POR
    ATUALIZADO_EM:      41,  // ATUALIZADO_EM
    NOTIF_EMAIL:        42,  // NOTIF_EMAIL
    ID_REACAO_E2B:      43,  // ID_REACAO_E2B — UUID estável, gerado 1x na 1ª exportação
    ID_MEDICAMENTO_E2B: 44,  // ID_MEDICAMENTO_E2B — UUID estável, gerado 1x na 1ª exportação
    SAFETYREPORTID_E2B: 45,  // SAFETYREPORTID_E2B — último C.1.1 (controle reenvio/follow-up)
    DATA_TRIAGEM:       46   // Timestamp carimbado 1x em registrarTriagem() (Cases.gs)
  },
  LARGURA: 46,

  // ── Posição das colunas em DB_Setores (1-based) ───────────────────────────
  //   A: SETOR | B: ATIVO | C: FARMACEUTICO_RESPONSAVEL | D: EMAIL_RESPONSAVEL
  COL_SETORES: {
    SETOR:                   1,
    ATIVO:                   2,
    FARMACEUTICO_RESPONSAVEL:3,
    EMAIL_RESPONSAVEL:       4
  },

  COL_USUARIOS: {
    EMAIL: 1,
    SENHA: 2,
    NOME:  3,
    ATIVO: 4,
    PERFIL:5
  },

  // ── Status do caso (Kanban) ───────────────────────────────────────────────
  STATUS: {
    TRIAGEM:     "PENDENTE TRIAGEM",
    INVESTIGACAO:"EM INVESTIGAÇÃO",
    CONCLUIDO:   "CONCLUÍDO",
    DESCARTADO:  "DESCARTADO"
  },

  // ── Fase 8 / Exportação E2B(R3) — OIDs e mapas de tradução ────────────────
  // Fonte: ICH ICSR Technical Information (Appendix I(G)) + validação real
  // contra ambiente de teste VigiFlow/VigiMed (AckLogs de 01/07/2026).
  E2B: {
    CODESYS: {
      TIPO_RELATO:          '2.16.840.1.113883.3.989.2.1.1.2',
      QUALIFICACAO_NOTIF:   '2.16.840.1.113883.3.989.2.1.1.6',
      SENDER_TYPE:          '2.16.840.1.113883.3.989.2.1.1.7',
      FIRST_SENDER:         '2.16.840.1.113883.3.989.2.1.1.3',
      OBSERVACOES:          '2.16.840.1.113883.3.989.2.1.1.19',
      CATEGORIA_GK:         '2.16.840.1.113883.3.989.2.1.1.20',
      ACAO_MEDICAMENTO:     '2.16.840.1.113883.3.989.2.1.1.15',
      CARACTERIZACAO_DROGA: '2.16.840.1.113883.3.989.2.1.1.13',
      DESFECHO:             '2.16.840.1.113883.3.989.2.1.1.11',
      PAIS:                 '1.0.3166.1.2.2',
      SEXO:                 '1.0.5218'   // D.5 administrativeGenderCode — [1] Masculino [2] Feminino
    },

    // D.5 — espelha valores livres vindos do ETL (relatório de entradas).
    // Cobre variações comuns de grafia da origem bruta.
    SEXO_MAP: {
      'M': '1', 'MASCULINO': '1',
      'F': '2', 'FEMININO':  '2'
    },

    // NOTA: sistema hoje é uso exclusivo da Farmácia — C.2.r.4 é fixado em
    // '2' (Pharmacist) direto em E2B.gs, sem depender de caso.notificador.categoria.
    // Mapa mantido só para eventual reintrodução de notificador externo.
    // Espelha exatamente os data-cat dos botões "cat-pill" em form.html.
    // Se um novo botão de categoria for adicionado lá, adicionar aqui também.
    QUALIFICACAO_MAP: {
      'Médico(a)':                '1',
      'Farmacêutico(a)':           '2',
      'Enfermeiro(a)':             '3',
      'Técnico(a) de Enfermagem':  '3',
      'Outro':                     '3'
    },

    // Espelha DEFAULT_LISTAS.gravidade (Config.gs / config_geral/listas).
    // GRAVE cai em "outro_importante" por falta de granularidade nos dados —
    // ver decisão pendente sobre adicionar checkboxes específicos.
    GRAVIDADE_MAP: {
      'FATAL':    { morte: true,  hospital: false, risco_vida: false, incapacitante: false, outro_importante: false },
      'GRAVE':    { morte: false, hospital: false, risco_vida: false, incapacitante: false, outro_importante: true  },
      'MODERADA': { morte: false, hospital: false, risco_vida: false, incapacitante: false, outro_importante: false },
      'LEVE':     { morte: false, hospital: false, risco_vida: false, incapacitante: false, outro_importante: false }
    },

    // Espelha DEFAULT_LISTAS.desfecho -> E.i.7 (codelist pública do ICH,
    // não é vocabulário proprietário — sem bloqueio de licença).
    DESFECHO_MAP: {
      'PACIENTE RECUPERADO':      '1', // Recovered/resolved
      'TRANSFERÊNCIA INTERNA':    '2', // Recovering/resolving
      'ALTA':                     '2',
      'PROLONGADO INTERNAÇÃO':    '3', // Not recovered/not resolved
      'TRANSFERÊNCIA EXTERNA':    '3',
      'ÓBITO':                    '5'  // Fatal
      // fallback '6' Unknown se valor não mapeado — ver validação em E2B.gs
    },

    // Espelha NARANJO_FAIXAS (js_investigacao.html) — replicado aqui pro
    // backend, que não deve depender do frontend como fonte de verdade.
    NARANJO_CATEGORIA: [
      { min: 9,          max: Infinity,  valor: 'DEFINITE' },
      { min: 5,          max: 8,         valor: 'PROBABLE' },
      { min: 1,          max: 4,         valor: 'POSSIBLE' },
      { min: -Infinity,  max: 0,         valor: 'DOUBTFUL' }
    ]
  }
};

/**
 * SCHEMA.FS (anexo Schema.gs):
 * { CASOS:'casos_ram', GERAL:'config_geral', SETORES:'setores',
 *   LISTAS:'listas', NARANJO:'naranjo', LOG:'log_auditoria', USUARIOS:'usuarios' }
 */
```

---

## 📄 Arquivo [30/32]: Security.gs

```javascript
/**
 * @fileoverview Security.gs — Camada de segurança de borda (Fase 7).
 *
 *  #2 — Autenticação dos endpoints de ESCRITA do ETL (doPost):
 *       insertDB e uploadRaw passam a exigir assinatura HMAC-SHA256.
 *       A requisição traz ?ts=<epoch_seg>&sig=<hex>, onde:
 *           sig = HMAC_SHA256( ts + "\n" + corpo_bruto , ETL_SECRET )
 *       Validações: janela de ±300s (anti-replay temporal) e comparação de
 *       tempo constante. O segredo vive em Script Properties (nunca no código).
 *
 *       Anti-replay: dentro da janela de 300s a mesma requisição poderia ser
 *       reenviada. Para insertDB a deduplicação por id_caso já neutraliza
 *       inserções repetidas; para uploadRaw o risco é, no máximo, um backup
 *       duplicado. Reduza a janela se desejar endurecer.
 *
 *  Também: allowlist opcional de pastas do Drive para uploadRaw, evitando que
 *  um folderId arbitrário (parâmetro controlável) direcione escrita para
 *  qualquer pasta acessível ao deployer.
 *
 *  Helpers de hash/hex/comparação são reutilizados por Auth.gs (#3).
 */

const _PROP_ETL_SECRET   = 'ETL_SECRET';
const _PROP_ETL_FOLDERS  = 'ETL_FOLDER_IDS'; // CSV opcional de folderIds permitidos
const _ETL_JANELA_SEG    = 300;               // ±5 min (anti-replay)

// ─────────────────────────────────────────────────────────────────────────────
// HMAC / HEX / COMPARAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

/** Converte byte array (assinado) em string hex minúscula. */
function bytesParaHex_(bytes) {
  return bytes.map(function (b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');
}

/** HMAC-SHA256(mensagem, segredo) → hex. */
function hmacHex_(mensagem, segredo) {
  const raw = Utilities.computeHmacSha256Signature(
    String(mensagem), String(segredo), Utilities.Charset.UTF_8
  );
  return bytesParaHex_(raw);
}

/** Comparação de strings em tempo constante (evita timing attacks). */
function comparacaoSegura_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return r === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEGREDO DO ETL
// ─────────────────────────────────────────────────────────────────────────────

function getSegredoETL_() {
  return PropertiesService.getScriptProperties().getProperty(_PROP_ETL_SECRET) || '';
}

function _verSegredo() {
  const s = getSegredoETL_();
  Logger.log(s ? ('OK, length=' + s.length) : 'VAZIO — ETL_SECRET não está salvo');
  return s;
}

/**
 * Define o segredo do ETL. Rode UMA vez no editor e guarde o MESMO valor no
 * PowerShell. Ex.: definirSegredoETL('cole-aqui-um-valor-aleatorio-longo')
 */
function definirSegredoETL(segredo) {
  if (!segredo || String(segredo).length < 24) {
    throw new Error('Use um segredo com ao menos 24 caracteres aleatórios.');
  }
  PropertiesService.getScriptProperties().setProperty(_PROP_ETL_SECRET, String(segredo));
  return 'Segredo do ETL definido.';
}

/** Gera um segredo aleatório forte (copie para o PowerShell). */
function gerarSegredoETL() {
  const s = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  Logger.log('ETL_SECRET sugerido: %s', s);
  return s;
}

/** Define a allowlist de pastas do Drive para uploadRaw (CSV de IDs). */
function definirPastasETL(csvFolderIds) {
  PropertiesService.getScriptProperties()
    .setProperty(_PROP_ETL_FOLDERS, String(csvFolderIds || '').trim());
  return 'Allowlist de pastas atualizada.';
}

// ─────────────────────────────────────────────────────────────────────────────
// VERIFICAÇÃO DA REQUISIÇÃO ETL (chamada no doPost — Router.gs)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Valida a assinatura HMAC do POST do ETL. Lança erro se inválida.
 * @param {Object} e - evento do doPost
 */
function verificarAssinaturaETL_(e) {
  const segredo = getSegredoETL_();
  if (!segredo) throw new Error('ETL_SECRET não configurado no servidor.');

  const ts  = String((e.parameter && e.parameter.ts)  || '');
  const sig = String((e.parameter && e.parameter.sig) || '').toLowerCase();
  if (!ts || !sig) throw new Error('Requisição não assinada.');

  const tsNum = parseInt(ts, 10);
  const agora = Math.floor(Date.now() / 1000);
  if (!tsNum || Math.abs(agora - tsNum) > _ETL_JANELA_SEG) {
    throw new Error('Janela de tempo expirada (verifique o relógio do robô).');
  }

  const corpo    = (e.postData && e.postData.contents) ? e.postData.contents : '';
  const esperado = hmacHex_(ts + '\n' + corpo, segredo);
  if (!comparacaoSegura_(esperado, sig)) throw new Error('Assinatura inválida.');

  return true;
}

/**
 * Garante que o folderId esteja na allowlist, QUANDO ela estiver configurada.
 * Sem allowlist definida, mantém compatibilidade (apenas registra aviso).
 */
function validarFolderPermitido_(folderId) {
  const csv = PropertiesService.getScriptProperties().getProperty(_PROP_ETL_FOLDERS) || '';
  if (!csv.trim()) {
    console.warn('ETL_FOLDER_IDS não configurado — folderId não validado.');
    return true;
  }
  const permitidos = csv.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (permitidos.indexOf(String(folderId).trim()) === -1) {
    throw new Error('folderId não autorizado.');
  }
  return true;
}

// [REMOVIDO — CRÍTICO] _setupSegredo() continha o ETL_SECRET hardcoded no
// código-fonte (e, por consequência, no backup .md exportado). Segredo em
// código = segredo comprometido: rotacione IMEDIATAMENTE.
// Procedimento de rotação:
//   1. No editor: rode gerarSegredoETL() e copie o valor do log.
//   2. No editor: rode definirSegredoETL('<valor copiado>') digitando na
//      janela de execução — NUNCA salve o valor em arquivo .gs.
//   3. Atualize o mesmo valor no Pipeline_v3.ps1 (lado PowerShell).
//   4. Confirme com _verSegredo() (loga apenas o tamanho, nunca o valor).
```

---

## 📄 Arquivo [31/32]: styles.html

```html
<style>
  /* =====================================================
     ANIMAÇÕES E TRANSITIONS GLOBAIS
  ===================================================== */
  .fade-in { animation: fadeIn 0.25s ease-in; }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: none; }
  }

  /* =====================================================
     SAAS POLISH — navbar, badges, cards
  ===================================================== */
  .aba-ativa   { background-color: #0d9488; color: white; box-shadow: inset 0 -3px 0 #f97316; border-radius: 10px 10px 0 0; }
  .aba-inativa { background-color: transparent; color: #99f6e4; border-radius: 10px 10px 0 0; }
  .aba-inativa:hover { background-color: rgba(255,255,255,0.08); color: white; }

  .navbar-divider {
    width: 1px;
    align-self: stretch;
    background: rgba(255,255,255,0.12);
    margin: 0 4px;
  }

  .pill-action {
    transition: transform .15s ease, box-shadow .15s ease, background-color .15s ease;
  }
  .pill-action:hover { transform: translateY(-1px); }
  .pill-action:active { transform: translateY(0); }

  .card-elevated {
    box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.04);
  }

  .badge-soft {
    font-variant-numeric: tabular-nums;
    letter-spacing: .02em;
  }

  /* =====================================================
     SKELETON LOADERS
  ===================================================== */
  .skeleton {
    background: linear-gradient(90deg, #e5e7eb 25%, #f3f4f6 50%, #e5e7eb 75%);
    background-size: 200% 100%;
    animation: shimmer 1.4s infinite;
    border-radius: 8px;
  }
  @keyframes shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  .skeleton-card { height: 110px; margin-bottom: 12px; }

  /* =====================================================
     BADGES DE SLA
  ===================================================== */
  .badge-sla-ok    { background: #d1fae5; color: #065f46; border: 1px solid #6ee7b7; }
  .badge-sla-warn  { background: #fef9c3; color: #92400e; border: 1px solid #fde68a; }
  .badge-sla-late  { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
  .badge-sla-sem   { background: #f3f4f6; color: #6b7280; border: 1px solid #e5e7eb; }

  /* =====================================================
     CARD KANBAN
  ===================================================== */
  .kanban-card {
    transition: box-shadow 0.2s, transform 0.15s;
  }
  .kanban-card:hover {
    box-shadow: 0 4px 16px rgba(0,0,0,0.10);
    transform: translateY(-1px);
  }

  /* =====================================================
     TOOLTIP CUSTOMIZADO (Naranjo)
  ===================================================== */
  [data-tooltip] { position: relative; cursor: help; }
  [data-tooltip]::after {
    content: attr(data-tooltip);
    position: absolute;
    left: 50%; top: calc(100% + 6px);
    transform: translateX(-50%);
    background: #1f2937;
    color: #fff;
    font-size: 11px;
    line-height: 1.4;
    padding: 6px 10px;
    border-radius: 6px;
    white-space: pre-wrap;
    min-width: 200px;
    max-width: 280px;
    z-index: 9999;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s;
    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  }
  [data-tooltip]:hover::after { opacity: 1; }

  /* =====================================================
     NARANJO — HOVER NAS LINHAS
  ===================================================== */
  .naranjo-row { transition: background 0.15s; }
  .naranjo-row:hover { background: #f0f9ff; }

  /* =====================================================
     SCROLLBAR FINA NAS COLUNAS KANBAN
  ===================================================== */
  .kanban-col::-webkit-scrollbar { width: 4px; }
  .kanban-col::-webkit-scrollbar-track { background: transparent; }
  .kanban-col::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 4px; }
</style>
```

---

## 📄 Arquivo [32/32]: Utils.gs

```javascript
/**
 * @fileoverview Utils.gs — helpers de infraestrutura reutilizados por todos os módulos.
 */

const LOCK_TIMEOUT_MS = 30000;

/**
 * Executa uma operação de escrita protegida por trava global.
 * Impede que o ETL (PowerShell) e ações manuais do painel escrevam ao mesmo tempo.
 */
function comTrava_(operacao) {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    return operacao();
  } finally {
    lock.releaseLock();
  }
}

/** Retorna a aba pelo nome, ou null se não existir (sem lançar erro). */
function getSheet_(nomeAba) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nomeAba);
}

/** Retorna a aba pelo nome, lançando erro claro se não existir. */
function getSheetOuErro_(nomeAba) {
  const aba = getSheet_(nomeAba);
  if (!aba) throw new Error(`Aba "${nomeAba}" não localizada na planilha.`);
  return aba;
}

/**
 * Lê uma célula de uma linha de matriz usando a coluna 1-based do SCHEMA.
 * Ex.: cel(linha, SCHEMA.COL.SETOR)
 */
function cel(linha, coluna1based) {
  return linha[coluna1based - 1];
}

/**
 * Localiza a linha (1-based) de um caso pelo ID, buscando SOMENTE na coluna A.
 * Substitui a varredura O(n) por TextFinder.
 * @returns {number} número da linha, ou -1 se não encontrado.
 */
function localizarLinhaCaso_(planilha, idCaso) {
  const idAlvo = String(idCaso).trim();
  const ultimaLinha = planilha.getLastRow();
  if (ultimaLinha < 2) return -1;
  const match = planilha
    .getRange(1, SCHEMA.COL.ID, ultimaLinha, 1)
    .createTextFinder(idAlvo)
    .matchEntireCell(true)
    .findNext();
  return match ? match.getRow() : -1;
}

/** Escapa caracteres HTML para impedir injeção em e-mails. */
function escaparHtml_(texto) {
  return String(texto == null ? "" : texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Padroniza a saída das respostas HTTP da API em JSON. */
function createJsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Inclui o conteúdo de outro arquivo HTML dentro de um template.
 * Uso no index.html: <?!= include('styles'); ?>
 */
function include (nomeArquivo) {
  return HtmlService.createHtmlOutputFromFile(nomeArquivo).getContent();
}
```

