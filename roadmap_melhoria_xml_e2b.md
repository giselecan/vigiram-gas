# Roadmap de Melhoria do XML E2B(R3) — VigiRAM → VigiMed

**Contexto:** Hospital Regional Norte (CNES 6848710) · Módulo VigiMed Serviços de Saúde
**Fontes normativas cruzadas:**

- Manual F-ANVISA-034 v.00 (12/05/2026) — Notificação no VigiMed para serviços de saúde
- Anvisa — *Instruções para a criação de arquivos XML ICH E2B* v2.0 (03/2025)
- ICH ICSR Implementation Guide v5.03 + `IG_Complete_Package_v1_11_1`
- ICH ICSR BFC Element Mapping v2.02 (cardinalidades)
- Exemplo oficial ICH `1-1_ExampleCase_literature_initial_v1_0.xml` (XPaths confirmados)

**Última atualização:** 09/07/2026

---

## Sumário executivo

De **9 abas** do formulário do VigiMed, **4 chegam vazias ou incompletas** pela importação do XML:

| Aba | Situação | Causa raiz |
|---|---|---|
| História médica e medicamentosa | vazia | elemento não emitido |
| Testes e procedimentos | vazia | elemento não emitido |
| Medicamento | ~50% | campos inexistentes no schema do VigiRAM |
| Avaliação (causalidade) | vazia | *investigar* — hipóteses na Fase 1 |
| Reação | inválida | ⛔ sem código MedDRA (`E.i.2.1b` = `nullFlavor="NI"`) |

> **Verdade desconfortável:** enquanto `E.i.2.1b` sair sem código MedDRA, o AckLog rejeita
> (`"A valid ICSR must contain at least one MedDRA coded reaction"`) e o caso **sempre** cai no
> fluxo de correção manual. As Fases 0–2 reduzem a digitação de ~15 min para ~30 s por caso,
> mas **não eliminam** a abertura manual do caso. A licença MedDRA é o gargalo binário.

---

## 🔴 Fase −1 — Correção de bug (fazer antes de qualquer coisa)

Não é melhoria; é conserto.

### B-01 · `G.k.4.r.7` (Lote) nunca é emitido ✅ CORRIGIDO (09/07/2026)

- **Onde:** `E2b.gs`, `_montarXmlE2B_` e `_validarCasoParaE2B_`
- **Sintoma:** o aviso *"Lote/laboratório não preenchido"* dispara em 100% dos casos, mesmo com o lote preenchido.
- **Causa:** o código lê `caso.loteLaboratorio`, mas `registrarInvestigacao` grava `lote` e `laboratorio` (colunas 15 e 16, separadas na reordenação de 07/2026). O campo `loteLaboratorio` não existe mais.

```diff
- const lote = escaparHtml_(String(caso.loteLaboratorio || '').toUpperCase());
+ const lote = escaparHtml_(String(caso.lote || '').toUpperCase());

- if (!caso.loteLaboratorio) avisos.push('Lote/laboratório não preenchido — G.k.4.r.7 sairá em branco.');
+ if (!caso.lote) avisos.push('Lote não preenchido — G.k.4.r.7 sairá em branco.');
```

**Esforço:** 5 min · **Campos novos na UI:** nenhum · **Risco:** nulo

---

## 🟢 Fase 0 — Ganhos sem tocar na interface

Todos os dados **já existem** no VigiRAM ou são constantes/derivados. Só código.
Todos os XPaths **confirmados** contra o exemplo oficial ICH.

| ID | Elemento E2B | Fonte do dado | XPath / padrão | Card. | Exige MedDRA? | Status |
|---|---|---|---|---|---|---|
| F0-01 | `G.k.9.i.4` Reexposição | `caso.readministrado` | `outboundRelationship2 > observation code="31"` + `value CE` (CL16) | 0..1 | não | ✅ implementado 09/07/2026 — o dropdown `readministrado` já tem 4 opções ("Não" / "Sim" / "Sim. Sintomas reapareceram" / "Sim. Sintomas não reapareceram") que mapeiam 1:1 pros 4 códigos da CL16 via `SCHEMA.E2B.REEXPOSICAO_MAP`; resolve de brinde a lacuna do F2-02 |
| F0-02 | `D.7.1.r.5` Comentários de história médica | `caso.historiaClinica` | free text 2000AN | 0..1 | **não** | pendente — sem o XPath/snippet exato do exemplo oficial ICH neste repo, não implementado (regra do projeto: XPath não confirmado não entra no XML) |
| F0-03 | `F.r.2.1` + `F.r.3.4` Exames (nome + resultado livre) | `caso.exames` | padrão do "teste #2" do exemplo oficial | 0..1 | **não** | pendente — mesmo motivo do F0-02 |
| F0-04 | `E.i.3.1` Termo destacado | derivado de `caso.gravidade` | `code="37"` + CL10 → grave=`3`, não grave=`2` | 0..1 | não | ✅ implementado 09/07/2026 — `SCHEMA.E2B.TERMO_DESTACADO_MAP` (FATAL/GRAVE=3, MODERADA/LEVE=2) |
| F0-05 | `E.i.9` País da reação | constante `BR` | `location > locatedEntity > locatedPlace` | 0..1 | não | ✅ já estava implementado no código (bloco dentro da `observation` da reação) |
| F0-06 | `D.2.2a/b` Idade no início da reação | `nascimento` + `dataInicioReacao` | `code="3"` + `PQ unit="a"` | 0..1 | não | pendente — wrapper HL7 exato não confirmado neste repo |
| F0-07 | `C.2.r.2.4 / C.2.r.2.5` Cidade/UF do notificador | constantes `Sobral` / `CE` | `addr/city`, `addr/state` | 0..1 | não | ✅ já estava implementado no código (bloco C.2.r) |
| F0-08 | `H.5.r.1a/b` Resumo em idioma nativo | mesma narrativa + `language="por"` | `code="36"` | 0..1 | não | pendente — wrapper HL7 exato não confirmado neste repo |
| F0-09 | `G.k.3.3` Detentor / fabricante | `caso.laboratorio` | `holder > role > playingOrganization > name` | 0..1 | não | pendente — roadmap só dá os nomes dos elementos, não os atributos RIM (`classCode`/`typeCode`); arriscado implementar sem o exemplo oficial |

> **Itens pendentes (F0-02, F0-03, F0-06, F0-08, F0-09):** para destravar, compartilhar o `1-1_ExampleCase_literature_initial_v1_0.xml` (ou o `IG_Complete_Package_v1_11_1`) citado nas fontes normativas — com o XPath exato, a implementação é rápida e seguindo o mesmo padrão dos itens já feitos.

### Destaque

**F0-02 e F0-03 são os maiores ganhos da fase.** O exemplo oficial do ICH prova que
história médica e exames podem ser transmitidos **estruturados, em texto livre, sem
nenhuma licença MedDRA**. Isso esvazia duas abas inteiras de digitação manual **hoje**,
com custo zero de licenciamento.

**Esforço estimado:** 1–2 dias · **Campos novos na UI:** nenhum

---

## 🧪 Fase 1 — Investigação da causalidade (Naranjo não está importando)

> **Fato confirmado pelo usuário:** as linhas de causalidade que aparecem no PDF do
> VigiFlow foram **todas preenchidas manualmente**. O bloco `G.k.9.i.2.r` do XML
> **não está sendo importado**.

### Hipóteses, da mais provável à menos

**H1 — Referência órfã à reação.**
O `causalityAssessment` (`code="39"`) aponta para a reação via:

```xml
<subject1>
  <adverseEffectReference classCode="OBS" moodCode="EVN">
    <id root="{idReacaoE2B}"/>
  </adverseEffectReference>
</subject1>
```

Se o VigiFlow descarta a reação por falta de `E.i.2.1b`, a referência fica órfã e o bloco
de causalidade cai junto. Isso explicaria por que a tela manual exibe *"Termo MedDRA a ser
inserido"* **dentro** da matriz de causalidade.

**H2 — `methodCode` fora da lista fechada do VigiMed.**
O ICH **não define vocabulário controlado** para `G.k.9.i.2.r.2` (verificado: nenhuma das 27
code lists trata de causalidade). O VigiMed provavelmente faz *string match* contra sua
própria lista de 4 métodos.

| Elemento | Enviado hoje | Provável esperado |
|---|---|---|
| `G.k.9.i.2.r.2` (método) | `NARANJO ALGORITHM (score: 8)` | `Naranjo` |
| `G.k.9.i.2.r.3` (resultado) | `PROVÁVEL` | `Provável` |
| `G.k.9.i.2.r.1` (fonte) | `<originalText>SENDER</originalText>` | `<code code="1" codeSystem="…2.1.1.21"/>` |

**H3 — `author` como texto livre** em vez de código da CL21 (`ich-role-code`).

### Protocolo de teste (uma variável por vez, ambiente de teste)

| Rodada | Alteração | Se a causalidade aparecer |
|---|---|---|
| **A** | `methodCode` = `Naranjo` · `value ST` = `Provável` · `author` = `<code code="1" .../>` | Era **H2/H3** → conserto grátis, entra na Fase 0 |
| **B** | Se A falhar: colar **um** código LLT obtido na própria tela do VigiMed em `E.i.2.1b` | Era **H1** → MedDRA vira **pré-requisito da Fase 2**, não Fase 4 |

> ⚠️ **A rodada B é decisiva.** Se a causalidade só importa com reação codificada,
> então MedDRA não é "mais um campo" — é a dependência da qual pendem reação,
> causalidade, rechallenge e a matriz `G.k.9.i.1` inteira. **A ordem deste roadmap muda.**

O `score` do Naranjo, se `methodCode` precisar ser literal, migra para
`G.k.9.i.2.r.1` (fonte) ou para a narrativa `H.1` — nunca para o nome do método.

**Esforço:** 2 casos de teste + leitura de 2 AckLogs

---

## 🟡 Fase 2 — Campos novos na tela de investigação

Cada linha = **um campo novo** no schema (`Schema.gs`), no `registrarInvestigacao` e no
modal `js_investigacao.html`.

### 2A · Prioridade alta (fecha a aba "Medicamento")

| ID | Campo novo | UI | Alvo E2B | Justificativa normativa |
|---|---|---|---|---|
| F2-01 | **Ação adotada** | dropdown fechado | `G.k.8` | Manual §5.5.6 — *dechallenge* |
| F2-02 | **Resultado da reexposição** | dropdown 4 opções | `G.k.9.i.4` | Manual §5.5.6 — *rechallenge*. Hoje `readministrado` é sim/não e **não mapeia** nos 4 estados |
| F2-03 | **Indicação de uso** | texto (250AN) | `G.k.7.r.1` | Manual §5.5.6 |
| F2-04 | **Data fim da administração** | data | `G.k.4.r.5` | Manual §5.5.6, nota 4 — plausibilidade temporal |
| F2-05 | **Data fim da reação** | data | `E.i.5` (→ `E.i.6a/b` derivada) | Manual §5.5.5 |

#### Listas fechadas a implementar

**`G.k.8` — Ação adotada** (CL15, `codeSystem` `…2.1.1.15`)

| Código | Rótulo (VigiMed) |
|---|---|
| `1` | Retirada do medicamento |
| `2` | Redução da dose |
| `3` | Aumento da dose |
| `4` | Sem alteração da dose |
| `0` | Desconhecido |
| `9` | Não aplicável |

**`G.k.9.i.4` — Reexposição** (CL16, `codeSystem` `…2.1.1.16`)

| Código | Significado |
|---|---|
| `1` | Sim–Sim (reexposição feita, reação recorreu) |
| `2` | Sim–Não (reexposição feita, reação não recorreu) |
| `3` | Sim–Desconhecido (reexposição feita, desfecho desconhecido) |
| `4` | Não–N/A (sem reexposição) |

### 2B · Prioridade média

| ID | Campo novo | UI | Alvo E2B | Justificativa |
|---|---|---|---|---|
| F2-06 | **Peso (kg)** e **Altura (cm)** | numérico | `D.3` / `D.4` | Manual §5.5.2 — "permite identificar se a dose foi adequada" |
| F2-07 | **Forma farmacêutica** | texto (60AN) | `G.k.4.r.9.1` | hoje o código traz `<!-- em branco, nao coletado -->` |
| F2-08 | **Nº de doses no intervalo** + **unidade** | numérico + dropdown | `G.k.4.r.2` / `G.k.4.r.3` | posologia sai truncada |
| F2-09 | **Exames estruturados** (nome, data, valor, unidade, ref. mín/máx) | subtabela repetível | `F.r.1 / F.r.2.1 / F.r.3.2 / F.r.3.3 / F.r.3.4` | Manual §5.5.7 — **unidade obrigatória** se houver valor numérico |

### 2C · Prioridade baixa / condicional

| ID | Campo novo | UI | Alvo E2B | Observação |
|---|---|---|---|---|
| F2-10 | **Data do óbito** | data condicional | `D.9.1` | só habilita se `desfecho = Fatal/Óbito` |
| F2-11 | **Relação medicamento × evento** | dropdown | `G.k.1` (CL13) | hoje **hardcoded `1` = Suspeito** |
| F2-12 | **Problemas adicionais do medicamento** | multi-select | `G.k.11` (texto livre) | off-label, erro de medicação, superdose — Manual §5.5.6 |
| F2-13 | **DUM / Gestante / Lactante** | data + checkbox | `D.6` | só se `sexo = Feminino` |

**Esforço estimado:** 1 sprint · **Campos novos na UI:** 9–13

---

## 🔵 Fase 3 — Refatoração estrutural

Não são "mais campos". São mudanças de cardinalidade que hoje **obrigam** o farmacêutico
a completar o caso na mão, independentemente de qualquer licença.

### F3-01 · Reações repetíveis (`E.i` é `1..N`)

> Manual §5.4: *"para cada reação adversa suspeita deve ser utilizada uma aba 'Reação'
> diferente"*. Náusea + vômito + hipotensão = 3 abas.

Hoje `idReacaoE2B` é escalar. → reações 2..N sempre digitadas manualmente.

**Impacto:** `Schema.gs` (subcoleção), `E2b.gs` (loop), matriz `G.k.9.i.1` (N×M).

### F3-02 · Medicamentos repetíveis (`G.k` é `1..N`)

Sem isso: nenhum concomitante, nenhuma **interação** — que exige, por definição, ≥2
medicamentos codificados (Manual §5.5.6). `G.k.1` deixa de ser constante.

### F3-03 · Follow-up e nullification

Manual §5.6: *"Não deve ser preenchida uma nova notificação no caso de seguimento"* — as
novas informações entram **na notificação de origem**.

| Elemento | Comportamento |
|---|---|
| `C.1.1` Safety Report ID | **muda** a cada envio |
| `C.1.8.1` WWUID | **permanece fixo** |
| `C.1.11.1/2` Nullification/Amendment | novo bloco |

Hoje o VigiRAM só gera notificação inicial → todo seguimento é 100% manual no VigiMed.

**Esforço estimado:** 2–3 sprints · **Risco:** alto (toca o modelo de dados)

---

## 🔒 Fase 4 — Licenças de dicionários

### F4-01 · MedDRA (MSSO/ICH) — **bloqueador binário**

| Alvo | Elemento |
|---|---|
| Reação | `E.i.2.1a` (versão) + `E.i.2.1b` (código LLT, 8N) |
| Indicação | `G.k.7.r.2a/2b` |
| História médica | `D.7.1.r.1a/1b` |
| Exames | `F.r.2.2a/2.2b` |

**Passos:**

1. Solicitar licença ao MSSO (existe categoria específica para prestadores de cuidado
   direto ao paciente — hospital se enquadra).
2. Importar `MedAscii`/XML para base pesquisável (LLT→PT→HLT→HLGT→SOC).
3. Adicionar `REACAO_MEDDRA_CODE` + `REACAO_MEDDRA_VERSION` ao `Schema.gs`.
4. Construir autocomplete na aba de investigação (equivale à "Opção A" do Manual §5.5.5).
5. `codeSystemVersion` deve refletir a versão MedDRA vigente **na data do caso**.

> Manter **sempre** `E.i.1.1a` (texto livre do notificador) **e** `E.i.2.1b` (código) lado a
> lado. O IG permite e recomenda os dois juntos.

### F4-02 · WHODrug Global (UMC) — formato **C3**

Conforme *Instruções Anvisa* §6.3, obrigatório quando a RDC 967/2025 entrar em vigor.

| Alvo | Elemento | OID |
|---|---|---|
| Medicamento suspeito/concomitante | `G.k.2.1.1a` (versão) / `G.k.2.1.1b` (MPID) | `2.16.840.1.113883.6.294` |
| História medicamentosa | `D.8.r.2a` / `D.8.r.2b` | idem |

- Versão no formato `MmmDDYYYY` (ex.: `Sep012023`).
- Atualização semestral: 1º de março e 1º de setembro.
- Se o nome comercial não existir no dicionário: codificar **apenas o princípio ativo** e
  colocar o nome comercial em `G.k.2.2` (texto livre) ou na narrativa. Solicitar inclusão
  via *WHODrug Change Request*, anexando o link da bula no Bulário da Anvisa.

**Esforço:** licenciamento (meses) + 1–2 sprints de implementação

---

## Conformidades permanentes (checklist de regressão)

Verificar a cada release do gerador:

- [ ] `encoding="UTF-8"` (Instruções Anvisa §3.1)
- [ ] Cabeçalho R3 exato: `MCCI_IN200100UV01` com `ITSVersion="XML_1.0"` (§5.1)
- [ ] **Ponto decimal**, nunca vírgula, em peso, altura, dose, duração (§6.2)
      — o normalizador `,` → `.` já existe; **não** usar separador de milhar
- [ ] `E.i.1.1b` = `por` (ISO 639-2, 3 letras) — nunca `pt`
- [ ] `H.5.r.1b` = `por`
- [ ] Cidade e UF do notificador inicial preenchidas (§6.1 — `C.2.r.2.4/2.5`)
- [ ] `messagereceiveridentifier` / `N.1.4` / `N.2.r.3` = `ANVISA`
- [ ] WWUID (`C.1.8.1`) estável entre envios do mesmo caso
- [ ] Todo texto livre passa por `escaparHtml_` antes de entrar no XML
- [ ] Nenhum XPath entra no gerador sem confirmação no `IG_Complete_Package`

---

## Sequência recomendada

```
Fase −1  (5 min)      → corrigir bug do lote
Fase 1   (2 testes)   → descobrir por que o Naranjo não importa
   ├─ resultado H2/H3 → conserto entra na Fase 0
   └─ resultado H1    → MedDRA sobe para antes da Fase 2
Fase 0   (1–2 dias)   → 9 elementos, zero campo novo
Fase 2   (1 sprint)   → 9–13 campos novos
Fase 3   (2–3 sprints)→ E.i e G.k repetíveis + follow-up
Fase 4   (meses)      → MedDRA, depois WHODrug C3
```

## Comunicação interna

Não descrever as Fases 0–3 como *"importação 100% automática"*. Até a licença MedDRA
estar ativa, o farmacêutico **abre o caso de qualquer forma** — a diferença é gastar
30 segundos codificando um termo em vez de 15 minutos redigitando o caso inteiro.
Esse já é um ganho grande. Prometer mais do que isso gera desconfiança quando o
primeiro AckLog voltar rejeitado.

---

## Pendência a levar à Anvisa (Fale Conosco → GFARM/GGMON)

O documento *Instruções para criação de arquivos XML* descreve um ambiente de testes
(`industryereportingtraining.who-umc.org`) **exclusivo do módulo Empresas**. O Manual
F-ANVISA-034 (serviços de saúde) não menciona equivalente — mas a tela inicial do
VigiFlow exibe o botão **"Importar"** (Figura 8). Perguntar:

1. Existe ambiente de teste para XML no módulo **serviços de saúde**?
2. As regras do documento de Empresas (cabeçalho R3, decimais, WHODrug C3) se aplicam
   integralmente ao botão "Importar" do módulo serviços de saúde?

Sem isso, divergências específicas do módulo só aparecem em produção — como já ocorreu
com a rejeição por falta de MedDRA.
