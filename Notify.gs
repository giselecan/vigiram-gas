/**
 * @fileoverview Notify.gs — Alertas por e-mail (gatilhos, demanda espontânea,
 * conclusão de investigação). Fase 4/9: Firestore.
 *
 * MIGRAÇÃO: a única função que tocava Sheets diretamente era
 * resolverEmailsPorSetor_() (lia a aba legada DB_Config_Emails). Todo o
 * resto deste arquivo já depende exclusivamente de getConfig() — que foi
 * migrado na Fase 4 anterior e já lê do Firestore.
 *
 * O e-mail legado (DB_Config_Emails) não fazia parte do plano de migração
 * de dados original porque já era tratado como fallback de baixa prioridade
 * (o canônico, DB_Setores, sempre sobrescreve). Se essa aba legada ainda
 * tiver dados relevantes no Sheets, rode migrarConfigEmailsLegadoParaFirestore
 * (definida no final deste arquivo) uma vez, em modo dry-run primeiro.
 * Caso a aba esteja vazia/não exista (comum, já que é legado consolidado em
 * DB_Setores conforme a documentação original), pode ignorar esse passo —
 * o sistema funciona normalmente só com o canônico.
 *
 * SINALIZAÇÕES DE E-MAIL (3 fluxos, todos com layout visual compartilhado
 * via _montarEmailBase_):
 *  1) enviarRelatorioDiarioGatilhos() — job diário (07:00) que substitui o
 *     alerta imediato por inserção: agrega os gatilhos (casos tipo 'BA')
 *     AINDA PENDENTES DE TRIAGEM (status TRIAGEM, sem limite de tempo) por
 *     setor e manda 1 e-mail por setor para o farmacêutico responsável.
 *     Instalar com instalarTriggerRelatorioDiario().
 *  2) notificarNovaDemandaEspontanea_(idCaso) — disparado na hora pela
 *     criação de uma Demanda Espontânea (salvarDemandaEspontanea, Cases.gs),
 *     avisa o farmacêutico do setor que há uma nova DE aguardando investigação.
 *  3) notificarInvestigacaoConcluida_(idCaso) — disparado quando uma
 *     investigação de DE é concluída (registrarInvestigacao, Cases.gs),
 *     avisa o notificador original (quem relatou o caso) para reforçar que
 *     ele pode/deve fazer uma nova notificação caso identifique outro evento.
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
 * Layout visual compartilhado pelos 3 e-mails deste arquivo — mesma
 * identidade do painel (laranja #f97316), só muda cor de destaque, título,
 * subtítulo e corpo.
 */
function _montarEmailBase_(corDestaque, titulo, subtitulo, corpoHtml, linkSistema, textoBotao) {
  return `
    <div style="font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;max-width:650px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.05);">
      <div style="background-color:${corDestaque};padding:20px;text-align:center;">
        <h2 style="color:white;margin:0;font-size:24px;">${titulo}</h2>
        <p style="color:#ffedd5;margin:5px 0 0 0;font-size:14px;">${subtitulo}</p>
      </div>
      <div style="padding:25px;background-color:#ffffff;">
        ${corpoHtml}
        ${linkSistema ? `
        <p style="text-align:center;margin-top:25px;">
          <a href="${linkSistema}" style="background-color:${corDestaque};color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">
            ${textoBotao || 'Abrir VigiRAM'}
          </a>
        </p>` : ''}
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) RELATÓRIO DIÁRIO DE GATILHOS — substitui o alerta imediato por inserção.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Job diário (instalar via instalarTriggerRelatorioDiario(), 07:00): agrupa
 * por setor os gatilhos (casos tipo 'BA') AINDA PENDENTES DE TRIAGEM (status
 * TRIAGEM) e manda 1 e-mail de resumo por setor para o farmacêutico
 * responsável. Não usa janela de tempo — um caso só sai da lista quando é
 * triado (muda de status), não porque "envelheceu" 24h. Setores sem nenhum
 * gatilho pendente não recebem e-mail.
 */
function enviarRelatorioDiarioGatilhos() {
  const cfg = getConfig();
  if (String(cfg.geral.ALERTAS_ATIVOS || "SIM").toUpperCase() !== "SIM") return;

  // Filtro composto no SERVIDOR (tipo='BA' AND status=TRIAGEM) em vez de
  // fsListarTodos_ + filtro em memória: CASOS é o histórico completo do
  // hospital (só cresce), então buscar a coleção inteira todo dia às 07:00
  // não escalaria — aqui só trafegam os gatilhos que realmente entram no
  // e-mail.
  const casosPendentes = fsQuery_(SCHEMA.FS.CASOS, [
    { campo: 'tipo',   op: 'EQUAL', valor: 'BA' },
    { campo: 'status', op: 'EQUAL', valor: SCHEMA.STATUS.TRIAGEM }
  ]);
  const casosPorSetor = {};

  casosPendentes.forEach(function (caso) {
    const setor = String(caso.setor || '').toUpperCase().trim();
    if (!setor) return;
    if (!casosPorSetor[setor]) casosPorSetor[setor] = [];
    casosPorSetor[setor].push(caso);
  });

  const DIRETORIO = resolverEmailsPorSetor_();
  const EMAIL_COORDENACAO = cfg.geral.EMAIL_COORDENACAO || "farmacia.clinica@hospital.com";
  const LINK_SISTEMA = ScriptApp.getService().getUrl();

  for (const setor in casosPorSetor) {
    const emailDestino = DIRETORIO[setor] || EMAIL_COORDENACAO;
    const listaCasos = casosPorSetor[setor];
    const { assunto, html } = _montarEmailRelatorioDiario_(setor, listaCasos, LINK_SISTEMA);

    try {
      MailApp.sendEmail({ to: emailDestino, subject: assunto, htmlBody: html });
    } catch (e) {
      console.error('Falha ao enviar relatório diário para ' + setor + ' (' + emailDestino + '): ' + e.message);
    }
  }
}

/** Monta assunto + HTML do relatório diário para um setor — usado no envio real e no e-mail de teste. */
function _montarEmailRelatorioDiario_(setor, listaCasos, linkSistema) {
  const setorSeguro = escaparHtml_(setor);
  const assunto = `📋 VigiRAM: Relatório Diário — ${listaCasos.length} Gatilho(s) em ${setor}`;

  let linhas = "";
  listaCasos.forEach(function (c) {
    linhas += `
      <tr>
        <td style="padding:10px;border-bottom:1px solid #ddd;text-align:center;">${escaparHtml_(c.prontuario)}</td>
        <td style="padding:10px;border-bottom:1px solid #ddd;text-align:center;">${escaparHtml_(c.iniciais)}</td>
        <td style="padding:10px;border-bottom:1px solid #ddd;text-align:center;color:#c2410c;font-weight:bold;">${escaparHtml_(c.medicamento)}</td>
        <td style="padding:10px;border-bottom:1px solid #ddd;text-align:center;font-size:12px;">${escaparHtml_(c.data)}</td>
      </tr>`;
  });

  const corpo = `
    <p style="color:#374151;font-size:16px;">Olá,</p>
    <p style="color:#374151;font-size:16px;">Estes são os gatilhos rastreados pelo <b>VigiRAM</b> ainda <b>aguardando triagem</b> no seu setor (<strong>${setorSeguro}</strong>).</p>
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
    </table>`;

  const html = _montarEmailBase_(
    '#f97316',
    'Relatório Diário de Gatilhos',
    'Busca Ativa (Trigger Tool) — pendentes de triagem',
    corpo,
    linkSistema,
    'Abrir VigiRAM'
  );

  return { assunto, html };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) NOVA DEMANDA ESPONTÂNEA — alerta imediato ao farmacêutico do setor.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chamada por salvarDemandaEspontanea() (Cases.gs) logo após o caso ser
 * persistido. Falha ao enviar não deve derrubar o salvamento do caso — por
 * isso tem try/catch próprio e nunca lança.
 */
function notificarNovaDemandaEspontanea_(caso) {
  try {
    const cfg = getConfig();
    if (String(cfg.geral.ALERTAS_ATIVOS || "SIM").toUpperCase() !== "SIM") return;

    const setor = String(caso.setor || '').toUpperCase().trim();
    const DIRETORIO = resolverEmailsPorSetor_();
    const EMAIL_COORDENACAO = cfg.geral.EMAIL_COORDENACAO || "farmacia.clinica@hospital.com";
    const emailDestino = DIRETORIO[setor] || EMAIL_COORDENACAO;
    const LINK_SISTEMA = ScriptApp.getService().getUrl();

    const { assunto, html } = _montarEmailNovaDemandaEspontanea_(caso, LINK_SISTEMA);

    MailApp.sendEmail({ to: emailDestino, subject: assunto, htmlBody: html });
  } catch (e) {
    console.error('notificarNovaDemandaEspontanea_: falha ao enviar e-mail: ' + e.message);
  }
}

/** Monta assunto + HTML do alerta de nova Demanda Espontânea — usado no envio real e no e-mail de teste. */
function _montarEmailNovaDemandaEspontanea_(caso, linkSistema) {
  const setor = String(caso.setor || '').toUpperCase().trim();
  const notificador = caso.notificador || {};
  const assunto = `🔔 VigiRAM: Nova Demanda Espontânea em ${setor}`;

  const corpo = `
    <p style="color:#374151;font-size:16px;">Olá,</p>
    <p style="color:#374151;font-size:16px;">Uma nova <b>Demanda Espontânea</b> foi registrada para o seu setor (<strong>${escaparHtml_(setor)}</strong>) e está aguardando investigação.</p>
    <table style="width:100%;border-collapse:collapse;margin-top:15px;">
      <tbody>
        <tr><td style="padding:8px 10px;color:#6b7280;font-size:12px;width:40%;">Prontuário</td><td style="padding:8px 10px;font-weight:bold;">${escaparHtml_(caso.prontuario)}</td></tr>
        <tr style="background-color:#f9fafb;"><td style="padding:8px 10px;color:#6b7280;font-size:12px;">Paciente</td><td style="padding:8px 10px;">${escaparHtml_(caso.iniciais)}</td></tr>
        <tr><td style="padding:8px 10px;color:#6b7280;font-size:12px;">Medicamento</td><td style="padding:8px 10px;color:#c2410c;font-weight:bold;">${escaparHtml_(caso.medicamento)}</td></tr>
        <tr style="background-color:#f9fafb;"><td style="padding:8px 10px;color:#6b7280;font-size:12px;">Notificado por</td><td style="padding:8px 10px;">${escaparHtml_(notificador.nome || 'N/I')} (${escaparHtml_(notificador.categoria || 'N/I')})</td></tr>
      </tbody>
    </table>
    <p style="color:#374151;font-size:14px;margin-top:20px;">Acesse o VigiRAM para iniciar a investigação deste caso.</p>`;

  const html = _montarEmailBase_(
    '#2563eb',
    'Nova Demanda Espontânea',
    setor,
    corpo,
    linkSistema,
    'Investigar Agora'
  );

  return { assunto, html };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) INVESTIGAÇÃO CONCLUÍDA — alerta ao notificador original (só casos DE).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chamada por registrarInvestigacao() (Cases.gs) quando o caso é encerrado
 * (status CONCLUIDO). Só se aplica a casos de Demanda Espontânea (tipo 'DE'),
 * que têm notificador.email preenchido — casos de Busca Ativa (gatilho) não
 * têm notificador cadastrado. Falha ao enviar não derruba o encerramento do
 * caso — try/catch próprio, nunca lança.
 */
function notificarInvestigacaoConcluida_(caso) {
  try {
    if (caso.tipo !== 'DE') return;

    const notificador = caso.notificador || {};
    const emailNotificador = String(notificador.email || '').trim();
    if (!emailNotificador) return;

    const cfg = getConfig();
    if (String(cfg.geral.ALERTAS_ATIVOS || "SIM").toUpperCase() !== "SIM") return;

    const LINK_FORM = ScriptApp.getService().getUrl() + '?page=form';
    const { assunto, html } = _montarEmailInvestigacaoConcluida_(caso, LINK_FORM);

    MailApp.sendEmail({ to: emailNotificador, subject: assunto, htmlBody: html });
  } catch (e) {
    console.error('notificarInvestigacaoConcluida_: falha ao enviar e-mail: ' + e.message);
  }
}

/** Monta assunto + HTML do alerta de investigação concluída — usado no envio real e no e-mail de teste. */
function _montarEmailInvestigacaoConcluida_(caso, linkForm) {
  const notificador = caso.notificador || {};
  const assunto = `✅ VigiRAM: Investigação Concluída — Caso ${caso.id || caso._id}`;

  const corpo = `
    <p style="color:#374151;font-size:16px;">Olá, ${escaparHtml_(notificador.nome || '')},</p>
    <p style="color:#374151;font-size:16px;">A investigação da notificação espontânea que você registrou foi <b>concluída</b> pela equipe de Farmacovigilância. Obrigado por contribuir com a segurança do paciente.</p>
    <table style="width:100%;border-collapse:collapse;margin-top:15px;">
      <tbody>
        <tr><td style="padding:8px 10px;color:#6b7280;font-size:12px;width:40%;">Prontuário</td><td style="padding:8px 10px;font-weight:bold;">${escaparHtml_(caso.prontuario)}</td></tr>
        <tr style="background-color:#f9fafb;"><td style="padding:8px 10px;color:#6b7280;font-size:12px;">Setor</td><td style="padding:8px 10px;">${escaparHtml_(caso.setor)}</td></tr>
        <tr><td style="padding:8px 10px;color:#6b7280;font-size:12px;">Medicamento</td><td style="padding:8px 10px;color:#c2410c;font-weight:bold;">${escaparHtml_(caso.medicamento)}</td></tr>
        ${caso.desfecho ? `<tr style="background-color:#f9fafb;"><td style="padding:8px 10px;color:#6b7280;font-size:12px;">Desfecho</td><td style="padding:8px 10px;">${escaparHtml_(caso.desfecho)}</td></tr>` : ''}
      </tbody>
    </table>
    <p style="color:#374151;font-size:15px;margin-top:20px;">
      Identificou um novo evento suspeito relacionado a medicamentos? <b>Faça uma nova notificação</b> — quanto antes o caso for reportado, mais rápido a farmácia clínica pode investigar.
    </p>`;

  const html = _montarEmailBase_(
    '#16a34a',
    'Investigação Concluída',
    'Obrigado por notificar',
    corpo,
    linkForm,
    'Fazer Nova Notificação'
  );

  return { assunto, html };
}

// ─────────────────────────────────────────────────────────────────────────────
// E-MAIL DE TESTE (painel Admin) — envia um exemplo com dados fictícios para
// o admin conferir o design/layout antes de confiar no envio automático.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Envia um e-mail de exemplo (dados fictícios) de um dos 3 fluxos deste
 * arquivo para o endereço informado. Só ADMIN pode disparar. Ignora o
 * toggle ALERTAS_ATIVOS de propósito — é um teste manual, não deve
 * depender do alerta estar ligado/desligado.
 * @param {'RELATORIO_DIARIO'|'NOVA_DEMANDA'|'INVESTIGACAO_CONCLUIDA'} tipo
 * @param {string} destinatario
 */
function enviarEmailTeste(tipo, destinatario, token) {
  return _comAdmin_(token, function () {
    const email = String(destinatario || '').trim();
    if (!email) throw new Error('Informe um e-mail de destino para o teste.');

    const LINK_SISTEMA = ScriptApp.getService().getUrl();
    const agora = new Date();
    let montado;

    if (tipo === 'RELATORIO_DIARIO') {
      montado = _montarEmailRelatorioDiario_('UTI ADULTO', [
        { prontuario: '123456', iniciais: 'J.S.', medicamento: 'VANCOMICINA', data: Utilities.formatDate(agora, Session.getScriptTimeZone(), 'dd/MM/yyyy') },
        { prontuario: '654321', iniciais: 'M.A.', medicamento: 'GENTAMICINA', data: Utilities.formatDate(agora, Session.getScriptTimeZone(), 'dd/MM/yyyy') }
      ], LINK_SISTEMA);
    } else if (tipo === 'NOVA_DEMANDA') {
      montado = _montarEmailNovaDemandaEspontanea_({
        setor: 'UTI ADULTO', prontuario: '789012', iniciais: 'P.R.', medicamento: 'INSULINA',
        notificador: { nome: 'Ana Souza', categoria: 'Enfermagem' }
      }, LINK_SISTEMA);
    } else if (tipo === 'INVESTIGACAO_CONCLUIDA') {
      montado = _montarEmailInvestigacaoConcluida_({
        id: 'ESP-789012-000001', prontuario: '789012', setor: 'UTI ADULTO', medicamento: 'INSULINA',
        desfecho: 'Recuperado sem sequelas', notificador: { nome: 'Ana Souza' }
      }, LINK_SISTEMA + '?page=form');
    } else {
      throw new Error('Tipo de e-mail de teste inválido: ' + tipo);
    }

    MailApp.sendEmail({ to: email, subject: '[TESTE] ' + montado.assunto, htmlBody: montado.html });
    return { sucesso: true, mensagem: 'E-mail de teste enviado para ' + email + '.' };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// INSTALAÇÃO DO TRIGGER DIÁRIO (rodar UMA VEZ no editor)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Instala o trigger que roda enviarRelatorioDiarioGatilhos() todo dia às
 * 07:00 (horário do fuso do projeto Apps Script). Rode manualmente no editor:
 * selecione esta função → Executar. Idempotente: não cria duplicatas.
 */
function instalarTriggerRelatorioDiario() {
  const existentes = ScriptApp.getProjectTriggers();
  const jaExiste = existentes.some(function (t) {
    return t.getHandlerFunction() === 'enviarRelatorioDiarioGatilhos';
  });

  if (jaExiste) {
    Logger.log('Trigger enviarRelatorioDiarioGatilhos já instalado — nenhuma ação necessária.');
    return;
  }

  ScriptApp.newTrigger('enviarRelatorioDiarioGatilhos')
    .timeBased()
    .atHour(7)
    .everyDays(1)
    .create();

  Logger.log('✅ Trigger instalado: enviarRelatorioDiarioGatilhos todo dia às 07:00.');
}

/** Remove o trigger diário (use para manutenção ou desativação do relatório). */
function removerTriggerRelatorioDiario() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'enviarRelatorioDiarioGatilhos'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('Trigger enviarRelatorioDiarioGatilhos removido.');
}

/** Confirma se o trigger do relatório diário está instalado. */
function verificarTriggerRelatorioDiario() {
  const instalado = ScriptApp.getProjectTriggers()
    .some(function (t) { return t.getHandlerFunction() === 'enviarRelatorioDiarioGatilhos'; });
  Logger.log(instalado
    ? '✅ Trigger enviarRelatorioDiarioGatilhos está instalado.'
    : '⚠️ Trigger enviarRelatorioDiarioGatilhos NÃO está instalado — rode instalarTriggerRelatorioDiario().');
  return instalado;
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
