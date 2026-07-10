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
 * FASE 1 (roadmap — investigação do Naranjo não importando no VigiMed,
 * Rodada A das hipóteses H2/H3) — EXPERIMENTAL, PENDENTE DE CONFIRMAÇÃO:
 *   - G.k.9.i.2.r.2 (methodCode): "NARANJO ALGORITHM (score: N)" ->
 *     "Naranjo" (literal). O score migrou para a narrativa (H.1), marcador
 *     "NARANJO: ESCORE N" — ver _montarNarrativa_.
 *   - G.k.9.i.2.r.3 (value ST): "PROVÁVEL" (maiúsculas) -> "Provável"
 *     (Title Case) — ver _titleCasePt_.
 *   - G.k.9.i.2.r.1 (author): texto livre "SENDER" -> código CL21
 *     (ich-role-code) "1" = sender.
 *   Gere um XML de teste, importe em "Não validado" no VigiFlow e confira
 *   se a matriz de causalidade aparece. Se sim: hipótese confirmada, fica
 *   definitivo. Se não: a hipótese muda para H1 (referência órfã por falta
 *   de código MedDRA em E.i.2.1b — nesse caso o próximo passo é colar um
 *   código LLT manualmente em E.i.2.1b, ver roadmap "Rodada B").
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

    const config   = getConfig_();
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
  if (!caso.lote) avisos.push('Lote não preenchido — G.k.4.r.7 sairá em branco.');
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

  // FASE 9: atribuição de IDs E2B é um detalhe técnico interno no Firestore
  // (fonte única) — o caso já foi CONCLUÍDO antes de chegar aqui e já tem
  // sua linha de backup no Sheets (registrarInvestigacao). Não gera nova
  // linha; a exportação em si já é auditada via fsRegistrarLog_('E2B_EXPORTADO', ...)
  // logo abaixo, em gerarXmlE2B.
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
  // Campos gravados como TIMESTAMP no Firestore voltam como Date (ver
  // fsDeValorFs_). Um valor "só-data" persistido assim fica à meia-noite UTC
  // (ex.: new Date('2000-01-01') = 2000-01-01T00:00:00Z); formatá-lo no fuso
  // local (UTC-3) o jogava para o dia ANTERIOR (20000101 → 19991231),
  // corrompendo D.2.1/E.i.4/G.k.4.r.4/D.9.1 em um dia. Detecta a meia-noite
  // UTC exata e formata em UTC nesse caso; timestamps reais (hora ≠ 00:00:00Z,
  // ex.: dataNotificacao) seguem no fuso local, onde o dia-calendário local
  // é o correto.
  let dateOnlyUTC = false;
  if (valor instanceof Date) {
    d = valor;
    dateOnlyUTC = (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 &&
                   d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0);
  } else {
    const s = String(valor).trim();
    const m1 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m1)      d = new Date(parseInt(m1[3]), parseInt(m1[2]) - 1, parseInt(m1[1]));
    else if (m2) d = new Date(parseInt(m2[1]), parseInt(m2[2]) - 1, parseInt(m2[3]));
    else         d = new Date(s);
  }
  if (isNaN(d)) return '';
  const tz = dateOnlyUTC ? 'GMT' : Session.getScriptTimeZone();
  return Utilities.formatDate(d, tz, 'yyyyMMdd');
}

/** 'YYYYMMDDHHMMSS' para o momento atual — usado em creationTime/effectiveTime. */
function _agoraE2B_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMddHHmmss');
}

/**
 * Normaliza a dose para um número decimal com ponto (formato PQ/UCUM do E2B),
 * interpretando as convenções numéricas BR de forma determinística:
 *   "2,5"      → "2.5"    (vírgula = decimal)
 *   "5.000"    → "5000"   (ponto agrupando 3 dígitos = separador de milhar)
 *   "1.000.000"→ "1000000"
 *   "1.000,5"  → "1000.5" (ponto = milhar, vírgula = decimal)
 *   "2.5"      → "2.5"    (ponto isolado sem grupo de milhar = decimal)
 * Evita o value="5.000" (≈5, 1000× menor) e o "1.000.5" (dois pontos → inválido)
 * que o strip simples anterior produzia. Só o campo de dose usa este helper.
 */
function _normalizarDoseE2B_(bruto) {
  let s = String(bruto == null ? '' : bruto).trim();
  if (!s) return '';

  const temVirgula = s.indexOf(',') !== -1;
  const temPonto   = s.indexOf('.') !== -1;

  if (temVirgula && temPonto) {
    // Convenção BR: ponto = milhar, vírgula = decimal.
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (temVirgula) {
    // Só vírgula → decimal.
    s = s.replace(',', '.');
  } else if (temPonto && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    // Só ponto(s), agrupando exatamente 3 dígitos → separador de milhar.
    s = s.replace(/\./g, '');
  }
  // Demais casos (ex.: "2.5") mantêm o ponto como decimal.

  return s.replace(/[^0-9.]/g, '');
}

/**
 * F0-06 — D.2.2a/b Idade no início da reação, em anos completos. Recebe duas
 * datas já em 'YYYYMMDD' (saída de _formatarDataE2B_) para evitar reanalisar
 * o valor bruto do Firestore. Retorna null se faltar alguma data ou o
 * resultado for implausível (paciente "nascido depois" por erro de digitação).
 */
function _calcularIdadeAnosE2B_(nascimentoYYYYMMDD, referenciaYYYYMMDD) {
  if (!nascimentoYYYYMMDD || !referenciaYYYYMMDD) return null;
  const anoNasc = parseInt(nascimentoYYYYMMDD.substring(0, 4), 10);
  const mesNasc = parseInt(nascimentoYYYYMMDD.substring(4, 6), 10);
  const diaNasc = parseInt(nascimentoYYYYMMDD.substring(6, 8), 10);
  const anoRef  = parseInt(referenciaYYYYMMDD.substring(0, 4), 10);
  const mesRef  = parseInt(referenciaYYYYMMDD.substring(4, 6), 10);
  const diaRef  = parseInt(referenciaYYYYMMDD.substring(6, 8), 10);
  let idade = anoRef - anoNasc;
  if (mesRef < mesNasc || (mesRef === mesNasc && diaRef < diaNasc)) idade--;
  return (idade >= 0 && idade < 130) ? idade : null;
}

/**
 * F2-05 — dias corridos entre duas datas 'YYYYMMDD' (saída de
 * _formatarDataE2B_). Usado para E.i.6a/b (duração da reação), derivada
 * de E.i.4/E.i.5 em vez de coletada separadamente. Retorna null se
 * qualquer data faltar ou o resultado for negativo (fim antes do início —
 * erro de digitação, não envia duração errada).
 */
function _diasEntreE2B_(inicioYYYYMMDD, fimYYYYMMDD) {
  if (!inicioYYYYMMDD || !fimYYYYMMDD) return null;
  const d1 = new Date(
    parseInt(inicioYYYYMMDD.substring(0, 4), 10),
    parseInt(inicioYYYYMMDD.substring(4, 6), 10) - 1,
    parseInt(inicioYYYYMMDD.substring(6, 8), 10)
  );
  const d2 = new Date(
    parseInt(fimYYYYMMDD.substring(0, 4), 10),
    parseInt(fimYYYYMMDD.substring(4, 6), 10) - 1,
    parseInt(fimYYYYMMDD.substring(6, 8), 10)
  );
  if (isNaN(d1) || isNaN(d2)) return null;
  const dias = Math.round((d2 - d1) / 86400000);
  return (dias >= 0) ? dias : null;
}

/**
 * F2-09 — monta o <component> de UM exame estruturado (F.r). Sem MedDRA:
 * nome do teste sai como texto livre (F.r.2.1), igual ao padrão do
 * "teste #2" do exemplo oficial (1-1_ExampleCase_literature_initial_v1_0.xml,
 * linhas 259-270). Resultado numérico COM unidade vira PQ (F.r.3.2/3.3);
 * qualquer outro caso (texto, ou numérico sem unidade — PQ exige unidade
 * confiável) cai em ED (F.r.3.4), igual ao restante do texto livre do
 * projeto. Faixa de referência (F.r.5/F.r.6) só sai se o resultado for
 * numérico — comparar texto livre contra min/máx não faz sentido.
 */
function _montarComponenteExameE2B_(exame) {
  const nome     = escaparHtml_(String((exame && exame.nome) || 'EXAME COMPLEMENTAR').trim().toUpperCase());
  const dataExame = _formatarDataE2B_(exame && exame.data);
  const unidade  = escaparHtml_(String((exame && exame.unidade) || '').trim());
  const valorRaw = String((exame && exame.valor) || '').trim();
  const valorNum = valorRaw.replace(',', '.');
  const ehNumerico = valorRaw !== '' && unidade !== '' && !isNaN(Number(valorNum));

  const refMin = String((exame && exame.refMin) || '').trim().replace(',', '.');
  const refMax = String((exame && exame.refMax) || '').trim().replace(',', '.');
  const temRefMin = ehNumerico && refMin !== '' && !isNaN(Number(refMin));
  const temRefMax = ehNumerico && refMax !== '' && !isNaN(Number(refMax));

  return (
    '                      <component typeCode="COMP">\n' +
    '                        <observation classCode="OBS" moodCode="EVN">\n' +
    '                          <code codeSystem="2.16.840.1.113883.6.163">\n' +
    '                            <originalText>' + nome + '</originalText>\n' +
    '                            <!-- F.r.2.1: Test Name (free text) -->\n' +
    '                          </code>\n' +
    (dataExame
      ? '                          <effectiveTime value="' + dataExame + '"/>\n' +
        '                          <!-- F.r.1: Test Date -->\n'
      : '') +
    (ehNumerico
      ? '                          <value xsi:type="PQ" value="' + valorNum + '" unit="' + unidade + '"/>\n' +
        '                          <!-- F.r.3.2/F.r.3.3: Test Result (value/unit) -->\n'
      : (valorRaw
          ? '                          <value xsi:type="ED">' + escaparHtml_(valorRaw.toUpperCase()) + '</value>\n' +
            '                          <!-- F.r.3.4: Result Unstructured Data (free text) -->\n'
          : '')
      ) +
    (temRefMax
      ? '                          <referenceRange typeCode="REFV">\n' +
        '                            <observationRange classCode="OBS" moodCode="EVN.CRT">\n' +
        '                              <value xsi:type="PQ" value="' + refMax + '" unit="' + unidade + '"/>\n' +
        '                              <interpretationCode code="H" codeSystem="2.16.840.1.113883.5.83"/>\n' +
        '                              <!-- F.r.5: Normal High Value -->\n' +
        '                            </observationRange>\n' +
        '                          </referenceRange>\n'
      : '') +
    (temRefMin
      ? '                          <referenceRange typeCode="REFV">\n' +
        '                            <observationRange classCode="OBS" moodCode="EVN.CRT">\n' +
        '                              <value xsi:type="PQ" value="' + refMin + '" unit="' + unidade + '"/>\n' +
        '                              <interpretationCode code="L" codeSystem="2.16.840.1.113883.5.83"/>\n' +
        '                              <!-- F.r.6: Normal Low Value -->\n' +
        '                            </observationRange>\n' +
        '                          </referenceRange>\n'
      : '') +
    '                        </observation>\n' +
    '                      </component>\n'
  );
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

/**
 * FASE 1 (roadmap, Rodada A) — "PROVÁVEL" -> "Provável". Só a primeira letra
 * maiúscula; funciona para os 4 rótulos de uma palavra do Naranjo
 * (DUVIDOSA/POSSÍVEL/PROVÁVEL/DEFINIDA). Não é title-case genérico de frase.
 */
function _titleCasePt_(palavra) {
  const s = String(palavra || '').trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
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
function _montarNarrativa_(caso, naranjoScore) {
  const base = String(
    caso.relato || caso.relatoNotificador || caso.reacaoTermo || ''
  ).trim();

  const secoes = [
    { rotulo: 'EXAMES COMPLEMENTARES',          valor: caso.exames },
    { rotulo: 'CONDUTA DO NOTIFICADOR',         valor: caso.condutaNotificador },
    { rotulo: 'EVOLUCAO POS CONDUTAS',          valor: caso.evolucao },
    { rotulo: 'CONCLUSAO DO FARMACEUTICO',      valor: caso.conclusao },
    { rotulo: 'HISTORIA CLINICA RELEVANTE',     valor: caso.historiaClinica },
    { rotulo: 'OBSERVACOES',                    valor: caso.observacoes },
    // FASE 1 (roadmap, Rodada A) — o escore numérico do Naranjo saiu do
    // methodCode de G.k.9.i.2.r (agora "Naranjo" literal, ver
    // causalityAssessment em _montarXmlE2B_) e não tem mais elemento
    // dedicado no bloco de causalidade; preservado aqui na narrativa.
    { rotulo: 'NARANJO',                        valor: naranjoScore ? ('ESCORE ' + naranjoScore) : '' },
    // F2-13 — Gestante/Lactante não têm elemento próprio no core do
    // E2B(R3) (confirmado: ausentes no exemplo oficial e na Reference
    // Instance v3.1) — só a data da DUM (D.6) tem elemento dedicado
    // (ver blocoDum em _montarXmlE2B_). Os dois flags ficam na narrativa.
    { rotulo: 'GESTANTE/LACTANTE',              valor: [caso.gestante ? 'GESTANTE' : '', caso.lactante ? 'LACTANTE' : '']
                                                          .filter(Boolean).join(' E ') }
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

  // safetyReportId entra em atributos @extension de <id>. É derivado do idCaso
  // ('BR-HRN-' + idCaso), que — ao contrário dos nós de texto livre — não
  // passava por escape; um idCaso com caractere XML-especial (& < ") tornaria
  // o documento inteiro mal-formado e rejeitado. idReacaoE2B/idMedicamentoE2B
  // são UUIDs (sempre seguros), não precisam de escape. O nome do arquivo
  // (gerarXmlE2B) segue usando o valor cru, não a versão escapada.
  const safetyIdXml = escaparHtml_(String(caso.safetyReportIdE2B || ''));

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

  // F0-06 — D.2.2a/b Idade no início da reação (0..1: omitido se faltar nascimento
  // ou data de início da reação, ou o resultado for implausível).
  const idadeReacaoAnos = _calcularIdadeAnosE2B_(dataNascimento, dataInicioReacao);

  // F2-06 — D.3/D.4 Peso (kg) e Altura (cm). Só emite se numérico.
  const pesoKgE2B   = String(caso.pesoKg   || '').trim().replace(',', '.');
  const alturaCmE2B = String(caso.alturaCm || '').trim().replace(',', '.');

  // F2-13 — D.6 DUM. Gestante/Lactante não têm elemento próprio no core
  // do E2B(R3) — confirmado: ausentes tanto no exemplo oficial quanto na
  // Reference Instance v3.1 — ficam só na narrativa (ver _montarNarrativa_).
  const dumE2B = _formatarDataE2B_(caso.dum);

  // F2-05 — E.i.5 Data fim da reação + E.i.6a/b duração derivada (dias).
  const dataFimReacaoE2B  = _formatarDataE2B_(caso.dataFimReacao);
  const duracaoReacaoDias = _diasEntreE2B_(dataInicioReacao, dataFimReacaoE2B);

  // F2-10 — D.9.1 Data do óbito. Só emite se o desfecho for ÓBITO — evita
  // enviar deceasedTime num caso que não terminou em óbito por resíduo de
  // um valor antigo do campo (ex.: caso reaberto e desfecho alterado).
  const dataObitoE2B = (String(caso.desfecho || '').toUpperCase() === 'ÓBITO')
    ? _formatarDataE2B_(caso.dataObito)
    : '';

  // D.5 Sexo — mapeia valor livre vindo do ETL; sem match cai em nullFlavor="UNK" (ver abaixo).
  const codigoSexo = SCHEMA.E2B.SEXO_MAP[String(caso.sexo || '').toUpperCase()] || null;

  // E.i.7 Desfecho — codelist oficial ICH CL11 (…2.1.1.11): 1 Recovered/resolved,
  // 2 Recovering/resolving, 3 Not recovered/not resolved, 4 Recovered w/ sequelae,
  // 5 Fatal, 6 Unknown. NÃO existe '0' nessa codelist — usá-lo torna o E.i.7
  // (obrigatório 1..1) inválido e o VigiMed rejeita o relatório. Fallback correto
  // é '6' (Unknown), coerente com Schema.gs (DESFECHO_MAP) e com o aviso ao
  // farmacêutico em _validarCasoParaE2B_. Desfechos do dropdown ainda não
  // mapeados (ex.: "ALTA", "PROLONGADO INTERNAÇÃO") caem aqui como Desconhecido —
  // se quiser semântica específica, adicione-os em SCHEMA.E2B.DESFECHO_MAP.
  const codigoDesfecho = SCHEMA.E2B.DESFECHO_MAP[String(caso.desfecho || '').toUpperCase()] || '6';

  // F0-01 — G.k.9.i.4 Reexposição. 0..1: sem match (campo vazio ou "Sim"/"Não"
  // fora do vocabulário do dropdown), o bloco correspondente é omitido no XML.
  const codigoReexposicao = SCHEMA.E2B.REEXPOSICAO_MAP[String(caso.readministrado || '').toUpperCase()] || null;

  // F0-04 — E.i.3.1 Termo destacado. caso.gravidade já foi validado contra
  // GRAVIDADE_MAP em _validarCasoParaE2B_ (mesmas chaves), então sempre resolve;
  // fallback '2' só por defesa extra.
  const codigoTermoDestacado = SCHEMA.E2B.TERMO_DESTACADO_MAP[String(caso.gravidade).toUpperCase()] || '2';

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

  // F0-02 — D.7.1.r.5 (comentário de história médica, texto livre, sem MedDRA).
  const historiaClinicaE2B = escaparHtml_(String(caso.historiaClinica || '').trim().toUpperCase());
  // F0-03 — F.r.2.1 (nome do teste, texto livre) + F.r.3.4 (resultado não estruturado).
  const examesE2B = escaparHtml_(String(caso.exames || '').trim().toUpperCase());

  // FASE 1 (roadmap, Rodada A) — score sai do methodCode (agora valor literal
  // fixo "Naranjo", ver causalityAssessment abaixo) e migra para a narrativa,
  // já que G.k.9.i.2.r.1 (fonte) também deixou de ser texto livre.
  const naranjoScore  = _calcularScoreNaranjo_(caso.naranjoRespostas);
  // H.1/D.14 Narrativa — todos os campos descritivos da investigação.
  const narrativa = _montarNarrativa_(caso, naranjoScore);

  const reacaoTermo   = escaparHtml_(String(caso.reacaoTermo).toUpperCase());
  const medicamento   = escaparHtml_(String(caso.medicamento).toUpperCase());
  const viaOuForma    = escaparHtml_(String(caso.viaAdministracao || 'NAO INFORMADO').toUpperCase());
  // CORREÇÃO: dose com vírgula decimal BR ("2,5") era mutilada pelo strip
  // antigo (/[^0-9.]/) → "25" — dose 10× maior num relatório REGULATÓRIO.
  // O strip anterior também mantinha o PONTO usado como separador de MILHAR:
  // "5.000" (5000 UI, convenção BR) virava value="5.000" ≈ 5 (1000× menor) e
  // "1.000,5" virava "1.000.5" (dois pontos → PQ inválido). _normalizarDoseE2B_
  // resolve as convenções BR de forma determinística (ver helper).
  const dose          = _normalizarDoseE2B_(caso.doseMedicamento);
  const doseUnidade   = escaparHtml_(String(caso.doseUnidade || '').toLowerCase()) || 'mg';
  const lote          = escaparHtml_(String(caso.lote || '').toUpperCase());
  // F0-09 — G.k.3.3 Nome do detentor/fabricante.
  const laboratorioE2B = escaparHtml_(String(caso.laboratorio || '').toUpperCase());

  // F2-07 — G.k.4.r.9.1 Forma farmacêutica (texto livre).
  const formaFarmaceuticaE2B = escaparHtml_(String(caso.formaFarmaceutica || '').trim().toUpperCase());

  // F2-04 — G.k.4.r.5 Data fim da administração.
  const dataFimAdministracaoE2B = _formatarDataE2B_(caso.dataFimAdministracao);

  // F2-08 — G.k.4.r.2/3 Nº de doses no intervalo + unidade (token UCUM).
  // Só forma o bloco de periodicidade se AMBOS os dados baterem — período
  // sem unidade (ou vice-versa) não é um PIVL_TS válido.
  const numeroDosesIntervaloE2B = String(caso.numeroDosesIntervalo || '').replace(/[^0-9.]/g, '');
  const unidadeIntervaloE2B = SCHEMA.E2B.UNIDADE_INTERVALO_MAP[String(caso.unidadeIntervalo || '').toUpperCase()] || '';

  // F2-03 — G.k.7.r.1 Indicação de uso (texto livre, sem MedDRA — mesmo
  // padrão nullFlavor="NI" já usado em E.i.2.1b e D.7.1.r.1b).
  const indicacaoUsoE2B = escaparHtml_(String(caso.indicacaoUso || '').trim().toUpperCase());

  // F2-01 — G.k.8 Ação adotada com o medicamento (CL15). 0..1: omitido
  // se vazio/sem match.
  const codigoAcaoAdotada = SCHEMA.E2B.ACAO_MEDICAMENTO_MAP[String(caso.acaoAdotada || '').toUpperCase()] || null;

  // F2-11 — G.k.1 Caracterização do papel do medicamento (CL13). Fallback
  // '1' (Suspeito) preserva o comportamento hardcoded anterior para casos
  // sem o campo preenchido ainda.
  const codigoCaracterizacao = SCHEMA.E2B.CARACTERIZACAO_DROGA_MAP[String(caso.relacaoMedicamentoEvento || '').toUpperCase()] || '1';

  // F2-12 — G.k.10.r Outras informações sobre o medicamento (CL17,
  // multi-select 0..N). Itens sem match no mapa são ignorados (não travam
  // a exportação por uma opção antiga/renomeada na lista).
  const problemasAdicionaisLista = Array.isArray(caso.problemasAdicionais) ? caso.problemasAdicionais : [];
  const blocoProblemasAdicionais = problemasAdicionaisLista
    .map(function (p) {
      const codigo = SCHEMA.E2B.PROBLEMAS_ADICIONAIS_MAP[String(p || '').toUpperCase()];
      if (!codigo) return '';
      return '                          <outboundRelationship2 typeCode="REFR">\n' +
             '                            <observation classCode="OBS" moodCode="EVN">\n' +
             '                              <code code="9" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
             '                              <value xsi:type="CE" code="' + codigo + '" codeSystem="' + SCHEMA.E2B.CODESYS.PROBLEMAS_ADICIONAIS + '"/>\n' +
             '                              <!-- G.k.10.r: Additional Information on Drug (coded) -->\n' +
             '                            </observation>\n' +
             '                          </outboundRelationship2>\n';
    })
    .join('');

  // F2-04/F2-08 — effectiveTime do G.k.4.r: combina início (G.k.4.r.4,
  // já existente) com fim (G.k.4.r.5) e periodicidade (G.k.4.r.2/3)
  // quando disponíveis. Só entra em SXPR_TS (dois <comp>) se numeroDoses
  // E unidade baterem os DOIS — período parcial não é um PIVL_TS válido;
  // nesse caso cai no IVL_TS simples de sempre (com <high> se houver fim).
  // Padrão confirmado no exemplo oficial (linhas 350-361).
  const temPeriodoAdm = numeroDosesIntervaloE2B !== '' && unidadeIntervaloE2B !== '';
  const blocoEffectiveTimeAdm = temPeriodoAdm
    ? '                              <effectiveTime xsi:type="SXPR_TS">\n' +
      '                                <comp xsi:type="PIVL_TS">\n' +
      '                                  <period value="' + numeroDosesIntervaloE2B + '" unit="' + unidadeIntervaloE2B + '"/>\n' +
      '                                  <!-- G.k.4.r.2: Number of Units in the Interval -->\n' +
      '                                  <!-- G.k.4.r.3: Definition of the Time Interval Unit -->\n' +
      '                                </comp>\n' +
      '                                <comp xsi:type="IVL_TS" operator="A">\n' +
      '                                  <low value="' + dataInicioAdministracao + '"/>\n' +
      '                                  <!-- G.k.4.r.4: Date and Time of Start of Drug -->\n' +
      (dataFimAdministracaoE2B
        ? '                                  <high value="' + dataFimAdministracaoE2B + '"/>\n' +
          '                                  <!-- G.k.4.r.5: Date and Time of Last Administration -->\n'
        : '') +
      '                                </comp>\n' +
      '                              </effectiveTime>\n'
    : '                              <effectiveTime xsi:type="IVL_TS">\n' +
      '                                <low value="' + dataInicioAdministracao + '"/>\n' +
      '                                <!-- G.k.4.r.4: Date and Time of Start of Drug -->\n' +
      (dataFimAdministracaoE2B
        ? '                                <high value="' + dataFimAdministracaoE2B + '"/>\n' +
          '                                <!-- G.k.4.r.5: Date and Time of Last Administration -->\n'
        : '') +
      '                              </effectiveTime>\n';

  // F2-05 — effectiveTime da reação: adiciona E.i.5 (fim) e E.i.6a/b
  // (duração derivada) quando há data de fim. Padrão confirmado no
  // exemplo oficial (linhas 134-146). Sem data de fim, mantém o IVL_TS
  // simples de sempre (só E.i.4).
  const blocoEffectiveTimeReacao = dataFimReacaoE2B
    ? '                      <effectiveTime xsi:type="SXPR_TS">\n' +
      '                        <comp xsi:type="IVL_TS">\n' +
      '                          <low value="' + dataInicioReacao + '"/>\n' +
      '                          <!-- E.i.4: Date of Start of Reaction / Event -->\n' +
      '                          <high value="' + dataFimReacaoE2B + '"/>\n' +
      '                          <!-- E.i.5: Date of End of Reaction / Event -->\n' +
      '                        </comp>\n' +
      (duracaoReacaoDias !== null
        ? '                        <comp xsi:type="IVL_TS" operator="A">\n' +
          '                          <width value="' + duracaoReacaoDias + '" unit="d"/>\n' +
          '                          <!-- E.i.6a/b: Duration of Reaction / Event -->\n' +
          '                        </comp>\n'
        : '') +
      '                      </effectiveTime>\n'
    : '                      <effectiveTime xsi:type="IVL_TS">\n' +
      '                        <low value="' + dataInicioReacao + '"/>\n' +
      '                      </effectiveTime>\n';

  // FASE 1 (roadmap, Rodada A / hipótese H2): testar se o VigiMed espera
  // "Provável" (Title Case, como no rótulo da própria tela) em vez de
  // "PROVÁVEL" (maiúsculas, como todo o resto do XML). PENDENTE DE
  // CONFIRMAÇÃO — gerar XML de teste, importar em "Não validado" no
  // VigiFlow e conferir se a matriz de causalidade aparece antes de
  // considerar isto definitivo.
  const naranjoClasse = escaparHtml_(_titleCasePt_(String(caso.naranjo || 'DUVIDOSA')));

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

  // F0-04 — mesmo padrão estrutural de blocosGravidade/blocoDesfecho
  // (outboundRelationship2 > observation dentro da observation da reação).
  const blocoTermoDestacado =
    '                      <outboundRelationship2 typeCode="PERT">\n' +
    '                        <observation classCode="OBS" moodCode="EVN">\n' +
    '                          <code code="37" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
    '                          <value xsi:type="CE" code="' + codigoTermoDestacado + '" codeSystem="' + SCHEMA.E2B.CODESYS.TERMO_DESTACADO + '"/>\n' +
    '                          <!-- E.i.3.1: Term Highlighted by the Reporter -->\n' +
    '                        </observation>\n' +
    '                      </outboundRelationship2>';

  // F0-01 — G.k.9.i.4. Estruturalmente análogo aos blocos acima, mas fica no
  // substanceAdministration do medicamento (G.k), não na observation da
  // reação (E.i) — ver ponto de inserção mais abaixo. 0..1: string vazia
  // quando não há reexposição mapeada.
  const blocoReexposicao = codigoReexposicao
    ? '                          <outboundRelationship2 typeCode="PERT">\n' +
      '                            <observation classCode="OBS" moodCode="EVN">\n' +
      '                              <code code="31" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
      '                              <value xsi:type="CE" code="' + codigoReexposicao + '" codeSystem="' + SCHEMA.E2B.CODESYS.REEXPOSICAO + '"/>\n' +
      '                              <!-- G.k.9.i.4: Did Reaction Recur on Readministration -->\n' +
      '                            </observation>\n' +
      '                          </outboundRelationship2>\n'
    : '';

  // F2-03 — G.k.7.r.1 Indicação de uso. inboundRelationship RSON no
  // substanceAdministration do medicamento — padrão confirmado no exemplo
  // oficial (linhas 395-410 do IG_Complete_Package_v1_11_1). Sem MedDRA:
  // nullFlavor="NI" + originalText, mesmo padrão de E.i.2.1b/D.7.1.r.1b.
  const blocoIndicacao = indicacaoUsoE2B
    ? '                          <inboundRelationship typeCode="RSON">\n' +
      '                            <observation classCode="OBS" moodCode="EVN">\n' +
      '                              <code code="19" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
      '                              <value xsi:type="CE" nullFlavor="NI">\n' +
      '                                <originalText>' + indicacaoUsoE2B + '</originalText>\n' +
      '                                <!-- G.k.7.r.1: Indication as Reported by the Primary Source -->\n' +
      '                              </value>\n' +
      '                            </observation>\n' +
      '                          </inboundRelationship>\n'
    : '';

  // F2-01 — G.k.8 Ação adotada com o medicamento. inboundRelationship
  // CAUS — padrão confirmado no exemplo oficial (linhas 411-416).
  const blocoAcaoAdotada = codigoAcaoAdotada
    ? '                          <inboundRelationship typeCode="CAUS">\n' +
      '                            <act classCode="ACT" moodCode="EVN">\n' +
      '                              <code code="' + codigoAcaoAdotada + '" codeSystem="' + SCHEMA.E2B.CODESYS.ACAO_MEDICAMENTO + '"/>\n' +
      '                              <!-- G.k.8: Action(s) Taken with Drug -->\n' +
      '                            </act>\n' +
      '                          </inboundRelationship>\n'
    : '';

  // F0-09 — G.k.3.3 Nome do detentor/fabricante, dentro de
  // asManufacturedProduct > subjectOf > approval > holder > role >
  // playingOrganization > name. <id> (G.k.3.1) e <author> (G.k.3.2) do
  // <approval> são minOccurs="0" no schema (POCP_MT050100UV.xsd) — como não
  // temos nº de autorização nem país de registro, o bloco sai só com
  // <holder>, estrutura ainda assim válida. Ordem de <asManufacturedProduct>
  // dentro de kindOfProduct (após <name>, antes de <ingredient>) confirmada
  // em POCP_MT010200UV.xsd (POCP_MT010200UV.Product) e no exemplo oficial.
  const blocoFabricante = laboratorioE2B
    ? '                                <asManufacturedProduct classCode="MANU">\n' +
      '                                  <subjectOf typeCode="SBJ">\n' +
      '                                    <approval classCode="CNTRCT" moodCode="EVN">\n' +
      '                                      <holder typeCode="HLD">\n' +
      '                                        <role classCode="HLD">\n' +
      '                                          <playingOrganization classCode="ORG" determinerCode="INSTANCE">\n' +
      '                                            <name>' + laboratorioE2B + '</name>\n' +
      '                                            <!-- G.k.3.3: Name of Holder / Applicant -->\n' +
      '                                          </playingOrganization>\n' +
      '                                        </role>\n' +
      '                                      </holder>\n' +
      '                                    </approval>\n' +
      '                                  </subjectOf>\n' +
      '                                </asManufacturedProduct>\n'
    : '';

  // F0-06 — D.2.2a/b, sibling de player1 dentro de primaryRole (padrão
  // confirmado em 6_Example Instances/1-1_ExampleCase_literature_initial_v1_0.xml,
  // linhas 78-85 do IG_Complete_Package_v1_11_1).
  const blocoIdade = (idadeReacaoAnos !== null)
    ? '                  <subjectOf2 typeCode="SBJ">\n' +
      '                    <observation classCode="OBS" moodCode="EVN">\n' +
      '                      <code code="3" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
      '                      <value xsi:type="PQ" value="' + idadeReacaoAnos + '" unit="a"/>\n' +
      '                      <!-- D.2.2a/b: Age at Time of Onset of Reaction / Event -->\n' +
      '                    </observation>\n' +
      '                  </subjectOf2>\n'
    : '';

  // F2-06 — D.3 Peso (kg) / D.4 Altura (cm). Padrão confirmado no exemplo
  // oficial (linhas 86-98): subjectOf2 > observation, code="7"/"17".
  const blocoPeso = (pesoKgE2B !== '' && !isNaN(Number(pesoKgE2B)))
    ? '                  <subjectOf2 typeCode="SBJ">\n' +
      '                    <observation classCode="OBS" moodCode="EVN">\n' +
      '                      <code code="7" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
      '                      <value xsi:type="PQ" value="' + pesoKgE2B + '" unit="kg"/>\n' +
      '                      <!-- D.3: Body Weight (kg) -->\n' +
      '                    </observation>\n' +
      '                  </subjectOf2>\n'
    : '';
  const blocoAltura = (alturaCmE2B !== '' && !isNaN(Number(alturaCmE2B)))
    ? '                  <subjectOf2 typeCode="SBJ">\n' +
      '                    <observation classCode="OBS" moodCode="EVN">\n' +
      '                      <code code="17" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
      '                      <value xsi:type="PQ" value="' + alturaCmE2B + '" unit="cm"/>\n' +
      '                      <!-- D.4: Height (cm) -->\n' +
      '                    </observation>\n' +
      '                  </subjectOf2>\n'
    : '';

  // F2-13 — D.6 Data da última menstruação. Padrão confirmado no exemplo
  // oficial (linhas 100-106): code="22", value TS.
  const blocoDum = dumE2B
    ? '                  <subjectOf2 typeCode="SBJ">\n' +
      '                    <observation classCode="OBS" moodCode="EVN">\n' +
      '                      <code code="22" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
      '                      <value xsi:type="TS" value="' + dumE2B + '"/>\n' +
      '                      <!-- D.6: Last Menstrual Period Date -->\n' +
      '                    </observation>\n' +
      '                  </subjectOf2>\n'
    : '';

  // F0-02 — D.7.1.r.5, dentro de organizer classCode="CATEGORY" code="1"
  // (relevantMedicalHistoryAndConcurrentConditions). O <code> do item de
  // história é 1..1 no schema (PORR_MT049023UV.Observation) mesmo sem
  // MedDRA — sai nullFlavor="NI", mesmo padrão já usado em E.i.2.1b. O
  // comentário livre entra em outboundRelationship2/observation code="10",
  // confirmado em 5_Reference Instances/00_ICH_ICSR_Reference_Instance_variation_v3_1.xml
  // (linhas 406-412).
  const blocoHistoriaMedica = historiaClinicaE2B
    ? '                  <subjectOf2 typeCode="SBJ">\n' +
      '                    <organizer classCode="CATEGORY" moodCode="EVN">\n' +
      '                      <code code="1" codeSystem="' + SCHEMA.E2B.CODESYS.CATEGORIA_GK + '"/>\n' +
      '                      <component typeCode="COMP">\n' +
      '                        <observation classCode="OBS" moodCode="EVN">\n' +
      '                          <code nullFlavor="NI" codeSystem="2.16.840.1.113883.6.163"/>\n' +
      '                          <!-- D.7.1.r.1b: sem licenca MedDRA ativa -->\n' +
      '                          <outboundRelationship2 typeCode="COMP">\n' +
      '                            <observation classCode="OBS" moodCode="EVN">\n' +
      '                              <code code="10" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
      '                              <value xsi:type="ED">' + historiaClinicaE2B + '</value>\n' +
      '                              <!-- D.7.1.r.5: Comments -->\n' +
      '                            </observation>\n' +
      '                          </outboundRelationship2>\n' +
      '                        </observation>\n' +
      '                      </component>\n' +
      '                    </organizer>\n' +
      '                  </subjectOf2>\n'
    : '';

  // F0-03 — F.r.2.1 (nome do teste, texto livre, sem atributo code) +
  // F.r.3.4 (resultado não estruturado). Padrão do "teste #2" confirmado em
  // 6_Example Instances/1-1_ExampleCase_literature_initial_v1_0.xml
  // (linhas 259-270 do IG_Complete_Package_v1_11_1) — mesmo organizer
  // classCode="CATEGORY" code="3" (testResults) usado com MedDRA no "teste #1".
  //
  // F2-09 — exames estruturados (subtabela repetível) entram como
  // <component> ADICIONAIS dentro do MESMO organizer, um por linha —
  // mesma lógica de "teste #1 + teste #2" do exemplo oficial, só que aqui
  // todos são texto livre (sem MedDRA). Ver _montarComponenteExameE2B_.
  const componentesExamesEstruturados = (Array.isArray(caso.examesEstruturados) ? caso.examesEstruturados : [])
    .filter(function (e) { return e && (e.nome || e.valor); })
    .map(_montarComponenteExameE2B_)
    .join('');
  const blocoExames = (examesE2B || componentesExamesEstruturados)
    ? '                  <subjectOf2 typeCode="SBJ">\n' +
      '                    <organizer classCode="CATEGORY" moodCode="EVN">\n' +
      '                      <code code="3" codeSystem="' + SCHEMA.E2B.CODESYS.CATEGORIA_GK + '"/>\n' +
      (examesE2B
        ? '                      <component typeCode="COMP">\n' +
          '                        <observation classCode="OBS" moodCode="EVN">\n' +
          '                          <code codeSystem="2.16.840.1.113883.6.163">\n' +
          '                            <originalText>EXAME COMPLEMENTAR</originalText>\n' +
          '                            <!-- F.r.2.1: Test Name (free text) -->\n' +
          '                          </code>\n' +
          '                          <value xsi:type="ED">' + examesE2B + '</value>\n' +
          '                          <!-- F.r.3.4: Result Unstructured Data (free text) -->\n' +
          '                        </observation>\n' +
          '                      </component>\n'
        : '') +
      componentesExamesEstruturados +
      '                    </organizer>\n' +
      '                  </subjectOf2>\n'
    : '';

  // F0-08 — H.5.r.1a/b, mesma narrativa de H.1 com idioma nativo. Padrão
  // confirmado em 6_Example Instances/1-1_ExampleCase_literature_initial_v1_0.xml
  // (linhas 504-516). Autor = sender (farmacêutico/remetente), coerente com
  // H.4 (mesma decisão de identidade já usada ali).
  const blocoResumoNativo =
    '              <!-- H.5.r: Case Summary and Reporter\'s Comments in Native Language -->\n' +
    '              <component1 typeCode="COMP">\n' +
    '                <observationEvent classCode="OBS" moodCode="EVN">\n' +
    '                  <code code="36" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
    '                  <value xsi:type="ED" language="por">' + narrativa + '</value>\n' +
    '                  <author typeCode="AUT">\n' +
    '                    <assignedEntity classCode="ASSIGNED">\n' +
    '                      <code code="1" codeSystem="' + SCHEMA.E2B.CODESYS.AUTOR_COMENTARIO + '" displayName="sender"/>\n' +
    '                    </assignedEntity>\n' +
    '                  </author>\n' +
    '                </observationEvent>\n' +
    '              </component1>\n' +
    '\n';

  return (
'<?xml version="1.0" encoding="UTF-8"?>\n' +
'<MCCI_IN200100UV01 ITSVersion="XML_1.0" xsi:schemaLocation="urn:hl7-org:v3 MCCI_IN200100UV01.xsd" xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n' +
'  <id extension="' + safetyIdXml + '-BATCH" root="2.16.840.1.113883.3.989.2.1.3.22"/>\n' +
'  <creationTime value="' + agora + '"/>\n' +
'  <responseModeCode code="D"/>\n' +
'  <interactionId extension="MCCI_IN200100UV01" root="2.16.840.1.113883.1.6"/>\n' +
'  <name code="1" codeSystem="' + SCHEMA.E2B.CODESYS.TIPO_RELATO + '"/>\n' +
'  <PORR_IN049016UV>\n' +
'    <id extension="' + safetyIdXml + '" root="2.16.840.1.113883.3.989.2.1.3.1"/>\n' +
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
'          <id extension="' + safetyIdXml + '" root="2.16.840.1.113883.3.989.2.1.3.1"/>\n' +
'          <id extension="' + safetyIdXml + '" root="2.16.840.1.113883.3.989.2.1.3.2"/>\n' +
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
(dataObitoE2B
  ? '                    <deceasedTime value="' + dataObitoE2B + '"/>\n' +
    '                    <!-- D.9.1: Date of Death -->\n'
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
blocoIdade +
blocoPeso +
blocoAltura +
blocoDum +
blocoHistoriaMedica +
'                  <!-- E.i Reacao -->\n' +
'                  <subjectOf2 typeCode="SBJ">\n' +
'                    <observation classCode="OBS" moodCode="EVN">\n' +
'                      <id root="' + caso.idReacaoE2B + '"/>\n' +
'                      <code code="29" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
blocoEffectiveTimeReacao +
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
blocoTermoDestacado + '\n' +
'                    </observation>\n' +
'                  </subjectOf2>\n' +
'\n' +
blocoExames +
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
blocoFabricante +
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
blocoEffectiveTimeAdm +
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
(formaFarmaceuticaE2B
  ? '                                    <formCode>\n' +
    '                                      <originalText>' + formaFarmaceuticaE2B + '</originalText>\n' +
    '                                      <!-- G.k.4.r.9.1: Pharmaceutical Dose Form (free text) -->\n' +
    '                                    </formCode>\n'
  : '                                    <!-- G.k.4.r.9.1 Forma farmaceutica: nao informada -->\n'
) +
'                                  </kindOfProduct>\n' +
'                                </instanceOfKind>\n' +
'                              </consumable>\n' +
'                            </substanceAdministration>\n' +
'                          </outboundRelationship2>\n' +
blocoProblemasAdicionais +
blocoReexposicao +
blocoIndicacao +
blocoAcaoAdotada +
'                        </substanceAdministration>\n' +
'                      </component>\n' +
'                    </organizer>\n' +
'                  </subjectOf2>\n' +
'\n' +
'                </primaryRole>\n' +
'              </subject1>\n' +
'\n' +
'              <!-- G.k.1: Characterisation of Drug Role (F2-11 — dinamico, ver codigoCaracterizacao) -->\n' +
'              <component typeCode="COMP">\n' +
'                <causalityAssessment classCode="OBS" moodCode="EVN">\n' +
'                  <code code="20" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
'                  <value xsi:type="CE" code="' + codigoCaracterizacao + '" codeSystem="' + SCHEMA.E2B.CODESYS.CARACTERIZACAO_DROGA + '"/>\n' +
'                  <subject2 typeCode="SUBJ">\n' +
'                    <productUseReference classCode="SBADM" moodCode="EVN">\n' +
'                      <id root="' + caso.idMedicamentoE2B + '"/>\n' +
'                    </productUseReference>\n' +
'                  </subject2>\n' +
'                </causalityAssessment>\n' +
'              </component>\n' +
'\n' +
'              <!-- Avaliacao de causalidade — Algoritmo de Naranjo -->\n' +
'              <!-- FASE 1 (roadmap, Rodada A / hipoteses H2+H3): methodCode\n' +
'                   literal "Naranjo" e author codificado via CL21 em vez de\n' +
'                   texto livre. PENDENTE DE CONFIRMACAO no AckLog do\n' +
'                   VigiFlow — se a matriz de causalidade continuar vazia\n' +
'                   apos este XML, a hipotese muda para H1 (referencia\n' +
'                   orfa por falta de codigo MedDRA em E.i.2.1b). -->\n' +
'              <component typeCode="COMP">\n' +
'                <causalityAssessment classCode="OBS" moodCode="EVN">\n' +
'                  <code code="39" codeSystem="' + SCHEMA.E2B.CODESYS.OBSERVACOES + '"/>\n' +
'                  <value xsi:type="ST">' + naranjoClasse + '</value>\n' +
'                  <methodCode>\n' +
'                    <originalText>Naranjo</originalText>\n' +
'                  </methodCode>\n' +
'                  <author typeCode="AUT">\n' +
'                    <assignedEntity classCode="ASSIGNED">\n' +
'                      <code code="1" codeSystem="' + SCHEMA.E2B.CODESYS.AUTOR_COMENTARIO + '" displayName="sender"/>\n' +
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
blocoResumoNativo +
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
