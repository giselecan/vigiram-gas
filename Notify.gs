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
