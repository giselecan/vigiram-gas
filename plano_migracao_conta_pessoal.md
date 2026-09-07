# Plano de Migração — Conta Institucional → Conta Pessoal

> Escopo: migrar a **hospedagem/propriedade** de toda a infraestrutura do
> VigiRAM (Apps Script, Drive/Sheets, projeto Google Cloud do Firestore,
> envio de e-mail, repositório) da conta institucional (`@isgh.org.br`)
> para a conta pessoal `giselechereese@gmail.com`, com o sistema em
> **produção** e sem perda de dados/histórico de auditoria.
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
(`Firestore.gs`). Trocar o "dono" do sistema **não exige mexer nos dados
do Firestore** — só na propriedade do projeto Google Cloud onde ele vive
(ver Fase 2).

O Google também **restringe transferência de propriedade de arquivos do
Drive/Apps Script para fora do domínio Workspace** (não existe um
"transferir dono" direto de `@isgh.org.br` para uma conta pessoal
`@gmail.com` na maioria das configurações). Por isso o plano abaixo usa
duas estratégias diferentes por tipo de recurso:

| Recurso | Estratégia | Por quê |
|---|---|---|
| Projeto Google Cloud (Firestore) | **Transferência de propriedade (IAM)** — mesmo projeto, mesmos dados | GCP permite adicionar qualquer conta Google como "Owner" via IAM, mesmo fora do domínio. Não precisa exportar/importar dados. |
| Projeto Apps Script | **Recriação sob a conta pessoal** (`clasp clone`/`push`), rodando em paralelo até o corte | Apps Script/Drive normalmente não permite mudar o dono para fora do domínio Workspace. |
| Planilha-espelho de auditoria (Sheets) | **Nova planilha na conta pessoal a partir da data de corte**; a antiga fica congelada como arquivo histórico | Mesma restrição de domínio. Um espelho *append-only* pode perfeitamente "trocar de arquivo" numa data — desde que ambos fiquem preservados e rastreáveis. |
| Repositório GitHub | Depende de quem é hoje o *owner*/organização do repo | Ver Fase 1. |

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
de casos). Se estiver perto do limite, considere manter o envio de e-mail
na conta institucional (ou usar uma conta Workspace paga) mesmo depois de
migrar o resto.

### 1.2 Dado de saúde (LGPD) — governança, não só técnica
O VigiRAM processa dados de **farmacovigilância com dados pessoais/dados
sensíveis de pacientes** (RAM, prontuário, desfecho clínico). Mesmo que
apenas a *propriedade administrativa* da infraestrutura mude (e os dados
continuem os mesmos, no mesmo Firestore), isso muda quem tecnicamente
tem acesso root às credenciais e ao Drive de auditoria. Isso pode ter
implicação contratual/institucional além do técnico.
→ **Recomendação:** antes do corte final (Fase 6), alinhar formalmente
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

### 1.4 URL da implantação muda
Uma nova implantação (deploy) sob a conta pessoal gera uma **nova URL**
(`.../macros/s/{deploymentId}/exec`). Isso afeta:
- O robô ETL PowerShell (precisa apontar para a nova URL).
- `URL_SISTEMA` em `Config.gs`/painel Admin (usada nos links dos e-mails).
- Favoritos/atalhos que a equipe de farmácia já usa no navegador.

---

## 2. Pré-requisitos (Fase 0 — preparação, sem impacto em produção)

1. **Backup completo do código-fonte:** rodar
   `exportarProjetoCompletoParaMD()` (`EXPORT COD.gs`) e guardar o `.md`
   fora do Drive institucional (ex.: local + repositório). Além disso
   `git push` deste repositório já garante versão do código.
2. **Checar `VIGIRAM_OWNER_EMAIL`** e `VIGIRAM_AUTHORIZED_SCRIPT_ID` nas
   Script Properties do projeto ao vivo (item 1.3).
3. **Levantar todas as Script Properties atuais** (`FIRESTORE_*`,
   `ETL_SECRET`, `ETL_FOLDER_IDS`, `VIGIRAM_*`) e guardar os valores em um
   cofre de senhas pessoal (nunca em arquivo de texto solto).
4. **Confirmar quem é o Owner atual** do projeto Google Cloud do Firestore
   (Console GCP → IAM) e se você já tem permissão de "Owner" ou
   "Resource Manager Admin" para adicionar a si mesmo.
5. **Confirmar o dono do repositório GitHub** `giselecan/vigiram-gas` —
   se está sob organização institucional, avaliar se também precisa
   migrar para conta/organização pessoal (fora do escopo técnico deste
   plano, é uma decisão de governança à parte).
6. **Estimar volume diário de e-mail** (item 1.1).
7. **Definir uma janela de baixo uso** para o corte final (Fase 6) — por
   exemplo, fim de semana ou fora do horário de triagem, mesmo a migração
   sendo desenhada para near-zero-downtime.

---

## 3. Fases da migração

### Fase 1 — Projeto Google Cloud / Firestore (baixo risco)
1. No Console GCP, abrir o projeto associado a `FIRESTORE_PROJECT_ID`.
2. IAM → **Adicionar** `giselechereese@gmail.com` como **Owner**.
3. Validar o acesso logando no Console GCP com a conta pessoal.
4. **Não mexer ainda** nas credenciais de Service Account usadas pelo
   `Firestore.gs` — elas continuam funcionando iguais, independente de
   quem é o Owner humano do projeto.
5. Só depois de o resto da migração estar validado (Fase 5+), remover o
   Owner institucional (Fase 7).

*Risco: baixo — não toca em dados, é só uma mudança de permissão IAM.*

### Fase 2 — Novo projeto Apps Script (paralelo, sem afetar produção)
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

### Fase 3 — Implantação de teste (paralela)
1. No novo projeto, publicar uma implantação Web App
   (`executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`, igual ao
   atual) — vai gerar uma **URL de teste** própria.
2. Rodar `Diagnostico.gs → diagnosticarAdmin()` para conferir leitura do
   Firestore sem alterar nada.
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

### Fase 4 — Planilha-espelho e pasta de auditoria
1. Criar uma nova planilha (Sheets) de auditoria, sob a conta pessoal,
   com a mesma estrutura de colunas da atual (`Mirror.gs` documenta o
   formato).
2. Não copiar o histórico linha a linha (evita duplicar/errar hashes de
   auditoria) — em vez disso, **arquivar** a planilha institucional como
   somente-leitura na data do corte e começar o espelho novo do zero a
   partir dali. Documentar essa transição (data + link da planilha antiga)
   no topo da planilha nova, para manter rastreabilidade LGPD.
3. Mesma lógica para a pasta do Drive usada pelo `Ingest.gs`
   (`ETL_FOLDER_IDS`) — criar pasta nova sob a conta pessoal e atualizar
   a Script Property no novo projeto.

*Risco: baixo — não altera nada em produção; só prepara o destino.*

### Fase 5 — Ajustes de código (branch dedicada, revisão antes de subir)
Mudanças pequenas e não-destrutivas:
1. `Security.gs:157-166` — opcional: manter os dois e-mails na lista
   padrão por segurança (não remover o institucional do array até a
   Fase 7 estar validada — assim, se algo der errado, o deploy
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

*Risco: baixo — mudanças pequenas, revisáveis em PR antes de ir para o ar.*

### Fase 6 — Corte (cutover) — na janela de baixo uso definida na Fase 0
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
   o **novo `ETL_SECRET`** gerado na Fase 2.5.
7. Comunicar a equipe de farmácia clínica sobre a nova URL (atualizar
   favoritos/atalhos).
8. Rodar o checklist de fumaça completo (Seção 4 abaixo) na URL nova,
   agora com dados reais.
9. Manter a implantação institucional **publicada, mas sem triggers**,
   por alguns dias como plano B (ver Fase 7).

### Fase 7 — Estabilização e desligamento do acesso institucional
1. Observar por 3–7 dias: e-mails chegando, ETL inserindo casos,
   espelho de auditoria gravando, XML E2B gerando corretamente.
2. Só depois desse período: remover o `giselechereese@gmail.com` da
   lista institucional (Fase 1) se aplicável, revogar `clasp login`
   institucional, e — o passo mais delicado — **arquivar (não excluir)**
   a implantação/projeto Apps Script institucional (mantém histórico e
   serve de restauração de emergência).
3. Nunca excluir a planilha de auditoria antiga nem o projeto Apps
   Script antigo — são registro histórico/LGPD.

---

## 4. Checklist de testes de fumaça (rodar na Fase 3 e de novo na Fase 6)

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

## 5. Plano de rollback por fase

| Fase | Se algo der errado | Como reverter |
|---|---|---|
| 1 (GCP IAM) | Nenhum impacto em produção | Remover a permissão IAM adicionada |
| 2–5 (projeto/URL de teste) | Nenhum impacto — ambiente paralelo | Excluir o projeto de teste, nada muda para os usuários |
| 6 (corte) | E-mails não saem / ETL falha / painel fora do ar | Reinstalar os 3 triggers na implantação institucional (ainda publicada), reverter `URL_SISTEMA` e a config do ETL para a URL antiga — restaura o serviço em minutos, pois nada foi apagado |
| 7 (desligamento) | Só executar depois de dias estáveis — praticamente sem necessidade de rollback | Reverter é reativar acessos institucionais, se ainda não revogados definitivamente |

---

## 6. Decisões em aberto (só você pode definir)

1. O e-mail de coordenação (`EMAIL_COORDENACAO`, hoje configurável no
   painel Admin) também deve deixar de ser institucional, ou só a
   *hospedagem/infraestrutura* está migrando?
2. O repositório GitHub `giselecan/vigiram-gas` precisa mudar de
   organização/owner também, ou já está sob sua conta pessoal?
3. Alinhar com a coordenação do hospital (item 1.2) antes do corte —
   quem precisa ser avisado formalmente?
4. Volume diário real de e-mail (item 1.1) — vale a pena medir antes de
   decidir se o envio também migra para a conta pessoal ou fica
   separado.
