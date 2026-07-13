# Auditoria QA — Datas, Tipagem e Design de Funções (VigiRAM)

> **Status:** diagnóstico apenas — nenhuma correção foi aplicada ainda.
> Guardado para implementação em um momento futuro. Ver checklist de
> prioridade no final do documento.
>
> **Escopo analisado:** todo o backend (`.gs`, ~20 arquivos) e frontend
> (`.html`, ~11 arquivos) do VigiRAM (Google Apps Script + Firestore +
> Google Sheets), auditado em 2026-07-13.

---

## Ferramenta operacional — reset da base antes do go-live

Adicionada em `Manuntenção.gs` (não é um item da auditoria, é um utilitário
administrativo pontual): `zerarBaseCasosParaProducao_dryRun_()` +
`zerarBaseCasosParaProducao_(confirmar)` apagam todos os casos de teste
(`casos_ram` no Firestore + linhas de `DB_Casos_RAM` no Sheets), preservando
usuários, setores, listas, Naranjo, gatilhos, configuração geral e o log de
auditoria. Protegida por três travas (Script Property dedicada +
confirmação por string exata + sufixo `_`, nunca exposta ao frontend). Ver
o bloco de comentários no próprio arquivo para o passo a passo de execução.

---

## A. Diagnóstico de Tipos e Datas

### 🔴 Crítico — risco de perda de dados / corrupção regulatória

| # | Local | Problema | Cenário de falha |
|---|-------|----------|-------------------|
| 1 | `Manuntenção.gs:43-47` `_casosForaDeHoje_` | Compara `data` com prefixo `dd/MM/yyyy`, mas `salvarDemandaEspontanea` (Cases.gs:319) grava `data` como `"yyyy-MM-dd HH:mm"` na maioria dos casos. `"2026-07-13 14:30".startsWith("13/07/2026")` é sempre `false`. | Todo caso de **Demanda Espontânea criado hoje** é classificado como "fora de hoje" e vira elegível para exclusão permanente por `limparCasosAntigos_(true)` — a própria função de limpeza de base regulatória. |
| 2 | `E2b.gs:391-398` `_montarComponenteExameE2B_` | `exame-valor`/`refMin`/`refMax` são `<input type="text">` (`js_investigacao.html:549-552`). O código faz só `.replace(',', '.')` e `Number(...)`. | Um farmacêutico digita `"150.000"` (plaquetas, notação BR de milhar) → `Number("150.000")` = **150**, não 150000. Valor **1000× menor** vai direto no XML E2B(R3) enviado ao VigiMed/ANVISA. Se o valor tiver `"1.234,56"`, o replace ingênuo gera `"1.234.56"` (dois pontos) → `NaN` → o campo é **descartado silenciosamente**, sem aviso. |
| 3 | `E2b.gs:654` | `numeroDosesIntervaloE2B = String(...).replace(/[^0-9.]/g, '')` — remove a vírgula em vez de convertê-la. | `"2,5"` vira `"25"` (10× maior) no XML de posologia. Hoje inatingível pela UI (`input type="number"`), mas nada no Firestore impede que outro caminho (edição direta, ETL futuro) grave esse formato — é uma bomba-relógio, não um bug morto. |

### 🟠 Alto — inconsistência de tipo ativa hoje

| # | Local | Problema |
|---|-------|----------|
| 4 | `Cases.gs:294-320` `salvarDemandaEspontanea` | O mesmo campo `data` sai da **mesma função** em **dois formatos diferentes**: `dd/MM/yyyy HH:mm:ss` (fallback) ou `yyyy-MM-dd HH:mm` (normalizado do form). Nunca é gravado como `Date`/Timestamp — ao contrário de `auditoria.atualizadoEm` e `notificador.dataNotificacao`, que **são** `Date` reais na mesma escrita. Um documento `casos_ram` mistura 3 contratos de tipo para "data" no mesmo objeto. |
| 5 | `Ingest.gs:83` `data: caso.data_evento` | Grava o que o robô PowerShell mandar, sem normalizar — string bruta, formato não controlado pelo Apps Script. Terceiro formato concorrente para o mesmo campo lógico. |
| 6 | `Audit.gs:41,55` vs `Mirror.gs:284-286` | `DB_Log` no Sheets recebe `new Date()` real (ações de Admin, ainda ativas via `Admin.gs:100,133,162`) **e** string pré-formatada (todo o resto, via Mirror.gs) **na mesma coluna**. Ordenar/filtrar essa coluna no Sheets dá resultado incoerente linha a linha. |
| 7 | `ativo` (flag booleano) | Três representações para o mesmo conceito: `'SIM'/'NÃO'` string em Usuários/Setores/`config_geral.ALERTAS_ATIVOS`, mas **boolean** `true/false` em Gatilhos (`Config write.gs:240,282`). Código genérico escrito para uma convenção lê a outra errado silenciosamente. |
| 8 | `pesoKg`, `alturaCm`, `numeroDosesIntervalo` (`Cases.gs:510-513`) | Persistidos como **String** no Firestore (não `Number`) — o Firestore não força tipo, então nada impede um caminho futuro (migração, edição direta) de gravar tipo diferente do que os outros 100% dos writes atuais produzem. O "cinto de segurança" que existe para dose (`_normalizarDoseE2B_`, trata milhar BR vs. decimal) **não existe** para peso/altura — só funciona hoje porque o `<input type="number">` do navegador garante ponto. |

### 🟡 Médio

| # | Local | Problema |
|---|-------|----------|
| 9 | `js_kanban.html:96,115`, `js_dashboard.html:61` | Filtro/ordenação de data só reconhece regex `dd/MM/yyyy`. Para `data_evento` em formato ISO (produzido por casos DE — achado #4), o filtro simplesmente **não faz nada** (nem inclui nem exclui) em vez de aplicar a data corretamente. |
| 10 | `js_dashboard.html:87` `_parseDataEventoBR` | Fallback `new Date(str)` para string `"yyyy-MM-dd HH:mm"` (espaço) é `NaN` no Safari/iOS — bug já documentado e corrigido em `js_core.html:649`, mas o fix nunca foi replicado aqui. Métrica de SLA do dashboard some silenciosamente nesses casos em iPhone/iPad. |
| 11 | `Mirror.gs` `_construirLinhaCaso_`/`_gravarLogNoSheets` | Toda data é convertida para string **antes** do `appendRow`/`setValues` — nenhuma coluna de data em `DB_Casos_RAM`/`DB_Log` é "Data" nativa do Sheets. Pode ser intencional (arquitetura "append-only" documentada), mas quebra ordenação/filtro/fórmula de data nativos do Sheets — vale confirmar com o cliente se é aceitável. |
| 12 | `MigracaoFirestore.gs:131` | `Number(dados[i][2]) \|\| 999` — bug clássico de zero falsy: se um admin usou ordenação 0-based na planilha, `ordem = 0` vira `999` (a opção pula para o fim da lista). Só afeta a migração pontual, mas reproduz toda vez que rodar de novo. |
| 13 | `E2b.gs:292` `tz = dateOnlyUTC ? 'GMT' : Session.getScriptTimeZone()` | Único ponto do código que não usa `Session.getScriptTimeZone()` puro. É **intencional e correto** (evita off-by-one-day em Timestamp "só data" gravado à meia-noite UTC) — documentado, mas listado aqui porque é a exceção que confirma a regra e merece reteste se a representação de datas "só-dia" mudar no futuro. |

**Causa raiz comum de 1, 4, 5, 8, 9, 10:** o projeto nunca decidiu um único
contrato "campo de data = sempre `Date`/Timestamp real" e aplicou em todos
os pontos de escrita. `Firestore.gs` já tem a conversão correta pronta
(`fsParaValorFs_`/`fsDeValorFs_`, `Date` ⇄ `timestampValue`) — o problema é
que várias funções de escrita optam por pré-formatar a data como string em
vez de deixar essa camada fazer o trabalho dela.

---

## B. Refatoração de Design de Funções (Antes e Depois)

### Função Inadequada: `salvarDemandaEspontanea` (Cases.gs:269-377)

**Por que o design é ruim:**
- Faz **9 responsabilidades diferentes** numa função só: valida
  idempotência, valida obrigatoriedade, formata data (2 formatos
  concorrentes — achado #4), resolve farmacêutico via config, grava no
  Firestore, espelha no Sheets, grava log de auditoria, invalida cache,
  dispara e-mail — e devolve o resultado.
- **Contrato de retorno imprevisível**: sucesso devolve
  `{ farmaceuticoResponsavel }` (sem campo `sucesso`), falha faz `throw`.
  Isso é diferente de praticamente toda função irmã em `Admin.gs`/
  `Config write.gs`, que devolve `{ sucesso: false, mensagem }` em vez de
  lançar. O frontend não tem como saber, sem ler o código-fonte, se uma
  chamada de escrita vai rejeitar via `withFailureHandler` ou via
  `withSuccessHandler({sucesso:false})`.
- Um teste de "esqueceu o prontuário" precisa simular Firestore, Sheets,
  e-mail e cache — porque tudo está soldado junto.

**Proposta de refatoração** — separar em passos puros/previsíveis + um
orquestrador fino, e padronizar o contrato de retorno
`{ sucesso, dados, mensagem }` em todo o projeto:

```javascript
// ── Utils.gs — contrato de retorno único do projeto ──────────────────
function respostaOk_(dados) {
  return { sucesso: true, dados: dados || null };
}
function respostaErro_(mensagem) {
  return { sucesso: false, mensagem: String(mensagem) };
}

// ── Cases.gs — passos puros, cada um com uma única responsabilidade ──

/** Valida os campos obrigatórios. Lança apenas erro de VALIDAÇÃO (nunca de I/O). */
function _validarDemandaEspontanea_(formDados) {
  const prontuario  = String(formDados && formDados.prontuario  || '').trim();
  const iniciais    = String(formDados && formDados.iniciais    || '').trim();
  const setor       = String(formDados && formDados.setor       || '').trim();
  const medicamento = String(formDados && formDados.medicamento || '').trim();

  if (!prontuario || !iniciais || !setor || !medicamento) {
    throw new Error('Preencha os campos obrigatórios: prontuário, iniciais, setor e medicamento.');
  }
  return { prontuario, iniciais, setor, medicamento };
}

/**
 * Resolve a data do evento como Date REAL — nunca string. Corrige a causa
 * raiz do bug em Manuntenção.gs (campo `data` em 2+ formatos concorrentes):
 * a partir de agora `data` é SEMPRE Timestamp no Firestore, como
 * auditoria.atualizadoEm já é.
 */
function _resolverDataEvento_(formDados, agora) {
  if (!formDados.dataEvento) return agora;
  // <input type="datetime-local"> → "yyyy-MM-ddTHH:mm", interpretado no
  // fuso do script (mesma premissa já usada em toda a UI — ver js_core.html).
  const [dataParte, horaParte] = String(formDados.dataEvento).split('T');
  const [ano, mes, dia] = dataParte.split('-').map(Number);
  const [h, m] = (horaParte || '00:00').split(':').map(Number);
  const d = new Date(ano, mes - 1, dia, h || 0, m || 0);
  return isNaN(d.getTime()) ? agora : d;
}

/** Resolve o farmacêutico responsável pelo setor. Nunca lança — degrada para ''. */
function _resolverFarmaceuticoDoSetor_(setor) {
  try {
    const cfg = getConfig_();
    const setorUp = setor.toUpperCase().trim();
    const setorObj = (cfg.setores || []).find(function (s) {
      return s.setor && s.setor.toUpperCase().trim() === setorUp;
    });
    return (setorObj && setorObj.farmaceutico) || '';
  } catch (e) {
    console.warn('Não foi possível resolver o farmacêutico do setor: ' + e.message);
    return '';
  }
}

/** Monta o objeto de domínio — só construção de dado, zero I/O. */
function _montarObjetoDemandaEspontanea_(idCaso, campos, dataEvento, farmaceutico, formDados, agora) {
  return {
    id: idCaso,
    data: dataEvento,                 // ← Date real (era string em 2 formatos)
    tipo: 'DE',
    prontuario: campos.prontuario,
    iniciais: campos.iniciais.toUpperCase(),
    nascimento: formDados.nascimento || '',
    setor: campos.setor.toUpperCase(),
    medicamento: campos.medicamento.toUpperCase(),
    status: SCHEMA.STATUS.INVESTIGACAO,
    sla: 'AGUARDANDO SLA',
    farmaceutico: farmaceutico,
    motivoDescarte: '', historiaClinica: '', relato: '', exames: '',
    readministrado: '', evolucao: '', desfecho: '', conclusao: '',
    naranjo: '', gravidade: '', numVigimed: '', dataVigimed: '',
    observacoes: '', naranjoRespostas: '', lote: '', laboratorio: '',
    relatoNotificador: formDados.descricao || '',
    condutaNotificador: formDados.condutas || '',
    notificador: {
      nome: String(formDados.notificador || 'N/I').trim(),
      categoria: String(formDados.categoriaProfissional || 'N/I').trim(),
      email: String(formDados.emailNotificador || '').trim(),
      dataNotificacao: agora
    },
    auditoria: { atualizadoPor: 'Formulário Assistência', atualizadoEm: agora }
  };
}

/** Persiste o caso (Firestore + espelho + log + cache) — só I/O, sem regra de negócio. */
function _persistirNovoCaso_(idCaso, objetoCaso, tipoLog, detalheLog) {
  fsSetDoc_(SCHEMA.FS.CASOS, idCaso, objetoCaso);
  espelharCasoNoSheets_(idCaso, objetoCaso, 'CRIACAO');
  fsRegistrarLog_(tipoLog, idCaso, detalheLog);
  invalidarCasosCache_();
}

// ── Orquestrador fino: só decide A ORDEM dos passos, não faz nenhum deles ──
function salvarDemandaEspontanea(formDados) {
  try {
    const chaveIdemp = String(formDados && formDados.idempotencyKey || '').trim();
    const cacheIdemp = CacheService.getScriptCache();
    if (chaveIdemp) {
      const jaProcessado = cacheIdemp.get(_DE_IDEMP_PREFIXO + chaveIdemp);
      if (jaProcessado) {
        try { return respostaOk_(JSON.parse(jaProcessado)); } catch (e) { /* segue e regrava */ }
      }
    }

    const campos = _validarDemandaEspontanea_(formDados);
    const agora  = new Date();
    const idCaso = `ESP-${campos.prontuario}-${agora.getTime().toString().slice(-6)}`;
    const dataEvento    = _resolverDataEvento_(formDados, agora);
    const farmaceutico  = _resolverFarmaceuticoDoSetor_(campos.setor);
    const objetoCaso    = _montarObjetoDemandaEspontanea_(idCaso, campos, dataEvento, farmaceutico, formDados, agora);

    _persistirNovoCaso_(idCaso, objetoCaso, 'NOTIFICACAO_ESPONTANEA', `${campos.setor} / ${campos.medicamento}`);
    notificarNovaDemandaEspontanea_(objetoCaso); // best-effort, já tem try/catch próprio

    const dados = { farmaceuticoResponsavel: farmaceutico };
    if (chaveIdemp) {
      try { cacheIdemp.put(_DE_IDEMP_PREFIXO + chaveIdemp, JSON.stringify(dados), _DE_IDEMP_TTL_SEG); }
      catch (e) { /* cache indisponível — degrada sem quebrar o envio */ }
    }
    return respostaOk_(dados);

  } catch (erro) {
    return respostaErro_(`Erro ao salvar demanda espontânea: ${erro.message}`);
  }
}
```

```javascript
// ── form.html — único ajuste necessário no consumidor ────────────────
google.script.run
  .withSuccessHandler(res => {
    if (!res.sucesso) {                    // antes: só existia o "caminho feliz"
      btn.innerHTML = '<i class="fas fa-paper-plane"></i> Enviar notificação';
      btn.disabled  = false;
      document.getElementById('lblBannerErro').textContent = 'Falha ao enviar: ' + res.mensagem;
      document.getElementById('bannerErro').classList.remove('hidden');
      return;
    }
    _salvarMemoria();
    _limparRascunho();
    idempotencyKeyAtual = null;
    _exibirSucesso(dados, res.dados);       // era `resultado`, agora `res.dados`
  })
  .withFailureHandler(err => { /* só erro de INFRAESTRUTURA cai aqui agora, não mais regra de negócio */ })
  .salvarDemandaEspontanea(dados);
```

Cada passo (`_validarDemandaEspontanea_`, `_resolverDataEvento_`,
`_resolverFarmaceuticoDoSetor_`, `_montarObjetoDemandaEspontanea_`,
`_persistirNovoCaso_`) agora é testável isoladamente, e o mesmo padrão de
contrato (`respostaOk_`/`respostaErro_`) elimina a ambiguidade "throw vs.
`{sucesso:false}`" encontrada em **três famílias de retorno incompatíveis**
hoje coexistindo no projeto:

- **Família A** (`{sucesso, mensagem}`, nunca lança) — `Admin.gs`,
  `Config write.gs`.
- **Família B** (dado cru + `throw` em qualquer erro) — `Cases.gs` (exceto
  a função acima), `getConfig`, `listarUsuarios`.
- **Família C** (`validarSessao` devolve **boolean puro**;
  `encerrarSessao` sempre devolve `true`) — casos únicos, sem padrão
  nenhum.

Isso força o frontend a se defender de dois jeitos ao mesmo tempo —
evidência concreta em `js_admin.html:550-553`, que faz *string-matching*
em mensagens de erro em português para decidir se a sessão expirou, porque
não existe um campo estruturado (`codigo`/`erro`) para checar:
```js
const ehSessaoExpirada =
  msg.includes('Sessão expirada') || msg.includes('não autorizada') || msg.includes('consolidar base Kanban');
```
Adotar `respostaOk_`/`respostaErro_` em toda função exposta a
`google.script.run` (mantendo `doGet`/`doPost` com seu próprio envelope
HTTP `{status, mensagem}`, que é um contrato diferente por natureza)
elimina essa classe inteira de gambiarra no frontend.

### Outras "Funções Deus" identificadas (mesma decomposição se aplica)

| Função | Linhas | O que faz junto | Decomposição sugerida |
|---|---|---|---|
| `registrarInvestigacao` (Cases.gs:450-562) | 113 | Guarda de estado + transação com normalização inline de ~40 campos + auditoria + log condicional + re-leitura + mirror + e-mail | `_validarTransicaoStatus_`, `_normalizarCamposInvestigacao_`, `_persistirInvestigacao_`, orquestrador |
| `handleInsertDB` (Ingest.gs:61-144) | 84 | Parse HTTP + dedupe + build + batch Firestore + batch Sheets + log + cache + resposta HTTP | separar `_deduplicarLoteETL_`, `_persistirLoteETL_`, deixar `handleInsertDB` só parsear e delegar |
| `autenticarUsuario` (Auth.gs:32-99) | 68 | Normalização + leitura + verificação de senha + upgrade de hash + sessão + 4 pontos de log + classificação de erro | extrair `_classificarErroInfra_`, manter o resto — menor prioridade, já é razoavelmente linear |
| `listarGatilhos` (Config write.gs:183-227) | 45 | Uma função de **leitura** que faz **escrita** (auto-cura) como efeito colateral | separar em `listarGatilhos` (só leitura) + `_curarGatilhosSemNome_` (job separado, ou pelo menos nomear a função `listarGatilhosComAutoCura_` para não surpreender quem só quer ler) |
| `_montarXmlE2B_` (E2b.gs:523-1378) | ~856 | Um único builder monolítico do XML E2B(R3) inteiro | quebrar por bloco XML (paciente, medicamento, reação, remetente, narrativa) — maior esforço, menor risco imediato pois é só leitura/geração, sem escrita de estado |

---

## C. UX / Loading

O padrão geral do frontend é **bom**: quase todo botão de escrita segue
`disabled=true → chamada → reabilita em success E em failure`, com
spinner. Três exceções reais:

1. **[x] CORRIGIDO em 2026-07-13 — `js_admin.html` `_gatExcluir`** — era a
   única ação de escrita do painel admin sem estado de carregamento; o
   botão "Excluir" gatilho ficava clicável durante toda a chamada, e um
   clique duplo disparava duas exclusões/logs de auditoria concorrentes.
   Agora recebe o próprio elemento do botão (`this`), desabilita e mostra
   spinner durante a chamada, restaurando em falha (em sucesso a tabela
   inteira é re-renderizada, então o botão específico some).
2. **[x] CORRIGIDO em 2026-07-13 — `js_notificacao_interna.html`** —
   chamava `salvarDemandaEspontanea` **sem** `idempotencyKey`, diferente
   de `form.html`, que gera e reenvia a mesma chave em retry por timeout.
   Reabria exatamente a causa de duplicação de casos que a idempotência já
   havia corrigido em `Cases.gs`. Agora gera/reutiliza `_niIdempotencyKeyAtual`
   no mesmo padrão do `form.html`: mantém a chave em caso de falha (retry
   seguro) e zera ao abrir o modal para um caso novo.
3. **`js_investigacao.html:346-360`** — `_mostrarCarregandoInvestigacao`
   referencia `#invCarregandoDetalhe`/`#formInvestigacaoCampos`, elementos
   que **não existem** em `index.html` (o próprio comentário admite ser
   uma "sugestão" nunca implementada). Abrir uma investigação zera o
   formulário e mostra o modal vazio, sem spinner, até
   `getCasoDetalhado` retornar — para um caso com histórico clínico
   extenso, isso pode ser vários segundos de tela em branco sem feedback.
   **Ainda pendente** — exige inserir markup novo no modal em `index.html`
   (maior risco de efeito colateral visual que os dois itens acima, por
   isso deixado fora desta rodada).

---

## Checklist de Prioridade (para retomar depois)

- [x] **#4/#5/#9/#10 — CORRIGIDO em 2026-07-13.** Causa raiz do "filtro de
      período não funciona" no Kanban/Dashboard. Aplicado:
      - `Utils.gs` — novo `_parseDataFlexivel_(valor)`: interpreta Date,
        BR (`dd/MM/yyyy...`) ou ISO (`yyyy-MM-dd...`) e sempre devolve um
        `Date` real ou `null`.
      - `Cases.gs` (`salvarDemandaEspontanea`) e `Ingest.gs`
        (`handleInsertDB`) — `data` agora é **sempre** gravado como `Date`
        (Timestamp no Firestore), nunca mais como string pré-formatada.
      - `js_core.html` — novo `parseDataFlexivel(valor)` (equivalente
        client-side), substitui as 3 implementações divergentes que
        existiam (`calcularSLA` aqui, `_parseDataEventoBR` em
        `js_dashboard.html`, regex inline em `js_kanban.html`).
      - `js_kanban.html`/`js_dashboard.html` — filtro de período e
        ordenação por data do evento agora usam `parseDataFlexivel`,
        reconhecendo BR e ISO igualmente (antes só BR era reconhecido —
        casos ISO escapavam do filtro sem serem incluídos nem excluídos).
      - `MigracaoFirestore.gs` — novo `migrarDataCasosParaTimestamp_(dryRun)`
        + wrapper `_aplicarMigracaoDataCasos()`: backfill dos casos já
        existentes no Firestore com `data` ainda em string. **Precisa ser
        rodado manualmente uma vez no editor do Apps Script** (dry-run
        primeiro) para que casos antigos também passem a respeitar o
        filtro corretamente — casos novos já nascem corrigidos, mesmo sem
        rodar a migração.
      - Isso também resolve a causa raiz do achado **#1** (crítico, exclusão
        indevida de casos pelo `Manuntenção.gs`): uma vez migrados, os
        casos passam a ter `data` como `Date` real, formato que
        `_casosForaDeHoje_` já sabe interpretar corretamente.
- [x] **#2/#3/#8 (parcial) — CORRIGIDO em 2026-07-13.** Corrupção numérica
      no XML E2B(R3) regulatório. Aplicado:
      - `E2b.gs` — `_normalizarDoseE2B_` renomeada/generalizada para
        `_normalizarNumeroE2B_` (mesma lógica de disambiguação BR
        milhar-vs-decimal, agora documentada para uso genérico).
      - `_montarComponenteExameE2B_` — `exame.valor`/`refMin`/`refMax`
        passam por `_normalizarNumeroE2B_` antes do `Number()`. Antes,
        `"150.000"` (plaquetas, convenção BR de milhar) virava
        `Number("150.000")=150` — 1000× menor no laudo — e
        `"1.234,56"` virava `NaN` e era descartado em silêncio.
      - `numeroDosesIntervaloE2B` — trocado `.replace(/[^0-9.]/g,'')`
        (que apagava a vírgula: `"2,5"` → `"25"`, 10× maior) por
        `_normalizarNumeroE2B_`.
      - `pesoKgE2B`/`alturaCmE2B` — trocado `.replace(',', '.')` isolado
        (não tratava separador de milhar) por `_normalizarNumeroE2B_`,
        mesmo cinto de segurança que a dose já tinha (achado #8, só a
        camada de exportação E2B — ver nota abaixo sobre o Firestore).
- [x] **#6 — CORRIGIDO em 2026-07-13.** `Admin.gs` era o único arquivo que
      ainda chamava o `registrarLog_()` legado (Audit.gs — gravava `Date`
      real direto no Sheets, sem trava). Trocado pelas 3 chamadas
      (`criarUsuario`, `trocarSenhaUsuario`, `alterarStatusUsuario`) para
      `fsRegistrarLog_()` (Firestore.gs), o mesmo caminho usado pelo resto
      do sistema (grava no Firestore, espelha no Sheets como string
      formatada via Mirror.gs, sob `comTrava_`). `registrarLog_()` e
      `carimbarAuditoria_()` (Audit.gs) ficaram sem nenhum chamador —
      removidas por serem código morto (mantido só `usuarioAtual_()`).
- [x] **#8 — CORRIGIDO em 2026-07-13.** `pesoKg`/`alturaCm`/
      `numeroDosesIntervalo` agora persistem como `Number` no Firestore
      (`Cases.gs`, via novo helper `_paraNumeroOuVazio_` em `Utils.gs`).
      Não reintroduz o bug de "zero falsy": `_mapearCasoCompleto_` (leitura
      para o frontend) já convertia com `!= null` + `String()`, e
      `_normalizarNumeroE2B_` (E2b.gs) já trata `Number` via `String()`
      corretamente — os dois já tratavam `0` como valor válido antes desta
      mudança, então nenhum consumidor precisou ser alterado.
- [x] **#7 — CORRIGIDO em 2026-07-13 (caminho seguro, sem quebrar login).**
      `usuarios.ativo` e `setores.ativo` passam a ser gravados como
      `boolean` a partir de agora (`Admin.gs`, `Config write.gs`,
      migrações `migrarUsuariosParaFirestore`/`migrarSetoresParaFirestore`
      em `MigracaoFirestore.gs`). TODA leitura (`Auth.gs` — login,
      `Admin.gs` — `listarUsuarios`, `Config.gs` — `lerSetoresFirestore_`)
      passa a usar o novo helper `_ativoComoBooleano_` (`Utils.gs`), que
      aceita boolean OU a string legada `'SIM'/'NÃO'/'NAO'` — nenhum
      documento gravado antes desta correção deixa de funcionar, inclusive
      contas de usuário já cadastradas. O contrato `google.script.run` para
      o frontend (`js_admin.html`) foi mantido idêntico (`listarUsuarios`
      continua devolvendo `'SIM'/'NÃO'`) — zero mudança no frontend.
      Gatilhos (já boolean) não precisaram de nenhuma alteração.
      `config_geral.ALERTAS_ATIVOS` foi deixado de fora de propósito: é um
      valor dentro de um dicionário chave/valor genérico onde TODO valor é
      string por design (mesmo padrão de `SLA_PADRAO_HORAS`, `TITULO_SISTEMA`
      etc.) — não é o mesmo tipo de achado que um campo "ativo" por registro.
      **Migração de backfill disponível, não executada automaticamente:**
      `migrarAtivoParaBooleano_(dryRun)` em `MigracaoFirestore.gs` converte
      os documentos já existentes de `usuarios`/`setores` para boolean —
      idempotente, roda manualmente no editor quando quiser (dry-run
      primeiro). Enquanto não rodar, tudo continua funcionando pela
      tolerância de leitura acima.
- [ ] **Seção B** — padronizar contrato de retorno
      (`respostaOk_`/`respostaErro_`) em todas as funções expostas a
      `google.script.run`; começar por `salvarDemandaEspontanea` (exemplo
      completo acima), depois propagar para `Cases.gs` inteiro.
- [ ] **Seção B** — decompor `registrarInvestigacao`, `handleInsertDB`,
      `_montarXmlE2B_` (menor prioridade, é só leitura/geração).
- [ ] **Seção C** — adicionar `_iniciarCarregando`/`_pararCarregando` em
      `_gatExcluir`; adicionar `idempotencyKey` em
      `js_notificacao_interna.html`; implementar (ou remover) o spinner
      morto de `js_investigacao.html`.

---

*Gerado por auditoria de código em 2026-07-13. Nenhuma alteração de código
foi aplicada — este documento é só o diagnóstico e a proposta de
refatoração, para implementação posterior.*
