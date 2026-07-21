# VigiRAM

Sistema de farmacovigilância hospitalar para gestão do ciclo completo de
notificações de Reação Adversa a Medicamento (RAM) — da ingestão automática
de alertas, passando pela triagem e investigação farmacêutica, até a
exportação do XML ICH E2B(R3) para importação no **VigiMed** (Anvisa).

Desenvolvido para o **Hospital Regional Norte** (CNES 6848710), roda
inteiramente como um **Google Apps Script Web App**, sem servidor próprio.

> Repositório fonte-única para `clasp push`/`clasp pull`. O deploy real
> acontece no editor do Apps Script ou via integração GitHub ↔ Apps Script.

> **Este repositório é só a casca institucional** (front-end + roteamento
> fino). Toda a lógica de negócio (autenticação, casos, config, ETL,
> notificações, Firestore, E2B) vive numa **Apps Script Library** separada,
> em [`vigiram-backend`](https://github.com/giselecan/vigiram-backend),
> mantida em conta própria — ver [Arquitetura](#arquitetura).

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
- **Exportação E2B(R3)** (`E2b.gs`, no backend) — gera XML ICH validado
  estruturalmente para importação no VigiMed.
- **Notificações por e-mail** (`Notify.gs`, no backend) para farmacêuticos
  por setor, em cada etapa relevante do fluxo.
- **Autenticação e perfis** (`Auth.gs`, `Admin.gs`, no backend) com sessão
  via `CacheService`, senha com hash salgado (SHA-256) e perfis
  farmacêutico/admin.
- **Auditoria completa** (`Audit.gs`, `Mirror.gs`, no backend) — todo caso
  é carimbado com autor/timestamp e espelhado de forma append-only no
  Google Sheets como trilha de auditoria LGPD.

## Arquitetura

O sistema é dividido em **dois projetos Apps Script, em duas contas
Google diferentes**, ligados por uma [Library](https://developers.google.com/apps-script/guides/libraries):

- **`vigiram-gas`** (este repo, conta institucional): só o front-end
  (`index.html`, `form.html`, `js_*.html`, `styles.html`, `icons.html`),
  `Favicon.gs`, e três arquivos finos de roteamento — `Router.gs`
  (`doGet`/`doPost`), `Triggers.gs` (handlers de trigger) e
  `FrontendApi.gs` (repasse das funções chamadas por `google.script.run`).
  Nenhum segredo (Firestore, HMAC do ETL) fica aqui.
- **[`vigiram-backend`](https://github.com/giselecan/vigiram-backend)**
  (conta pessoal, importado como library `Backend`): toda a lógica —
  `Security.gs`, `Auth.gs`, `Admin.gs`, `Cases.gs`, `Config.gs`/
  `Config write.gs`, `Ingest.gs`, `Notify.gs`, `Firestore.gs`, `Mirror.gs`,
  `Audit.gs`, `Schema.gs`, `E2b.gs`, scripts de migração/manutenção. As
  Script Properties com credenciais (Service Account do Firestore, segredo
  do ETL) ficam só aqui.

```
                         ┌─────────────────────┐
   Robô ETL (PowerShell) │  varre prontuários   │
   assinado por HMAC     │  por medicamento-    │
            │            │  gatilho             │
            │            └─────────────────────┘
            ▼
┌─────────────── vigiram-gas (institucional) ───────────────┐
│  doGet/doPost (Router.gs) → Backend.autorizarAmbiente()    │
│  FrontendApi.gs / Triggers.gs → Backend.<função>()         │
│  index.html, form.html, js_*.html, styles.html, icons.html │
└──────────────────────────┬──────────────────────────────────┘
                           │ Apps Script Library
                           ▼
┌─────────── vigiram-backend (conta pessoal, library) ───────────┐
│  Security.gs → Ingest.gs → Cases.gs → Config.gs → Auth.gs →      │
│  Admin.gs → Notify.gs → E2b.gs                                   │
│                              │                                   │
│                              ▼                                   │
│                     Firestore.gs (REST API, Service Account/JWT) │
│                     ── fonte única de verdade ──                 │
│                              │                                   │
│                              ▼                                   │
│                     Mirror.gs → Google Sheets (append-only)      │
└───────────────────────────────────────────────────────────────────┘
            │
            ▼
   E2B(R3) XML  →  importação manual no VigiFlow/VigiMed (Anvisa)
```

O Firestore **continua hospedado no domínio da instituição** (projeto GCP
institucional) — é a **fonte única de verdade** para casos, configuração,
usuários e gatilhos. O Google Sheets deixou de ser um espelho
bidirecional: hoje é só um livro-razão *append-only* usado como
backup/trilha de auditoria — nenhuma rotina do sistema volta a lê-lo para
decidir comportamento (ver cabeçalho de `Mirror.gs`, no backend).

## Fluxo de um caso

> Os arquivos citados abaixo (`Ingest.gs`, `Cases.gs`, `Audit.gs`,
> `Mirror.gs`, `E2b.gs`) vivem hoje no repositório
> [`vigiram-backend`](https://github.com/giselecan/vigiram-backend).

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

Este repositório (`vigiram-gas`) é só a **casca institucional**:

| Arquivo | Responsabilidade |
|---|---|
| `Router.gs` | Pontos de entrada HTTP (`doGet`/`doPost`) — repassa para a library `Backend` e renderiza os templates HTML (que só existem neste projeto). |
| `Triggers.gs` | Instalação/remoção/verificação dos triggers de tempo + handlers de 1 linha que chamam `Backend.*` (triggers instaláveis não podem apontar para função de library). |
| `FrontendApi.gs` | Repasse de 1 linha para cada função que os HTMLs chamam via `google.script.run` (que só consegue chamar função do próprio projeto). |
| `Favicon.gs` | Ícone da aba do navegador via `setFaviconUrl` (contorna sandbox do iframe do Apps Script). |
| `Utils.gs` | Só `createJsonResponse` e `include()` — o resto dos helpers foi para o backend. |
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
| `appsscript.json` | Manifesto do Apps Script (escopos OAuth, biblioteca `Backend`, config do webapp). |
| `tailwind.config.js`, `tw-input.css`, `build-icons.js` | Tooling de build do CSS/ícones (dev-only, não sobe ao Apps Script). |

Toda a lógica de negócio (`Security.gs`, `Auth.gs`, `Admin.gs`, `Cases.gs`,
`Config.gs`/`Config write.gs`, `Ingest.gs`, `Notify.gs`, `Firestore.gs`,
`Mirror.gs`, `Audit.gs`, `Schema.gs`, `E2b.gs`, `Diagnostico.gs`,
`Manuntenção.gs`, scripts de migração, `EXPORT COD.gs`) está em
[`vigiram-backend`](https://github.com/giselecan/vigiram-backend) — ver o
README de lá para a responsabilidade de cada arquivo.

Documentação complementar:

- [`README-build-css.md`](./README-build-css.md) — como regerar o CSS pré-compilado.
- [`roadmap_melhoria_xml_e2b.md`](./roadmap_melhoria_xml_e2b.md) — roadmap detalhado da exportação E2B(R3)/VigiMed.
- `auditoria_qa_datas_tipagem_2026-07-13.md` — auditoria de QA (tipagem/datas) do projeto.

## Stack tecnológica

- **Backend:** Google Apps Script (runtime V8), Node.js apenas para tooling de build.
- **Persistência:** Cloud Firestore (modo Nativo, via REST API, projeto institucional) como fonte de verdade; Google Sheets como backup append-only.
- **Frontend:** HTML Service do Apps Script + Tailwind CSS (pré-compilado) + Font Awesome.
- **Autenticação:** sessão própria via `CacheService`, hash salgado SHA-256; biblioteca [OAuth2 for Apps Script](https://github.com/googleworkspace/apps-script-oauth2) para o Service Account do Firestore (declarada no manifesto do `vigiram-backend`).
- **Integrações:** robô ETL em PowerShell (fora deste repositório), VigiFlow/VigiMed (Anvisa) via importação manual de XML.
- **Separação de projetos:** este projeto (casca) consome a lógica de
  [`vigiram-backend`](https://github.com/giselecan/vigiram-backend) como
  [Apps Script Library](https://developers.google.com/apps-script/guides/libraries).

## Configuração e deploy

Pré-requisitos: [clasp](https://github.com/google/clasp) instalado e
autenticado, com acesso aos **dois** projetos Apps Script (este e o
`vigiram-backend`, em contas diferentes).

```bash
clasp login          # uma vez por máquina (conta institucional)
clasp pull           # traz o estado atual do projeto Apps Script
# ... editar código ...
clasp push            # envia o repositório para o Apps Script
```

`.claspignore` mantém fora do push tudo que é só tooling de dev (Node,
Tailwind, `.md`, `favicon.png` etc.) — o Apps Script recebe apenas os
arquivos `.gs`/`.html`/`.json` de runtime.

### Ligar este projeto à library `vigiram-backend`

1. Siga o `README.md` do [`vigiram-backend`](https://github.com/giselecan/vigiram-backend)
   para criar o projeto na conta pessoal, configurar as Script Properties
   lá e salvar uma versão.
2. Edite `appsscript.json` deste repo: troque
   `COLOQUE_AQUI_O_SCRIPT_ID_DO_PROJETO_BACKEND_PESSOAL` pelo Script ID
   real e `"version"` pelo número da versão salva (ou adicione a library
   pelo editor do Apps Script — `Libraries` (+) → colar o Script ID →
   identificador **`Backend`** — o que gera a mesma entrada em
   `appsscript.json` automaticamente).
3. `clasp push` neste projeto.

Sem esse passo, `doGet`/`doPost`/os HTMLs não funcionam — todos dependem
de `Backend.*`.

### Script Properties

Não ficam mais aqui. `FIRESTORE_PROJECT_ID`, `FIRESTORE_CLIENT_EMAIL`,
`FIRESTORE_PRIVATE_KEY`, `FIRESTORE_DATABASE_ID`, `ETL_SECRET`,
`ETL_FOLDER_IDS` são configuradas nas Script Properties do projeto
**`vigiram-backend`** (conta pessoal) — ver o README de lá.

### Dependências do manifesto (`appsscript.json`)

- Biblioteca **`Backend`** (aponta para o `vigiram-backend`, Script ID +
  versão).
- Escopos: Drive, Sheets, envio de e-mail, requisições externas (Firestore
  REST) e leitura do próprio projeto — precisam continuar declarados aqui
  porque a autorização de quem executa o Web App (este projeto) vale
  também para o código da library que ele chama.
- Web app publicado como `USER_DEPLOYING`, acesso `ANYONE_ANONYMOUS` (o
  formulário e o painel exigem login próprio via `Auth.gs`, no backend,
  não o login do Google).

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

> `Security.gs`, `Auth.gs`, `Admin.gs`, `Config write.gs`, `Manuntenção.gs`
> e `Audit.gs`, citados abaixo, vivem no
> [`vigiram-backend`](https://github.com/giselecan/vigiram-backend).

- **ETL (robô PowerShell):** toda escrita (`insertDB`, `uploadRaw`) exige
  assinatura HMAC-SHA256 com janela anti-replay de ±5 min e comparação em
  tempo constante (`Security.gs`).
- **Sessão de usuário:** hash salgado SHA-256 com upgrade transparente de
  senhas legadas, token de sessão via `CacheService` (`Auth.gs`).
- **Perfis:** ações administrativas exigem token válido + perfil ADMIN
  verificado no servidor (`Admin.gs`, `Config write.gs`).
- **Funções perigosas** (definir segredo, apagar casos, resetar base)
  terminam propositalmente com `_` para ficarem fora do
  `google.script.run` **e** fora do alcance deste projeto institucional —
  funções terminadas em `_` não são visíveis para quem consome a library
  `Backend` — só executáveis manualmente pelo editor do próprio
  `vigiram-backend` (ver `Security.gs` e `Manuntenção.gs`). `PublicApi.gs`,
  no backend, expõe deliberadamente só 3 atalhos para o `Router.gs` desta
  casca chamar.
- **Trava de ambiente:** `verificarAmbienteAutorizado_` (`Security.gs`,
  backend) verifica e-mail de deploy autorizado e `ScriptApp.getScriptId()`
  contra um ID travado — dentro de uma library, `getScriptId()` retorna o
  ID de quem chama (este projeto institucional), então a trava continua
  valendo sem alterações mesmo após a separação.
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

Vivem no [`vigiram-backend`](https://github.com/giselecan/vigiram-backend),
rodar sempre manualmente pelo editor do Apps Script daquele projeto (não
expostos a este front-end):

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
