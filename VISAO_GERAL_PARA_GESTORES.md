# VigiRAM — Visão Geral do Sistema para Gestores

> Documento de apresentação institucional do VigiRAM: o que o sistema faz, por que existe,
> quem usa, e como está organizado. Escrito para leitura por gestores hospitalares,
> coordenação de farmácia clínica e demais partes interessadas — não exige conhecimento
> técnico prévio de programação.
>
> Última atualização deste documento: 27/08/2026.

---

## 1. O que é o VigiRAM

**VigiRAM** é o sistema de **farmacovigilância hospitalar** do **Hospital Regional Norte**
(CNES 6848710). Ele gerencia todo o ciclo de vida de uma notificação de **Reação Adversa a
Medicamento (RAM)**: desde a detecção do caso, passando pela avaliação clínica da farmácia,
até a exportação dos dados no formato exigido pela Anvisa para notificação oficial no
**VigiMed**.

Roda inteiramente na nuvem como um **Google Apps Script Web App** — não exige servidor
próprio, licença de banco de dados ou infraestrutura de TI dedicada. O hospital acessa por
um link, com login e senha próprios do sistema.

### 1.1 O problema que o sistema resolve

Antes do VigiRAM, a farmacovigilância dependia de:

- Um farmacêutico revisar prontuários **manualmente**, um a um, tentando identificar reações
  adversas a partir de medicamentos "sinalizadores" (antídotos, suspensões, trocas de dose).
- Notificações da equipe assistencial (enfermagem/medicina) chegando por canais informais
  (papel, verbal, e-mail avulso), sem rastreabilidade nem prazo de resposta.
- Nenhum controle estruturado de causalidade, gravidade, desfecho ou status do caso.
- Preenchimento manual e repetitivo do XML/formulário do VigiMed a cada caso confirmado.

O VigiRAM substitui esse processo manual por um **fluxo digital único**, auditável e com
indicadores de gestão.

### 1.2 Objetivos do sistema

1. **Detectar precocemente** possíveis reações adversas a medicamentos, via varredura
   automática de medicamentos-gatilho (ex.: antídotos, medicamentos de estreita margem
   terapêutica).
2. **Padronizar a investigação farmacêutica**, com avaliação clínica estruturada e cálculo
   objetivo de causalidade (Algoritmo de Naranjo).
3. **Dar voz à equipe assistencial**, permitindo notificação espontânea de qualquer evento
   suspeito, mesmo sem gatilho automático.
4. **Garantir rastreabilidade e auditoria completa** de cada caso (quem fez o quê, quando),
   como exige a LGPD e as boas práticas de farmacovigilância.
5. **Acelerar a exportação regulatória** para o VigiMed (Anvisa), reduzindo o tempo de
   digitação manual do farmacêutico.
6. **Oferecer indicadores de gestão** (dashboard) que sustentem decisões da farmácia clínica
   e da diretoria técnica sobre segurança do paciente.

---

## 2. Quem usa o sistema (perfis e público)

| Perfil | Como acessa | O que faz |
|---|---|---|
| **Equipe assistencial** (enfermagem, medicina, outros) | Formulário público, sem necessidade de login | Notifica espontaneamente um evento suspeito relacionado a medicamento. |
| **Farmacêutico clínico** | Login próprio no painel | Faz a triagem dos gatilhos, conduz a investigação clínica, aplica o Naranjo, registra desfecho, exporta o caso para o VigiMed. |
| **Administrador (perfil ADMIN)** | Login próprio, com permissões elevadas | Cadastra usuários e setores, configura listas/parâmetros do sistema, consulta logs de auditoria, dispara e-mails de teste. |
| **Robô de ETL** (automação PowerShell, fora do sistema) | Integração automática via API, sem interface | Varre o sistema hospitalar em busca de medicamentos-gatilho e envia os alertas ao VigiRAM automaticamente. |

Não existe "login com conta Google" — a autenticação é própria do sistema (e-mail e senha
cadastrados pelo administrador), o que permite controlar exatamente quem acessa dados de
pacientes, independentemente do provedor de e-mail de cada colaborador.

---

## 3. O fluxo de um caso, do início ao fim

Existem **duas portas de entrada** para um caso no VigiRAM:

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│   ROTA 1 — Busca Ativa (BA)  │        │  ROTA 2 — Notificação         │
│   Robô PowerShell detecta    │        │  Espontânea (DE)              │
│   medicamento-gatilho no     │        │  Assistência relata evento    │
│   prontuário e envia alerta  │        │  pelo Formulário Público      │
└──────────────┬────────────────┘       └───────────────┬────────────────┘
               │                                          │
               ▼                                          │
     1. TRIAGEM (só rota BA)                              │
     Farmacêutico avalia o alerta:                        │
     houve indício real de RAM?                           │
       │                    │                             │
       │ Não                │ Sim                         │
       ▼                    ▼                             ▼
  DESCARTADO      2. EM INVESTIGAÇÃO ◄──────────────────────
  (com motivo)       Farmacêutico preenche dados clínicos,
                      causalidade (Naranjo), conduta e desfecho
                             │
                             ▼
                   3. CONCLUÍDO
                   Caso travado para edição (auditoria íntegra)
                             │
                             ▼
              4. EXPORTAÇÃO E2B(R3) (se aplicável)
              Gera XML para importar manualmente no VigiMed (Anvisa)
                             │
                             ▼
              5. Registro do nº/data de importação VigiMed
```

**Detalhes importantes do fluxo:**

- Um caso **Busca Ativa** nasce como "PENDENTE TRIAGEM" e só avança para investigação
  depois que um farmacêutico confirma que há indício real de reação — evita investigar
  falsos positivos do robô.
- Um caso de **Notificação Espontânea** nasce direto em "EM INVESTIGAÇÃO" (a assistência já
  relatou um evento suspeito concreto, não precisa de triagem).
- Um caso **CONCLUÍDO** fica travado contra edição — só pode ser alterado se um
  farmacêutico usar a ação explícita "Reabrir investigação", o que fica registrado na
  auditoria. Isso protege a integridade de casos já reportados à Anvisa.
- O sistema evita duplicar um alerta do robô para o mesmo paciente/medicamento enquanto o
  caso anterior ainda estiver aberto; e trata como um episódio novo (reinternação) apenas se
  o gatilho disparar de novo mais de 15 dias após o caso anterior ter sido encerrado.

---

## 4. Funcionalidades por módulo

### 4.1 Ingestão automática de alertas (Busca Ativa / ETL)

- Recebe, via integração segura, a lista de casos suspeitos identificados por um robô
  PowerShell que varre o sistema hospitalar em busca de **medicamentos-gatilho**
  (ex.: vancomicina, digoxina, varfarina, insulina, heparina — lista configurável pelo
  administrador).
- Evita duplicidade: o mesmo alerta não gera dois casos para o mesmo paciente.
- Cada envio do robô é **assinado digitalmente** (o sistema verifica que a mensagem
  realmente veio do robô autorizado e não foi alterada no caminho).
- Também recebe cópias brutas dos relatórios de origem (para backup/auditoria), guardadas
  em pasta controlada do Google Drive.

### 4.2 Formulário público de notificação espontânea

- Formulário em 3 etapas (Paciente → Evento → Notificador) para a equipe assistencial
  relatar um evento suspeito, sem precisar de login.
- Envio protegido contra duplicidade caso a rede falhe no meio do envio (o farmacêutico não
  vê o mesmo relato duas vezes).
- Identifica automaticamente o farmacêutico responsável pelo setor informado, para
  direcionar o alerta por e-mail à pessoa certa.

### 4.3 Painel Kanban (triagem e acompanhamento)

- Quadro visual dos casos organizados por status: **Pendente Triagem → Em Investigação →
  Concluído / Descartado**.
- Filtros por setor, farmacêutico responsável e período.
- Atualização em tempo (quase) real entre os usuários conectados.
- Ação de triagem: farmacêutico decide, a partir do alerta bruto, se confirma o
  medicamento suspeito e avança para investigação, ou descarta (com motivo obrigatório —
  ex.: uso profilático/rotina, erro de prescrição, evolução da doença).

### 4.4 Investigação farmacêutica estruturada

Tela dedicada onde o farmacêutico registra, de forma padronizada:

- **Dados clínicos**: história clínica, relato do evento, exames complementares (inclusive
  uma subtabela de exames estruturados: nome, data, valor, unidade, referência).
- **Dados do medicamento**: dose, unidade, lote, laboratório/fabricante, via de
  administração, datas de início/fim da administração, forma farmacêutica, posologia
  (nº de doses no intervalo + unidade), indicação de uso, ação adotada com o medicamento
  (retirada, redução de dose etc.), reexposição (rechallenge) e resultado.
- **Causalidade — Algoritmo de Naranjo**: questionário padronizado de 10 perguntas
  (Sim/Não/Não sei), cada uma com peso, que calcula automaticamente a categoria de
  causalidade do caso: **Definida, Provável, Possível ou Duvidosa**.
- **Gravidade e desfecho**: classificação de gravidade (Leve/Moderada/Grave/Fatal) e
  desfecho clínico (recuperado, alta, transferência, óbito etc.), com campos condicionais
  (ex.: data do óbito só aparece se o desfecho for óbito).
- **Dados adicionais relevantes**: peso/altura do paciente, relação medicamento×evento
  (suspeito/concomitante/interagente), problemas adicionais do medicamento (uso off-label,
  erro de medicação, superdosagem etc.), e campos específicos de saúde da mulher (DUM,
  gestante, lactante) quando aplicável.
- **Conclusão do caso**: classificação final (Confirmado / Não relacionado ao medicamento
  / Provável) e conduta/evolução após as intervenções.
- **Controle de concorrência**: se dois farmacêuticos abrirem o mesmo caso ao mesmo tempo, o
  sistema impede que um salvamento sobrescreva silenciosamente o trabalho do outro.
- **Reabertura controlada**: casos concluídos só voltam a ser editáveis por uma ação
  explícita de reabertura, sempre registrada em auditoria.

### 4.5 Dashboard analítico (indicadores de gestão)

Organizado em 4 blocos temáticos, com filtros por setor, farmacêutico responsável e
período:

1. **Visão Geral** — volume de gatilhos (Busca Ativa) vs. notificações espontâneas,
   quantos foram investigados/descartados/pendentes, pendências de importação no VigiMed.
2. **Análise Clínica e Tendência** — RAM confirmada x descartada, distribuição por
   gravidade, evolução temporal dos casos.
3. **Mapa de Risco** — gravidade por setor, ranking de medicamentos mais associados a
   reações.
4. **Desempenho Operacional (SLA)** — tempo médio de triagem, percentual de casos com
   triagem atrasada em relação ao prazo padrão configurável, ranking por setor e por
   farmacêutico.

### 4.6 Exportação regulatória — XML ICH E2B(R3) para o VigiMed

- Gera o arquivo XML no padrão internacional **ICH E2B(R3)**, aceito pelo módulo VigiMed
  da Anvisa, evitando redigitação manual de boa parte dos dados do caso.
- Validado estruturalmente contra o ambiente de teste oficial da Anvisa.
- **Limitações conhecidas e assumidas** (documentadas com transparência para a gestão,
  não escondidas):
  - Sem uma licença ativa do dicionário médico **MedDRA**, a reação sai sem código
    padronizado, o que **hoje sempre exige correção manual** de um campo no VigiMed —
    ainda assim, o restante do caso (histórico, exames, medicamento, narrativa) já chega
    pronto, reduzindo o tempo de digitação de ~15 minutos para ~30 segundos por caso.
  - Gera apenas a notificação **inicial** — atualizações posteriores (follow-up) ainda são
    feitas manualmente direto no VigiMed.
  - Hoje trata 1 reação e 1 medicamento por caso (não múltiplos itens repetíveis).
  - Existe um roadmap técnico detalhado (`roadmap_melhoria_xml_e2b.md`) com o plano de
    evolução faseado, incluindo a decisão estratégica pendente sobre licenciar o MedDRA
    (dicionário médico) e o WHODrug (dicionário de medicamentos), que são os principais
    gargalos para chegar à automação completa.

### 4.7 Notificações automáticas por e-mail

- **Relatório diário (07h)**: agrega, por farmacêutico responsável, todos os gatilhos ainda
  aguardando triagem nos setores sob sua responsabilidade — substitui múltiplos alertas
  avulsos por um único e-mail diário e organizado.
- **Alerta imediato de nova notificação espontânea**: avisa o farmacêutico do setor assim
  que a assistência relata um evento pelo formulário público.
- **Alerta de investigação concluída**: avisa quem fez a notificação espontânea original
  que o caso foi encerrado, incentivando a cultura de notificação contínua.
- Envios processados em fila (não travam a experiência do usuário) e com identidade visual
  própria do sistema.

### 4.8 Administração do sistema

- **Gestão de usuários**: criação, edição, troca de senha, ativação/desativação, atribuição
  de setores e definição de perfil (Farmacêutico/Admin) — restrita a administradores.
- **Gestão de setores**: cadastro de setores do hospital e farmacêutico(s) responsável(is)
  por cada um, usado tanto para o direcionamento de e-mails quanto para os filtros do
  Kanban/Dashboard.
- **Listas e parâmetros configuráveis** sem precisar alterar código: opções de dropdowns
  (gravidade, desfecho, conclusão, motivo de descarte etc.), lista de medicamentos-gatilho,
  parâmetros gerais (SLA padrão em horas, e-mail de coordenação, liga/desliga de alertas,
  URL do sistema).
- **Algoritmo de Naranjo configurável**: perguntas e pesos podem ser ajustados pelo painel
  administrativo, se necessário.
- **Logs e trilha de auditoria**: tela dedicada para consultar todas as ações relevantes do
  sistema (quem fez o quê, quando, em qual caso).
- **E-mail de teste**: administrador pode disparar um exemplo de cada tipo de e-mail
  automático para conferir o layout antes de confiar no envio real.

### 4.9 Segurança e conformidade (LGPD)

- **Autenticação própria** com senha protegida por hash criptográfico (SHA-256 com sal),
  nunca armazenada nem trafegada em texto puro; sessões expiram automaticamente.
- **Perfis de acesso**: ações administrativas exigem confirmação de perfil ADMIN no
  próprio servidor (não apenas escondidas na tela).
- **Autenticação forte da integração com o robô** (HMAC-SHA256 com janela anti-repetição),
  impedindo que terceiros insiram dados falsos no sistema.
- **Funções administrativas de alto risco** (definir segredo de integração, apagar casos em
  massa, resetar base) propositalmente não ficam acessíveis pela tela — só um desenvolvedor
  autorizado pode executá-las manualmente, como camada extra de proteção.
- **Dados pessoais do notificador** (nome, categoria profissional, e-mail) ficam isolados em
  campos próprios — separados do texto livre — permitindo eliminação seletiva quando
  necessário, conforme exigido pela LGPD.
- **Toda gravação relevante é carimbada** com autor e data/hora, e casos concluídos ficam
  registrados de forma permanente (append-only) numa planilha de auditoria — nenhuma rotina
  do sistema sobrescreve ou apaga esse histórico.

---

## 5. Arquitetura em linguagem simples

```
Robô (PowerShell)  →  VigiRAM (nuvem, Google Apps Script)  →  Banco de dados (Firestore)
                              │                                        │
                              ▼                                        ▼
                    Painel Kanban / Dashboard              Cópia de auditoria (Google Sheets,
                    Formulário público                      só gravação, nunca sobrescrita)
                              │
                              ▼
                    XML E2B(R3)  →  Importação manual no VigiMed (Anvisa)
```

- **Banco de dados principal**: Cloud Firestore — fonte única de verdade para casos,
  configuração, usuários e gatilhos.
- **Backup/auditoria**: Google Sheets, usado apenas como livro-razão de só-gravação (não é
  mais lido pelo sistema para decidir nada — evita o risco de alguém editar uma célula na
  planilha e "quebrar" o sistema).
- **Interface**: páginas web servidas pelo próprio Google Apps Script, com visual próprio
  (Tailwind CSS) e ícones (Font Awesome) — não depende de nenhuma conta Google do usuário
  final para funcionar.
- **Sem servidor próprio**: não há custo de hospedagem, servidor ou banco de dados
  tradicional — tudo roda na infraestrutura do Google, dentro da conta institucional.

---

## 6. Limitações conhecidas e próximos passos (roadmap)

Documentadas de forma transparente para apoiar decisões de investimento futuro:

| Tema | Situação atual | Ganho esperado ao evoluir |
|---|---|---|
| Codificação de reação (MedDRA) | Sem licença ativa; reação sai sem código, força correção manual pontual no VigiMed | Eliminaria a última correção manual obrigatória por caso |
| Codificação de medicamento (WHODrug) | Não implementado | Exigido quando a norma da Anvisa (RDC 967/2025) entrar em vigor |
| Múltiplos medicamentos/reações por caso | Hoje só 1 de cada | Necessário para casos de interação medicamentosa (2+ medicamentos) |
| Acompanhamento (follow-up) no VigiMed | Só notificação inicial automática | Reduziria também o trabalho manual de atualizações pós-envio |
| Naranjo no XML exportado | Implementado, ainda em fase de confirmação com testes reais no VigiMed | Validação final decide se muda o próximo passo do roadmap |

O roadmap técnico completo, com plano por fase e evidências normativas, está em
[`roadmap_melhoria_xml_e2b.md`](./roadmap_melhoria_xml_e2b.md).

---

## 7. Referência técnica rápida (para quem for aprofundar)

| Arquivo/Módulo | Função de negócio |
|---|---|
| `Router.gs` | Porta de entrada de todas as requisições web. |
| `Security.gs` | Segurança de borda: autenticação do robô, controle de pastas do Drive. |
| `Auth.gs` / `Admin.gs` | Login, sessão, gestão de usuários e perfis. |
| `Cases.gs` | Regras de negócio de cada caso (triagem, investigação, conclusão). |
| `Config.gs` / `Config write.gs` | Parâmetros e listas configuráveis do sistema. |
| `Ingest.gs` | Recebimento dos alertas do robô de Busca Ativa. |
| `Notify.gs` | Disparo de e-mails automáticos. |
| `Firestore.gs` / `Mirror.gs` | Banco de dados principal e cópia de auditoria. |
| `Audit.gs` | Identidade do usuário para carimbo de auditoria. |
| `Schema.gs` | Definição central de campos, status e listas do sistema. |
| `E2b.gs` | Geração do XML regulatório para o VigiMed. |
| `index.html` + `js_*.html` | Painel (Kanban, Dashboard, Investigação, Administração). |
| `form.html` | Formulário público de notificação espontânea. |

Documentação técnica complementar já existente no repositório:

- [`README.md`](./README.md) — arquitetura técnica detalhada, configuração e deploy.
- [`roadmap_melhoria_xml_e2b.md`](./roadmap_melhoria_xml_e2b.md) — roadmap da exportação
  regulatória.
- [`auditoria_qa_datas_tipagem_2026-07-13.md`](./auditoria_qa_datas_tipagem_2026-07-13.md) —
  histórico de auditoria de qualidade do projeto.

---

## 8. Resumo executivo (uma tela)

- **O quê**: sistema único para gerenciar todo o ciclo de notificação de reações adversas a
  medicamentos no hospital, da detecção à exportação regulatória.
- **Por quê**: substitui um processo manual, lento e sem rastreabilidade, por um fluxo
  digital padronizado, auditável e com indicadores de gestão.
- **Para quem**: farmácia clínica (uso principal), equipe assistencial (notificação),
  administração hospitalar (gestão de acesso e configuração).
- **Como**: Google Apps Script + banco de dados Firestore, sem custo de infraestrutura
  própria, com segurança de acesso e trilha de auditoria compatível com a LGPD.
- **Onde falta evoluir**: licenciamento de dicionários médicos (MedDRA/WHODrug) é o principal
  gargalo restante para automação regulatória completa — decisão de investimento, não de
  desenvolvimento.
