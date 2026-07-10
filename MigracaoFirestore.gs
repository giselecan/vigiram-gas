/**
 * @fileoverview MigracaoFirestore.gs — Migração Sheets → Firestore (Fase 3/4).
 *
 * ORDEM DE EXECUÇÃO (do menor para o maior risco — ver plano de migração):
 *   1. migrarConfigGeralParaFirestore(dryRun)
 *   2. migrarSetoresParaFirestore(dryRun)
 *   3. migrarListasParaFirestore(dryRun)
 *   4. migrarNaranjoParaFirestore(dryRun)
 *   5. migrarUsuariosParaFirestore(dryRun)
 *   6. migrarGatilhosParaFirestore(dryRun) — OPCIONAL (Fase 9), DB_Antidotos → gatilhos
 *   7. migrarCasosParaFirestore(dryRun)   ← NÚCLEO, rodar por último
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
// 6) DB_Antidotos → coleção gatilhos (Fase 9 — Firestore como Single Source
//    of Truth). MIGRAÇÃO OPCIONAL, standalone (não entra em
//    migrarTudoBaixoRisco): rode UMA VEZ antes ou logo depois do deploy da
//    Fase 9, para que listarGatilhos()/handleGetTriggers() (agora só-Firestore)
//    já encontrem os medicamentos-gatilho que estavam em DB_Antidotos.
//    Idempotente — fsSetDoc_ faz upsert, rodar de novo não duplica.
// ─────────────────────────────────────────────────────────────────────────────

function migrarGatilhosParaFirestore(dryRun) {
  const simular = dryRun !== false;
  const plan = getSheet_(SCHEMA.ABAS.ANTIDOTOS);
  if (!plan) {
    Logger.log('migrarGatilhosParaFirestore: aba DB_Antidotos não existe, nada a migrar.');
    return { migrados: 0, simulado: simular };
  }

  const dados = plan.getDataRange().getValues();
  let migrados = 0;

  for (let i = 1; i < dados.length; i++) {
    const medicamento = String(dados[i][0] || '').trim().toUpperCase();
    if (!medicamento) continue;
    // Coluna D vazia significa ativo. getValues() devolve célula vazia como
    // string "", portanto testar apenas null/undefined marcava todos como
    // inativos. Valores explícitos de negação continuam sendo respeitados.
    const valorAtivo = String(dados[i][3] || '').trim().toUpperCase();
    const ativo = valorAtivo === ''
      ? true
      : ['NÃO', 'NAO', 'FALSE', '0', 'INATIVO'].indexOf(valorAtivo) === -1;
    const id = medicamento.replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');
    if (!id) continue;

    if (simular) {
      Logger.log('Migraria gatilhos/%s → { medicamento: "%s", ativo: %s }', id, medicamento, ativo);
    } else {
      fsSetDoc_(SCHEMA.FS.GATILHOS, id, { medicamento: medicamento, ativo: ativo });
    }
    migrados++;
  }

  Logger.log('%s — DB_Antidotos: %s gatilho(s) migrado(s)', simular ? 'DRY-RUN' : 'APLICADO', migrados);
  return { migrados: migrados, simulado: simular };
}

function _aplicarMigracaoGatilhos() {
  migrarGatilhosParaFirestore(false);
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
