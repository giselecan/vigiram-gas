# Plano de Migração — Conta Institucional → Conta Pessoal

> Escopo: migrar a **hospedagem/propriedade** do projeto Apps Script, do
> Drive/Sheets de auditoria, do envio de e-mail e do gate de
> licenciamento do VigiRAM da conta institucional (`@isgh.org.br`) para a
> conta pessoal `giselechereese@gmail.com`, com o sistema em **produção**
> e sem perda de dados/histórico de auditoria.
>
> **Decisão explícita:** o **Firestore/projeto Google Cloud permanece na
> conta institucional** — não faz parte desta migração. Isso é
> tecnicamente tranquilo: o `Firestore.gs` autentica por **Service
> Account (JWT)**, não pelo usuário humano que fez o deploy do Apps
> Script. A mesma chave de Service Account funciona de dentro de um
> projeto Apps Script pessoal, apontando para o mesmo banco Firestore
> institucional, sem nenhuma mudança de dados, de IAM ou de billing no
> GCP. Isso também significa que os dados clínicos em si (e o controle
> institucional sobre eles) **não saem** da governança do hospital — só a
> "porta de entrada" (Apps Script/deploy/e-mail) passa a ser administrada
> por você.
>
> Situação declarada: acesso total de administrador ainda ativo nas contas
> institucionais; motivo é manter propriedade/controle pessoal do projeto
> (sem prazo de desligamento). Isso permite uma migração **em paralelo**,
> com corte (cutover) só depois de validar tudo — a rota mais segura.

---

## 0. Por que isso não é só "trocar um e-mail"

O VigiRAM roda inteiramente como Google Apps Script Web App, publicado com
`executeAs: "USER_DEPLOYING"` (`appsscript.json`). Isso significa que
**a identidade de quem publicou a implantação (deploy) determina**:

- **De quem sai o e-mail** de todas as notificações (`MailApp.sendEmail`
  em `Notify.gs`, `Mirror.gs` — nenhuma define `from` explícito, então
  sai sempre como a conta que fez o deploy).
- **A identidade de sessão** usada em `Session.getEffectiveUser()`
  (`Security.gs:188`) e `Session.getActiveUser()` (`Audit.gs:34`) — que
  hoje alimenta o **gate de licenciamento/autoria**
  (`verificarAmbienteAutorizado_`, `Security.gs:183-215`) e o carimbo de
  auditoria quando não há sessão de app.
- **Quem é dono dos arquivos** criados via `DriveApp` (pasta de upload do
  ETL em `Ingest.gs`, planilha-espelho de auditoria em `Mirror.gs`) e via
  `SpreadsheetApp`.
- **Quem pode gerenciar os triggers instaláveis** (`processarFilaNotificacoes`,
  `enviarRelatorioDiarioGatilhos`, `processarFilaEspelho` — ver
  `Notify.gs:498,630` e `Mirror.gs:471`), que rodam sob a identidade de
  quem os instalou.

Já o **Firestore é independente disso**: a autenticação é feita por
Service Account (JWT), via `FIRESTORE_PROJECT_ID` /
`FIRESTORE_CLIENT_EMAIL` / `FIRESTORE_PRIVATE_KEY` nas Script Properties
(`Firestore.gs`). Por isso o Firestore pode continuar 100% institucional
(decisão tomada na introdução deste documento) enquanto só o "dono" do
Apps Script muda — as mesmas credenciais de Service Account são apenas
copiadas para as Script Properties do novo projeto pessoal, sem tocar em
nenhum dado.

O Google também **restringe transferência de propriedade de arquivos do
Drive/Apps Script para fora do domínio Workspace** (não existe um
"transferir dono" direto de `@isgh.org.br` para uma conta pessoal
`@gmail.com` na maioria das configurações). Por isso o plano abaixo usa
duas estratégias diferentes por tipo de recurso:

| Recurso | Estratégia | Por quê |
|---|---|---|
| Projeto Google Cloud (Firestore) | **Permanece institucional — fora do escopo desta migração** | Autenticação é por Service Account (JWT), independente de quem publica o Apps Script. Nenhuma mudança necessária. |
| Projeto Apps Script | **Recriação sob a conta pessoal** (`clasp clone`/`push`), rodando em paralelo até o corte | Apps Script/Drive normalmente não permite mudar o dono para fora do domínio Workspace. |
| Planilha-espelho de auditoria (Sheets) | **Nova planilha na conta pessoal a partir da data de corte**; a antiga fica congelada como arquivo histórico | Mesma restrição de domínio. Um espelho *append-only* pode perfeitamente "trocar de arquivo" numa data — desde que ambos fiquem preservados e rastreáveis. |
| Repositório GitHub | Depende de quem é hoje o *owner*/organização do repo | Ver Seção 7, item 2. |

---

## 1. Riscos e pontos de atenção antes de começar

### 1.1 Cota de envio de e-mail do Gmail pessoal — risco operacional real
`MailApp.sendEmail` consome a cota diária de envio da conta que fez o
deploy. Uma conta **Gmail pessoal gratuita tem limite de ~100
e-mails/dia**; uma conta **Google Workspace institucional costuma ter
1.500/dia**. Se o volume de notificações do VigiRAM (gatilhos diários +
demandas espontâneas + conclusões de investigação, por farmacêutico) se
aproximar de 100/dia, a migração pode causar **falha silenciosa de
notificações** sem nenhum erro visível no painel.
→ **Ação antes de migrar:** contar quantos e-mails o sistema envia num dia
típico (dá para estimar olhando `enviarRelatorioDiarioGatilhos` e o volume
de casos). Se estiver perto do limite, ver as opções para manter o envio
de e-mail no institucional na **Seção 2** deste documento.

### 1.2 Dado de saúde (LGPD) — governança, não só técnica
O VigiRAM processa dados de **farmacovigilância com dados pessoais/dados
sensíveis de pacientes** (RAM, prontuário, desfecho clínico). Mesmo que
apenas a *propriedade administrativa* da infraestrutura mude (e os dados
continuem os mesmos, no mesmo Firestore), isso muda quem tecnicamente
tem acesso root às credenciais e ao Drive de auditoria. Isso pode ter
implicação contratual/institucional além do técnico.
→ **Recomendação:** antes do corte final (Fase 5), alinhar formalmente
com a coordenação/DPO do hospital que a operação do sistema passará a
rodar sob uma conta pessoal — mesmo que você mantenha a "unidade
autorizada" como usuária exclusiva por licença (`Security.gs`). Isso evita
que a migração técnica vire um problema de compliance depois.

### 1.3 Gate de autoria/licenciamento pode te trancar para fora
`Security.gs:183-215` bloqueia a aplicação inteira se
`Session.getEffectiveUser().getEmail()` não estiver na lista autorizada.
A lista padrão no código **já inclui** `giselechereese@gmail.com`
(`Security.gs:164`), mas se a Script Property `VIGIRAM_OWNER_EMAIL`
estiver definida no projeto ao vivo (ela sobrescreve o default e **não
está documentada no README**), pode estar limitada só ao institucional.
→ **Ação antes de migrar:** no editor do Apps Script, checar
`Configurações do projeto → Script Properties` se `VIGIRAM_OWNER_EMAIL`
existe e o que contém.

### 1.4 Credencial institucional do Firestore vai residir num projeto pessoal
Como o Firestore fica institucional mas o Apps Script passa a ser
pessoal, a chave de Service Account (`FIRESTORE_PRIVATE_KEY` e
`FIRESTORE_CLIENT_EMAIL`) — que é um segredo institucional — vai ficar
armazenada nas Script Properties de um projeto que só você administra.
Tecnicamente isso já é assim hoje (o segredo já passa por Script
Properties), mas vale confirmar dois pontos antes do corte:
- A Service Account tem **permissão mínima necessária** no GCP (só
  Firestore, não "Owner" do projeto todo) — se ainda não for esse o caso,
  vale restringir o papel IAM dela antes de migrar.
- Se um dia a Service Account precisar ser **rotacionada** (nova chave),
  isso terá que ser feito por quem ainda tem acesso ao GCP institucional
  e comunicado a você para atualizar a Script Property no projeto
  pessoal — documentar esse contato/processo evita um "segredo expirado"
  travar o sistema sem aviso.

### 1.5 URL da implantação muda
Uma nova implantação (deploy) sob a conta pessoal gera uma **nova URL**
(`.../macros/s/{deploymentId}/exec`). Isso afeta:
- O robô ETL PowerShell (precisa apontar para a nova URL).
- `URL_SISTEMA` em `Config.gs`/painel Admin (usada nos links dos e-mails).
- Favoritos/atalhos que a equipe de farmácia já usa no navegador.

---

## 2. Manter o envio de e-mail no institucional (opcional)

Resposta curta: **dá para manter o remetente institucional, mas as duas
formas de fazer isso resolvem problemas diferentes** — uma é cosmética,
a outra resolve a cota de verdade (item 1.1). Importante decidir com essa
distinção clara antes de implementar.

### Opção A — Alias "Enviar como" (baixo esforço, NÃO resolve a cota)
1. Na conta institucional: gerar uma **senha de app** em
   myaccount.google.com → Segurança → Senhas de app (exige verificação em
   duas etapas ativada; se o Workspace bloquear, um admin precisa liberar
   em Admin Console → Segurança → Acesso a apps menos seguros/senhas de
   app).
2. Na conta **pessoal**, Gmail → Configurações → Contas e importação →
   "Enviar e-mail como" → Adicionar outro endereço de e-mail.
3. Informar o endereço institucional, marcar "Tratar como alias" e
   "Enviar através dos servidores SMTP" (`smtp.gmail.com`, porta 587,
   usuário = e-mail institucional, senha = senha de app do passo 1).
4. Confirmar o e-mail de verificação que o Google manda para a caixa
   institucional.
5. No código (`Notify.gs`, `Mirror.gs`), adicionar
   `from: 'endereco@isgh.org.br'` nas chamadas `MailApp.sendEmail(...)`.

⚠️ **A cota consumida continua sendo a da conta pessoal** (~100/dia) —
quem processa o envio de fato é sempre quem executa o Apps Script. Essa
opção só muda a aparência do remetente, não resolve o risco 1.1.

### Opção B — Relay de e-mail rodando na conta institucional (resolve a cota, mais esforço)
Criar um **segundo projeto Apps Script**, minúsculo, publicado como Web
App **sob a conta institucional** (esse projeto nunca migra), com a única
função de receber um pedido de envio via `doPost` — autenticado com HMAC,
reaproveitando o mesmo padrão de `Security.gs` usado hoje para o ETL — e
chamar `MailApp.sendEmail()` rodando como institucional (usa a cota do
Workspace, ~1.500/dia).

No VigiRAM (conta pessoal), trocar as chamadas diretas a
`MailApp.sendEmail()` em `Notify.gs`/`Mirror.gs` por uma chamada HTTP
(`UrlFetchApp.fetch`) a esse relay, com fallback para envio direto pela
conta pessoal se o relay não responder — mesma lógica de degradação
graciosa já usada em `getConfig()` (`Config.gs`).

Vantagem: resolve a cota de verdade, sem tag "via" no e-mail. Desvantagem:
mais um projeto para manter, que continua sendo uma dependência da conta
institucional — avaliar se isso é aceitável dado o motivo da migração
(Seção 6, item 2 das decisões em aberto).

### Recomendação
Meça o volume real primeiro (item 1.1). Bem abaixo de 100/dia → nem vale
implementar a Opção A, deixe o remetente ser a conta pessoal mesmo. Perto
ou acima do limite → só a Opção B resolve de verdade; a Opção A sozinha
apenas maquia o problema e o sistema continuará falhando silenciosamente
acima da cota.

✅ **Decidido:** volume medido está bem abaixo de 100 e-mails/dia. O envio
segue **direto pela conta pessoal**, sem alias e sem relay institucional —
`MailApp.sendEmail()` continua como está em `Notify.gs`/`Mirror.gs`, sem
nenhuma mudança de código. Reavaliar essa decisão só se o volume crescer
de forma relevante no futuro (ex.: mais setores/unidades usando o
sistema).

---

## 3. Pré-requisitos (Fase 0 — preparação, sem impacto em produção)

1. **Backup completo do código-fonte:** rodar
   `exportarProjetoCompletoParaMD()` (`EXPORT COD.gs`) e guardar o `.md`
   fora do Drive institucional (ex.: local + repositório). Além disso
   `git push` deste repositório já garante versão do código.
2. **Checar `VIGIRAM_OWNER_EMAIL`** e `VIGIRAM_AUTHORIZED_SCRIPT_ID` nas
   Script Properties do projeto ao vivo (item 1.3).
3. **Levantar todas as Script Properties atuais** (`FIRESTORE_*`,
   `ETL_SECRET`, `ETL_FOLDER_IDS`, `VIGIRAM_*`) e guardar os valores em um
   cofre de senhas pessoal (nunca em arquivo de texto solto).
4. **Confirmar que a Service Account do Firestore continua ativa e com
   permissão mínima necessária** (Console GCP → IAM) — o Firestore
   permanece institucional nesta migração (ver decisão na introdução),
   então não há transferência de propriedade a fazer aqui, só confirmar
   que a chave em uso é válida e o papel IAM é escopado (item 1.4).
5. **Confirmar o dono do repositório GitHub** `giselecan/vigiram-gas` —
   se está sob organização institucional, avaliar se também precisa
   migrar para conta/organização pessoal (fora do escopo técnico deste
   plano, é uma decisão de governança à parte).
6. **Estimar volume diário de e-mail** (item 1.1).
7. **Definir uma janela de baixo uso** para o corte final (Fase 5) — por
   exemplo, fim de semana ou fora do horário de triagem, mesmo a migração
   sendo desenhada para near-zero-downtime.

---

## 4. Fases da migração

### Fase 1 — Novo projeto Apps Script (paralelo, sem afetar produção)
1. `clasp login` com a conta pessoal (`giselechereese@gmail.com`), numa
   sessão separada da institucional.
2. Criar um **novo** projeto Apps Script vazio, já sob a conta pessoal:
   `clasp create --type webapp --title "VigiRAM (pessoal)"`.
3. `clasp push` do conteúdo deste repositório para o novo projeto.
4. Nas Script Properties do **novo** projeto, cadastrar os mesmos valores
   `FIRESTORE_*` levantados na Fase 0, item 3 — aponta para o **mesmo**
   banco Firestore (nenhuma duplicação/migração de dados de caso).
5. `ETL_SECRET`: gerar um **novo** segredo com `gerarSegredoETL_()` +
   `definirSegredoETL_()` no novo projeto (não reaproveitar o segredo
   institucional — é um bom momento de rotação, já que o segredo antigo
   nunca deve ter saído do ambiente antigo).
6. Ajustar `VIGIRAM_OWNER_EMAIL` (se necessário) para conter só
   `giselechereese@gmail.com` — ou deixar em branco para cair no default
   do código, que já inclui os dois e-mails.

*Risco: baixo — projeto novo, isolado, não interfere no que já está no ar.*

### Fase 2 — Implantação de teste (paralela)
1. No novo projeto, publicar uma implantação Web App
   (`executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`, igual ao
   atual) — vai gerar uma **URL de teste** própria.
2. Rodar `Diagnostico.gs → diagnosticarAdmin()` para conferir leitura do
   Firestore sem alterar nada.
2.1. **Checar a planilha (Fase 3) antes de qualquer outro teste.** No
   editor do projeto novo, criar e rodar manualmente uma função de teste
   (pode apagar depois):
   ```js
   function testarPlanilha_() {
     const ss = getPlanilha_();
     Logger.log(ss ? ('OK: ' + ss.getName()) : 'FALHOU: getPlanilha_() retornou null');
   }
   ```
   No log de execução: se aparecer `FALHOU`, é porque a Script Property
   `PLANILHA_ID` ainda não foi configurada (Fase 3, passo 3) ou a
   planilha ainda não foi compartilhada com a conta pessoal (Fase 3,
   passo 1) — resolva isso antes de seguir, senão o espelho de auditoria
   e outras rotinas que dependem do Sheets vão falhar silenciosamente.
3. Testar manualmente, só você, na URL nova:
   - Login (`Auth.gs`).
   - Abrir um caso de teste no Kanban.
   - Registrar uma investigação de teste (sem promover para status real).
   - Disparar um e-mail de teste pelo painel Admin
     (`js_admin.html` → botão de teste, usa `Notify.gs:605`) e confirmar
     que chega **e que o remetente agora é a conta pessoal**.
   - Gerar um XML E2B de um caso de teste e comparar com a versão gerada
     pela implantação institucional (deve ser idêntico).
4. **Não** instalar ainda os triggers de produção
   (`instalarTriggerNotificacoes`, `instalarTriggerRelatorioDiario`,
   trigger do `Mirror.gs`) nesta URL de teste — evita e-mails duplicados
   para farmacêuticos reais enquanto ainda há duas implantações "vivas".

*Risco: baixo/nenhum — ambiente de teste isolado, farmacêuticos
continuam usando a URL institucional normalmente.*

### Fase 3 — Planilha-espelho e pasta de auditoria

✅ **Decidido:** manter a **mesma planilha** institucional (não criar uma
nova) — mantém o histórico de auditoria contínuo, sem precisar arquivar
nada. Isso é possível porque o Apps Script grava numa planilha por
**permissão de acesso**, não por ser dono do arquivo.

1. Na planilha institucional (Drive), **Compartilhar** →  adicionar
   `giselechereese@gmail.com` como **Editor**.
2. ⚠️ **Achado técnico importante:** todo o código que lê/escreve na
   planilha (`getSheet_()` em `Utils.gs`, usado por `Mirror.gs` — o
   espelho de auditoria LGPD —, `Cases.gs`, `Manuntenção.gs` etc.) usava
   `SpreadsheetApp.getActiveSpreadsheet()` **sem nenhum ID explícito**.
   Isso só funciona se o projeto Apps Script for **vinculado
   (container-bound)** à planilha — que é o caso do projeto institucional
   original. Um projeto **novo/avulso** (criado via `clasp create`, como
   o da Fase 1) **não tem planilha "ativa" nenhuma** — a chamada retorna
   `null`, e o espelho de auditoria falharia silenciosamente. Isso já foi
   corrigido no código (`Utils.gs` → `getPlanilha_()`): agora ele usa a
   Script Property `PLANILHA_ID` quando ela existe, e só cai no
   `getActiveSpreadsheet()` como fallback (mantém compatível com o
   projeto institucional, que não precisa dessa propriedade).
3. No projeto **pessoal**, adicionar a Script Property `PLANILHA_ID` com
   o ID da planilha institucional (fica na URL dela:
   `docs.google.com/spreadsheets/d/{ID}/edit`).
4. Mesma lógica para a pasta do Drive usada pelo `Ingest.gs`
   (`ETL_FOLDER_IDS`): compartilhar a pasta existente como Editor com a
   conta pessoal (em vez de criar uma nova) e manter o mesmo valor de
   `ETL_FOLDER_IDS` no projeto novo.

*Risco: baixo, mas é o item mais fácil de esquecer — sem o passo 1
(compartilhar) e o passo 3 (`PLANILHA_ID`), o espelho de auditoria falha
sem aviso nenhum na tela.*

### Fase 4 — Ajustes de código (branch dedicada, revisão antes de subir)
Mudanças pequenas e não-destrutivas:
1. `Security.gs:157-166` — opcional: manter os dois e-mails na lista
   padrão por segurança (não remover o institucional do array até a
   Fase 6 estar validada — assim, se algo der errado, o deploy
   institucional continua autorizado a rodar como plano B).
2. `Config.gs:26`, `Notify.gs:208,325`, `Mirror.gs:431`, `E2b.gs:564` —
   `EMAIL_COORDENACAO`: **normalmente não precisa mudar no código** — é
   configurável pelo painel Admin (Firestore). Só editar o fallback
   hardcoded se o e-mail de coordenação institucional também estiver
   sendo desativado (decisão separada da migração de infraestrutura).
3. `README.md` — documentar `VIGIRAM_OWNER_EMAIL` e
   `VIGIRAM_AUTHORIZED_SCRIPT_ID` na tabela de Script Properties (hoje
   ausente — lacuna encontrada durante este levantamento).
4. Placeholders de UI (`index.html:57`, `js_admin.html:723`,
   `usuario@isgh.org.br`) — cosmético, atualizar só se o domínio
   institucional deixar de fazer sentido para os usuários finais do
   formulário/admin (pode manter como está sem nenhum efeito técnico).
5. ~~Se a decisão da Seção 2 for manter o e-mail institucional...~~ —
   **decidido (Seção 2): não é necessário.** Volume medido está bem
   abaixo da cota da conta pessoal, envio segue direto por ela, sem
   mudança de código neste item.

*Risco: baixo — mudanças pequenas, revisáveis em PR antes de ir para o ar.*

### Fase 5 — Corte (cutover) — na janela de baixo uso definida na Fase 0
Esta é a única fase com impacto direto em produção. Fazer nesta ordem,
com cada passo validado antes do próximo:

1. Colocar um aviso no painel (banner "manutenção programada às XXh").
2. Na implantação institucional, **anotar/exportar** qualquer fila
   pendente de notificação (`processarFilaNotificacoes`) — deixar
   esvaziar antes de trocar, para não perder e-mails enfileirados.
3. Desinstalar os 3 triggers da implantação institucional
   (`processarFilaNotificacoes`, `enviarRelatorioDiarioGatilhos`,
   `processarFilaEspelho`).
4. No novo projeto (conta pessoal), instalar os mesmos 3 triggers
   (`instalarTriggerNotificacoes()`, `instalarTriggerRelatorioDiario()`,
   trigger do `Mirror.gs`).
5. Atualizar `URL_SISTEMA` no painel Admin (Firestore config) para a nova
   URL da implantação pessoal.
6. Atualizar a configuração do robô ETL PowerShell com a **nova URL** e
   o **novo `ETL_SECRET`** gerado na Fase 1, passo 5.
7. Comunicar a equipe de farmácia clínica sobre a nova URL (atualizar
   favoritos/atalhos).
8. Rodar o checklist de fumaça completo (Seção 5 abaixo) na URL nova,
   agora com dados reais.
9. Manter a implantação institucional **publicada, mas sem triggers**,
   por alguns dias como plano B (ver Fase 6).

### Fase 6 — Estabilização e desligamento do acesso institucional
1. Observar por 3–7 dias: e-mails chegando, ETL inserindo casos,
   espelho de auditoria gravando, XML E2B gerando corretamente.
2. Só depois desse período: revogar `clasp login` institucional e — o
   passo mais delicado — **arquivar (não excluir)** a
   implantação/projeto Apps Script institucional (mantém histórico e
   serve de restauração de emergência). O Firestore/GCP institucional
   **não é tocado** neste passo — continua exatamente como está, já que
   permanece fora do escopo desta migração.
3. Nunca excluir a planilha de auditoria antiga nem o projeto Apps
   Script antigo — são registro histórico/LGPD.

---

## 5. Checklist de testes de fumaça (rodar na Fase 2 e de novo na Fase 5)

- [ ] **`getPlanilha_()` resolve a planilha correta** (rodar antes de
      tudo o resto — ver Fase 3 acima e o passo a passo logo abaixo). Se
      falhar, nada que dependa do Sheets vai funcionar.
- [ ] Login de farmacêutico e de admin funcionam.
- [ ] Kanban carrega os casos existentes (lendo do mesmo Firestore).
- [ ] Novo caso via ETL (`insertDB`, assinado HMAC) é aceito com o novo
      segredo.
- [ ] Upload de arquivo anexo (`uploadRaw`) grava na pasta Drive correta.
- [ ] Notificação de nova demanda espontânea chega por e-mail, remetente
      correto.
- [ ] Relatório diário de gatilhos (`enviarRelatorioDiarioGatilhos`)
      dispara no horário configurado.
- [ ] Investigação concluída notifica o notificador original.
- [ ] Exportação XML E2B(R3) gera arquivo idêntico ao gerado antes da
      migração (mesmo caso de teste, diff estrutural igual).
- [ ] Espelho de auditoria (`Mirror.gs`) grava linha nova na planilha
      pessoal, sem erro de lock/fila.
- [ ] Painel Admin: cadastro de usuário, setor e listas continuam
      funcionando.

---

## 6. Plano de rollback por fase

| Fase | Se algo der errado | Como reverter |
|---|---|---|
| 1–4 (projeto/URL de teste) | Nenhum impacto — ambiente paralelo | Excluir o projeto de teste, nada muda para os usuários |
| 5 (corte) | E-mails não saem / ETL falha / painel fora do ar | Reinstalar os 3 triggers na implantação institucional (ainda publicada), reverter `URL_SISTEMA` e a config do ETL para a URL antiga — restaura o serviço em minutos, pois nada foi apagado |
| 6 (desligamento) | Só executar depois de dias estáveis — praticamente sem necessidade de rollback | Reverter é reativar `clasp login` institucional e reabrir os triggers na implantação antiga, se ainda não arquivada definitivamente |

---

## 7. Decisões em aberto (só você pode definir)

1. O e-mail de coordenação (`EMAIL_COORDENACAO`, hoje configurável no
   painel Admin) também deve deixar de ser institucional, ou só a
   *hospedagem/infraestrutura* está migrando?
2. O repositório GitHub `giselecan/vigiram-gas` precisa mudar de
   organização/owner também, ou já está sob sua conta pessoal?
3. Alinhar com a coordenação do hospital (item 1.2) antes do corte —
   quem precisa ser avisado formalmente?
4. ✅ **Resolvido** — Volume diário real de e-mail (item 1.1): medido,
   bem abaixo de 100/dia.
5. ✅ **Resolvido** (Seção 2) — Envio de e-mail segue direto pela conta
   pessoal, sem alias e sem relay institucional.
