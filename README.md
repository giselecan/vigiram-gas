# VigiRAM

Sistema de farmacovigilância hospitalar para gestão do ciclo completo de
notificações de Reação Adversa a Medicamento (RAM) — da ingestão automática
de alertas, passando pela triagem e investigação farmacêutica, até a
exportação do XML ICH E2B(R3) para importação no **VigiMed** (Anvisa).

Desenvolvido para o **Hospital Regional Norte** (CNES 6848710), roda
inteiramente como um **Google Apps Script Web App**, sem servidor próprio.

> Repositório fonte-única para `clasp push`/`clasp pull`. O deploy real
> acontece no editor do Apps Script ou via integração GitHub ↔ Apps Script.

---

## Sumário

- [Visão geral](#visão-geral)
- [Arquitetura](#arquitetura)
- [Fluxo de um caso](#fluxo-de-um-caso)
- [Estrutura do repositório](#estrutura-do-repositório)
- [Stack tecnológica](#stack-tecnológica)
- [Configuração e deploy](#configuração-e-deploy)
- [Build do CSS (Tailwind)](#build-do-css-tailwind)
- [Segurança](#segurança)
- [Exportação E2B(R3) para o VigiMed](#exportação-e2br3-para-o-vigimed)
- [Scripts utilitários](#scripts-utilitários)
- [Roadmap](#roadmap)

---

## Visão geral

O VigiRAM automatiza a notificação de reações adversas a medicamentos que,
no fluxo manual, dependia de o farmacêutico revisar prontuários um a um.
Um robô ETL (PowerShell) varre o sistema hospitalar em busca de
medicamentos-gatilho, envia os alertas para o VigiRAM, e a equipe de
farmácia clínica faz a triagem e a investigação em um painel Kanban web.
Casos investigados podem ser exportados como XML ICH E2B(R3) para
importação no VigiMed, o módulo de notificação da Anvisa.

Principais funcionalidades:

- **Ingestão automática (ETL)** de medicamentos-gatilho vindos de um robô
  PowerShell, autenticada por HMAC-SHA256.
- **Painel Kanban** (`index.html` + `js_kanban.html`) para triagem e
  acompanhamento dos casos por status.
- **Formulário público** (`form.html`) para notificação espontânea pela
  assistência (equipe de enfermagem/médica).
- **Investigação farmacêutica** estruturada (`js_investigacao.html`):
  causalidade (algoritmo de Naranjo), conduta, desfecho, dados
  clínicos/laboratoriais.
- **Dashboard analítico** (`js_dashboard.html`) com indicadores do
  programa de farmacovigilância.
- **Exportação E2B(R3)** (`E2b.gs`) — gera XML ICH validado
  estruturalmente para importação no VigiMed.
- **Notificações por e-mail** (`Notify.gs`) para farmacêuticos por setor,
  em cada etapa relevante do fluxo.
- **Autenticação e perfis** (`Auth.gs`, `Admin.gs`) com sessão via
  `CacheService`, senha com hash salgado (SHA-256) e perfis
  farmacêutico/admin.
- **Auditoria completa** (`Audit.gs`, `Mirror.gs`) — todo caso é
  carimbado com autor/timestamp e espelhado de forma append-only no
  Google Sheets como trilha de auditoria LGPD.

## Arquitetura

```
                         ┌─────────────────────┐
   Robô ETL (PowerShell) │  varre prontuários   │
   assinado por HMAC     │  por medicamento-    │
            │            │  gatilho             │
            │            └─────────────────────┘
            ▼
   doPost/doGet (Router.gs) ── Security.gs (HMAC, allowlist de pastas)
            │
            ▼
   ┌──────────────────────────── Google Apps Script (V8) ─────────────────────────────┐
   │  Ingest.gs → Cases.gs → Config.gs → Auth.gs → Admin.gs → Notify.gs → E2b.gs        │
   │                              │                                                     │
   │                              ▼                                                     │
   │                     Firestore.gs (REST API, Service Account/JWT)                   │
   │                     ── fonte única de verdade (casos, config, usuários, gatilhos)  │
   │                              │                                                     │
   │                              ▼                                                     │
   │                     Mirror.gs → Google Sheets (append-only, auditoria LGPD)        │
   └────────────────────────────────────────────────────────────────────────────────────┘
            │
            ▼
   Painel Kanban / Formulário (HTML Service: index.html, form.html, js_*.html + Tailwind)
            │
            ▼
   E2B(R3) XML  →  importação manual no VigiFlow/VigiMed (Anvisa)
```

O Firestore é a **fonte única de verdade** (single source of truth) para
casos, configuração, usuários e gatilhos. O Google Sheets deixou de ser um
espelho bidirecional: hoje é só um livro-razão *append-only* usado como
backup/trilha de auditoria — nenhuma rotina do sistema volta a lê-lo para
decidir comportamento (ver cabeçalho de `Mirror.gs`).

## Fluxo de um caso

1. **Gatilho detectado** → robô PowerShell envia o alerta via `doPost`
   (`Ingest.gs`, ação `insertDB`), assinado por HMAC.
2. **Triagem** → farmacêutico avalia o alerta no Kanban e decide se abre
   investigação.
3. **Investigação** → preenchimento de dados clínicos, causalidade
   (Naranjo), conduta e desfecho (`js_investigacao.html` → `Cases.gs`).
4. **Notificação espontânea** (rota alternativa) → assistência relata
   direto pelo formulário público (`form.html`).
5. **Fechamento do caso** → auditoria carimbada (`Audit.gs`) e espelhada
   no Sheets (`Mirror.gs`).
6. **Exportação regulatória** (quando aplicável) → XML ICH E2B(R3)
   gerado por `E2b.gs` para importação manual no VigiMed.

## Estrutura do repositório

| Arquivo | Responsabilidade |
|---|---|
| `Router.gs` | Pontos de entrada HTTP (`doGet`/`doPost`) — só roteamento. |
| `Security.gs` | Camada de segurança de borda: HMAC-SHA256 do ETL, allowlist de pastas do Drive. |
| `Auth.gs` | Autenticação, sessão (`CacheService`) e identidade do usuário. |
| `Admin.gs` | Gestão de usuários (somente perfil ADMIN). |
| `Cases.gs` | Operações de caso (triagem, investigação, transações Firestore). |
| `Config.gs` / `Config write.gs` | Configuração externalizada (setores, listas, Naranjo) — leitura e escrita. |
| `Ingest.gs` | Camada de ingestão/ETL: recebe alertas do robô, expõe lista de gatilhos. |
| `Notify.gs` | Disparo de e-mails (alertas, demanda espontânea, conclusão de investigação). |
| `Firestore.gs` | Cliente REST do Cloud Firestore autenticado por Service Account (JWT/OAuth2). |
| `Mirror.gs` | Backup append-only Firestore → Google Sheets (auditoria LGPD). |
| `Audit.gs` | Resolução da identidade do usuário atual para carimbo de auditoria. |
| `Schema.gs` | Fonte única de verdade de colunas, status e nomes de coleção/aba. |
| `E2b.gs` | Geração do XML ICH E2B(R3) para importação no VigiMed. |
| `Favicon.gs` | Ícone da aba do navegador via `setFaviconUrl` (contorna sandbox do iframe do Apps Script). |
| `Diagnostico.gs` | Utilitário de investigação/diagnóstico (rodar manualmente no editor). |
| `Manuntenção.gs` | Rotinas administrativas pontuais (limpeza de casos, reset pré go-live). |
| `MigracaoFirestore.gs`, `migration.gs`, `Migracao schemae2b.gs` | Scripts de migração pontual Sheets → Firestore e de reordenação de schema. |
| `EXPORT COD.gs` | Exporta o projeto Apps Script inteiro para Markdown (backup/documentação). |
| `index.html` | Painel Kanban (aplicação principal). |
| `form.html` | Formulário público de notificação espontânea. |
| `js_core.html` | Núcleo JS compartilhado do painel (autenticação, config, utilidades). |
| `js_admin.html` | Tela de administração (usuários, setores, listas, gatilhos). |
| `js_dashboard.html` | Dashboard analítico. |
| `js_investigacao.html` | Modal de investigação farmacêutica. |
| `js_kanban.html` | Lógica do quadro Kanban. |
| `js_notificacao_interna.html` | Notificações internas do painel. |
| `js_triagem.html` | Fluxo de triagem. |
| `styles.html` | CSS pré-compilado (Tailwind + estilos customizados), embutido nas páginas. |
| `icons.html` | Sprite/definições de ícones (Font Awesome). |
| `appsscript.json` | Manifesto do Apps Script (escopos OAuth, biblioteca OAuth2, config do webapp). |
| `tailwind.config.js`, `tw-input.css`, `build-icons.js` | Tooling de build do CSS/ícones (dev-only, não sobe ao Apps Script). |

Documentação complementar:

- [`README-build-css.md`](./README-build-css.md) — como regerar o CSS pré-compilado.
- [`roadmap_melhoria_xml_e2b.md`](./roadmap_melhoria_xml_e2b.md) — roadmap detalhado da exportação E2B(R3)/VigiMed.
- `auditoria_qa_datas_tipagem_2026-07-13.md` — auditoria de QA (tipagem/datas) do projeto.

## Stack tecnológica

- **Backend:** Google Apps Script (runtime V8), Node.js apenas para tooling de build.
- **Persistência:** Cloud Firestore (modo Nativo, via REST API) como fonte de verdade; Google Sheets como backup append-only.
- **Frontend:** HTML Service do Apps Script + Tailwind CSS (pré-compilado) + Font Awesome.
- **Autenticação:** sessão própria via `CacheService`, hash salgado SHA-256; biblioteca [OAuth2 for Apps Script](https://github.com/googleworkspace/apps-script-oauth2) para o Service Account do Firestore.
- **Integrações:** robô ETL em PowerShell (fora deste repositório), VigiFlow/VigiMed (Anvisa) via importação manual de XML.

## Configuração e deploy

Pré-requisitos: [clasp](https://github.com/google/clasp) instalado e autenticado, com acesso ao projeto Apps Script.

```bash
clasp login          # uma vez por máquina
clasp pull           # traz o estado atual do projeto Apps Script
# ... editar código ...
clasp push            # envia o repositório para o Apps Script
```

`.claspignore` mantém fora do push tudo que é só tooling de dev (Node,
Tailwind, `.md`, `favicon.png` etc.) — o Apps Script recebe apenas os
arquivos `.gs`/`.html`/`.json` de runtime.

### Script Properties necessárias (Apps Script → Configurações do projeto)

| Propriedade | Uso |
|---|---|
| `FIRESTORE_PROJECT_ID`, `FIRESTORE_CLIENT_EMAIL`, `FIRESTORE_PRIVATE_KEY` | Credenciais do Service Account para `Firestore.gs`. |
| `FIRESTORE_DATABASE_ID` | Opcional, se não usar o banco `(default)`. |
| `ETL_SECRET` | Segredo HMAC compartilhado com o robô PowerShell (ver `Security.gs`). Gerar com `gerarSegredoETL_()` e definir com `definirSegredoETL_()`, rodando manualmente no editor — nunca hardcode no código. |
| `ETL_FOLDER_IDS` | Opcional — CSV de IDs de pasta do Drive permitidos para `uploadRaw`. |

### Dependências do manifesto (`appsscript.json`)

- Biblioteca **OAuth2 for Apps Script** (Script ID em `appsscript.json`).
- Escopos: Drive, Sheets, envio de e-mail, requisições externas (Firestore REST) e leitura do próprio projeto.
- Web app publicado como `USER_DEPLOYING`, acesso `ANYONE_ANONYMOUS` (o formulário e o painel exigem login próprio via `Auth.gs`, não o login do Google).

## Build do CSS (Tailwind)

O CSS já vem pré-compilado em `styles.html` — quem só publica o app não
precisa rodar nada. Só é necessário regerar o build ao adicionar/alterar
classes Tailwind:

```bash
npm install
npm run build:css     # gera tw-output.css a partir dos .html
```

Detalhes completos, incluindo onde colar o resultado, em
[`README-build-css.md`](./README-build-css.md).

## Segurança

- **ETL (robô PowerShell):** toda escrita (`insertDB`, `uploadRaw`) exige
  assinatura HMAC-SHA256 com janela anti-replay de ±5 min e comparação em
  tempo constante (`Security.gs`).
- **Sessão de usuário:** hash salgado SHA-256 com upgrade transparente de
  senhas legadas, token de sessão via `CacheService` (`Auth.gs`).
- **Perfis:** ações administrativas exigem token válido + perfil ADMIN
  verificado no servidor (`Admin.gs`, `Config write.gs`).
- **Funções perigosas** (definir segredo, apagar casos, resetar base)
  terminam propositalmente com `_` para ficarem fora do
  `google.script.run` — só executáveis manualmente pelo editor do Apps
  Script (ver `Security.gs` e `Manuntenção.gs`).
- **Contenção do piloto:** `verificarAmbienteAutorizado_()` (`Security.gs`,
  chamada em todo `doGet`/`doPost`) trava o ambiente por e-mail do
  deployer + `scriptId` autorizado (bloqueia cópia do projeto para outra
  conta/unidade) e, opcionalmente, por data de validade
  (`definirValidadePiloto_()`) — passado o prazo combinado com a
  instituição, o sistema bloqueia até renovação manual. É uma trava
  técnica redundante com o acordo formal do piloto, não um substituto
  dele.
- **LGPD:** PII do notificador foi isolada em colunas próprias (ver
  `migration.gs`), e toda gravação relevante é carimbada com autor e
  timestamp (`Audit.gs`) e preservada em log de auditoria imutável.

## Exportação E2B(R3) para o VigiMed

`E2b.gs` gera o XML ICH E2B(R3) para importação no VigiFlow/VigiMed,
validado estruturalmente contra o ambiente de teste da Anvisa. Limitações
conhecidas atuais (documentadas no cabeçalho do arquivo):

- Sem licença MedDRA/WHODrug ativa — reação sai sem código codificado
  (`nullFlavor="NI"`), o que hoje **sempre** força correção manual no
  VigiMed, mesmo com o restante do XML correto.
- Gera apenas notificação **inicial** — follow-up/nullification ainda não
  implementados.
- Reação e medicamento são hoje tratados como campos escalares (1
  reação/1 medicamento por caso), não como listas repetíveis.

O plano completo de evolução — por fase, com XPaths confirmados contra o
Implementation Guide oficial do ICH — está em
[`roadmap_melhoria_xml_e2b.md`](./roadmap_melhoria_xml_e2b.md).

## Scripts utilitários

Rodar sempre manualmente pelo editor do Apps Script (não expostos ao
frontend):

- `Diagnostico.gs` → `diagnosticarAdmin()`: inspeciona coleções do
  Firestore sem alterar nada, útil para depurar problemas de dados.
- `Manuntenção.gs` → limpeza de casos antigos e reset pré go-live, sempre
  com uma função `_dryRun_` para simular antes de aplicar.
- `MigracaoFirestore.gs`, `migration.gs`, `Migracao schemae2b.gs` →
  scripts de migração pontual (Sheets → Firestore, reordenação de
  colunas). Idempotentes, com modo `dryRun`.
- `EXPORT COD.gs` → `exportarProjetoCompletoParaMD()`: exporta o projeto
  Apps Script inteiro para um `.md` (backup/documentação fora do Git).

## Roadmap

Veja [`roadmap_melhoria_xml_e2b.md`](./roadmap_melhoria_xml_e2b.md) para o
roadmap detalhado da integração E2B(R3)/VigiMed, e
`auditoria_qa_datas_tipagem_2026-07-13.md` para o histórico de auditoria
de qualidade do projeto.
