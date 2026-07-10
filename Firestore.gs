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

/**
 * Grava (upsert) VÁRIOS documentos numa mesma coleção em um único :commit,
 * em vez de um PATCH por documento. Colapsa N round-trips de escrita em
 * ceil(N/400) chamadas — usado pelo ETL em lote (handleInsertDB). Cada chunk
 * é atômico no Firestore (all-or-nothing); em falha, fsFetch_ lança e o caller
 * (com id determinístico → upsert idempotente) pode reprocessar o lote inteiro
 * sem duplicar. Firestore permite até 500 writes/commit; 400 dá folga.
 * @param {string} colecao
 * @param {Array<{id, dados}>} itens
 */
function fsBatchSet_(colecao, itens) {
  if (!itens || !itens.length) return;
  const cfg = fsConfig_();
  const prefixo = 'projects/' + cfg.projectId + '/databases/' + cfg.databaseId + '/documents/' + colecao + '/';
  const url = fsUrlBase_() + ':commit';
  const CHUNK = 400;

  for (let i = 0; i < itens.length; i += CHUNK) {
    const writes = itens.slice(i, i + CHUNK).map(function (it) {
      return { update: { name: prefixo + it.id, fields: fsParaCamposFs_(it.dados) } };
    });
    fsFetch_('post', url, { writes: writes });
  }
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

/**
 * FIX: url sem strip de /documents — parent do runQuery exige /documents.
 * @param {string} colecao
 * @param {Array<{campo,op,valor}>=} filtros
 * @param {number=} limite
 * @param {Array<{campo, direcao}>=} ordenacao — direcao 'ASCENDING'|'DESCENDING'
 *   (default 'ASCENDING'). Ordena/limita no servidor (evita full-scan + sort em
 *   memória). Ordenar por um campo só traz docs que possuem esse campo.
 */
function fsQuery_(colecao, filtros, limite, ordenacao) {
  const corpo = {
    structuredQuery: {
      from: [{ collectionId: colecao }],
      limit: limite || undefined
    }
  };

  if (ordenacao && ordenacao.length) {
    corpo.structuredQuery.orderBy = ordenacao.map(function (o) {
      return {
        field: { fieldPath: o.campo },
        direction: o.direcao || 'ASCENDING'
      };
    });
  }

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
