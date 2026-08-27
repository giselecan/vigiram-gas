# VigiRAM — Funcionalidades, Pontos Fortes e Desafios

> Documento em linguagem simples, sem termos técnicos de informática, para apresentar o
> VigiRAM a gestores e demais interessados que não precisam (nem devem precisar) entender
> como o sistema foi construído por dentro. O foco aqui é só um: **o que o sistema faz, que
> problema resolve, quais são seus pontos fortes e quais desafios ainda existem.**
>
> Última atualização: 27/08/2026.

---

## 1. Em uma frase

O VigiRAM é o sistema que ajuda a farmácia clínica do hospital a **encontrar, avaliar,
documentar e notificar** possíveis reações adversas a medicamentos — do primeiro sinal de
alerta até o envio do caso para a Anvisa.

---

## 2. O problema que existia antes do sistema

Antes do VigiRAM, identificar uma reação adversa a medicamento dependia quase inteiramente
de pessoas:

- Um farmacêutico precisava **lembrar de revisar** os prontuários dos pacientes que
  usaram certos medicamentos de risco, um a um, sem nenhuma lista automática de quem
  precisava ser olhado.
- Quando a enfermagem ou a equipe médica percebia algo estranho num paciente, o relato
  acontecia de forma **informal** — um comentário verbal, um bilhete, uma mensagem avulsa —
  fácil de se perder ou de nunca chegar a quem deveria avaliar.
- Não existia um critério único para decidir **se aquilo era mesmo culpa do medicamento**:
  cada profissional julgava "no olho", com base na própria experiência.
- Não havia um número, gráfico ou relatório que mostrasse à gestão **quantos casos existiam,
  quão graves eram, ou quanto tempo a farmácia levava para responder**.
- Notificar a Anvisa, quando o caso merecia, significava **digitar tudo de novo** em outro
  sistema — repetindo dados que já tinham sido levantados durante a investigação.

Esses pontos custam tempo da equipe, atrasam decisões clínicas e — o mais importante —
aumentam a chance de uma reação adversa real passar despercebida.

---

## 3. Como o sistema funciona no dia a dia (sem termos técnicos)

Pensando na rotina real da farmácia e da assistência, o VigiRAM entra em ação de duas
formas:

**Pela detecção automática.** Sempre que um paciente recebe um medicamento que costuma
estar associado a reações adversas (por exemplo, um antibiótico que exige controle rígido de
dose, um anticoagulante, uma insulina), o sistema já sinaliza esse caso como algo que merece
uma olhada. O farmacêutico não precisa procurar — o caso já está esperando na tela dele.

**Pela notificação da própria equipe assistencial.** Se um enfermeiro ou médico percebe algo
suspeito num paciente — mesmo sem nenhum alerta automático ter disparado — ele mesmo pode
relatar o caso por um formulário simples, sem precisar de senha ou treinamento prévio. O
relato chega automaticamente para o farmacêutico responsável pelo setor.

A partir daí, o farmacêutico:

1. **Confirma se o caso merece investigação** (ou descarta, registrando o motivo).
2. **Investiga**: reúne o histórico clínico, os dados do medicamento, os exames, e aplica
   um questionário padronizado que ajuda a decidir o quanto é provável que o medicamento
   tenha causado aquela reação.
3. **Conclui o caso**, registrando a gravidade e o desfecho (o paciente recuperou-se? foi
   preciso internar? houve óbito?).
4. **Se necessário, gera o material para notificar a Anvisa**, aproveitando boa parte dos
   dados que já foram levantados na investigação.

Tudo isso fica visível, em tempo real, num painel único — sem planilhas paralelas, e-mails
perdidos ou anotações em papel.

---

## 4. Funcionalidades detalhadas

### 4.1 Detecção automática de casos suspeitos

O sistema recebe, de forma automática, uma lista de pacientes que usaram medicamentos
considerados "de atenção" — aqueles com histórico de causar reações adversas ou que exigem
controle rigoroso de dose (por exemplo: vancomicina, gentamicina, digoxina, varfarina,
insulina, heparina, amiodarona). Essa lista de medicamentos monitorados é **configurável**:
pode ser ajustada pela farmácia conforme a experiência do hospital, sem precisar de nenhuma
alteração no sistema em si.

Cada caso detectado entra automaticamente na fila de triagem, pronto para ser avaliado pelo
farmacêutico — ninguém precisa caçar essa informação manualmente.

### 4.2 Canal de notificação espontânea

Um formulário simples, dividido em três passos curtos (dados do paciente → o que aconteceu →
quem está notificando), permite que qualquer pessoa da equipe assistencial relate uma
suspeita de reação, mesmo sem acesso ao sistema principal. Não é preciso login, senha nem
treinamento — só preencher e enviar.

Assim que o relato é enviado, o sistema:

- Identifica automaticamente **qual farmacêutico é responsável** pelo setor daquele
  paciente.
- Avisa essa pessoa por e-mail, sem que o notificador precise fazer mais nada.
- Garante que o mesmo relato não seja enviado em duplicidade, mesmo que a internet falhe no
  meio do envio e a pessoa tente de novo.

### 4.3 Painel de acompanhamento de casos

Todos os casos — vindos da detecção automática ou da notificação espontânea — aparecem
organizados visualmente em um painel único, por etapa:

- **Aguardando avaliação** (farmacêutico ainda não confirmou se é um caso real).
- **Em investigação** (farmacêutico já confirmou e está reunindo os dados clínicos).
- **Concluído** (investigação encerrada, com resultado registrado).
- **Descartado** (avaliado e considerado que não houve, de fato, reação ao medicamento).

É possível filtrar por setor, por farmacêutico responsável e por período, o que ajuda tanto
o dia a dia da equipe quanto uma eventual auditoria ou reunião de gestão.

### 4.4 Triagem farmacêutica

Antes de investigar a fundo, o farmacêutico faz uma primeira leitura rápida do alerta:
confirma o medicamento suspeito e decide se o caso realmente merece investigação, ou se deve
ser descartado. Ao descartar, é obrigatório registrar o motivo (por exemplo: uso profilático
de rotina, erro de prescrição sem relação com o paciente, evolução natural da doença) — isso
evita descartes "no chute" e mantém um histórico de por que cada caso não seguiu adiante.

### 4.5 Investigação clínica completa

Essa é a etapa mais rica do sistema. Uma tela dedicada guia o farmacêutico por tudo o que
precisa ser registrado sobre o caso, incluindo:

- **História clínica** do paciente e relato detalhado do evento.
- **Dados do medicamento**: dose, unidade, lote, fabricante, via de administração, datas de
  início e fim do uso, forma farmacêutica, frequência de uso, indicação para a qual o
  medicamento foi prescrito, e qualquer providência tomada (por exemplo, retirada do
  medicamento ou redução de dose).
- **Exames complementares**, inclusive de forma estruturada (nome do exame, data, valor
  encontrado, unidade de medida e faixa de referência), quando aplicável.
- **Reexposição**: se o medicamento foi usado novamente depois da reação, e se os sintomas
  voltaram — informação importante para reforçar (ou descartar) a suspeita.
- **Peso e altura do paciente**, quando relevantes para avaliar se a dose usada era
  adequada.
- **Situações específicas**, como data do óbito (só aparece se o desfecho registrado for
  óbito) ou informações de gestação/amamentação, quando pertinente.
- **Evolução e conduta** adotada depois de identificado o problema.

Nada precisa ser lembrado de cabeça: a tela apresenta os campos certos, na ordem certa, e só
mostra os campos condicionais quando fazem sentido para aquele caso específico.

### 4.6 Avaliação objetiva da causalidade (o "Algoritmo de Naranjo")

Um dos pontos mais importantes do sistema: em vez de decidir "por impressão" se o
medicamento causou a reação, o farmacêutico responde a um questionário clínico padronizado,
reconhecido internacionalmente, com 10 perguntas simples — por exemplo:

- *A reação apareceu depois do uso do medicamento?*
- *Os sintomas melhoraram quando o medicamento foi suspenso?*
- *Os sintomas voltaram quando o medicamento foi usado de novo?*
- *Existem outras causas que explicariam a reação, além do medicamento?*

Cada resposta (Sim / Não / Não sei) tem um peso, e o sistema soma tudo automaticamente,
classificando o caso em uma de quatro categorias: **Definida, Provável, Possível ou
Duvidosa**. Isso tira a decisão do campo da opinião pessoal e coloca em um critério comum,
usado por qualquer farmacêutico que avalie o caso — o que também torna o processo mais justo
e mais fácil de explicar, se questionado depois.

### 4.7 Classificação de gravidade e desfecho

O farmacêutico registra a gravidade do caso (Leve, Moderada, Grave ou Fatal) e o desfecho
clínico (paciente recuperado, alta, transferência interna ou externa, internação
prolongada, óbito). Essas informações alimentam diretamente os indicadores de gestão e
também o material de notificação à Anvisa, quando aplicável.

### 4.8 Indicadores de gestão (painel de números e gráficos)

Um painel próprio, dedicado à gestão, mostra o panorama completo do programa de
farmacovigilância do hospital, organizado em quatro blocos:

1. **Visão geral**: quantos casos vieram de detecção automática, quantos de notificação
   espontânea, quantos já foram investigados, quantos ainda estão pendentes, e quantos casos
   concluídos ainda aguardam ser importados no VigiMed.
2. **Análise clínica e tendência**: quantos casos foram, de fato, confirmados como reação ao
   medicamento; distribuição por gravidade; e como esse volume evolui ao longo do tempo.
3. **Mapa de risco**: quais setores concentram os casos mais graves, e quais medicamentos
   aparecem com mais frequência associados a reações — informação valiosa para prevenção.
4. **Desempenho da equipe**: tempo médio que a farmácia leva para fazer a triagem de um
   alerta, quantos casos ultrapassam o prazo esperado, e um ranking por setor e por
   farmacêutico responsável.

Tudo isso pode ser filtrado por setor, farmacêutico e período — permitindo tanto uma visão
ampla do hospital quanto um recorte específico para uma reunião de setor.

### 4.9 Geração do documento de notificação à Anvisa (VigiMed)

Quando um caso investigado precisa ser formalmente notificado à Anvisa, o sistema gera boa
parte do arquivo exigido pelo módulo **VigiMed**, reaproveitando os dados que já foram
levantados durante a investigação — o farmacêutico não precisa digitar o caso inteiro de
novo em outro lugar. Isso reduz bastante o tempo gasto nessa etapa, que hoje é uma das mais
demoradas do processo manual tradicional.

### 4.10 Alertas automáticos por e-mail

O sistema avisa automaticamente as pessoas certas, no momento certo:

- Um **resumo diário** para cada farmacêutico, reunindo todos os alertas do seu setor que
  ainda aguardam avaliação — em vez de um e-mail avulso a cada alerta, a pessoa recebe um
  único resumo organizado por manhã.
- Um **aviso imediato** quando a equipe assistencial registra uma nova notificação
  espontânea, para que a investigação comece o quanto antes.
- Um **aviso de agradecimento** para quem fez a notificação original, quando o caso é
  concluído — reforçando a cultura de notificar sempre que houver suspeita.

Assim, ninguém precisa ficar checando o sistema o tempo todo esperando por novidades.

### 4.11 Administração e controle de acesso

Uma área dedicada, disponível apenas para administradores, permite:

- Cadastrar, editar, ativar/desativar e trocar a senha dos usuários do sistema.
- Definir quais setores cada farmacêutico é responsável, o que já direciona
  automaticamente os alertas por e-mail e os filtros do painel.
- Ajustar listas e parâmetros do sistema sem depender de nenhuma alteração técnica — por
  exemplo, as opções de gravidade, desfecho, motivo de descarte, ou a própria lista de
  medicamentos monitorados.
- Consultar um histórico completo de ações realizadas no sistema (quem fez o quê e quando),
  útil tanto para auditoria interna quanto para investigar qualquer dúvida sobre um caso.
- Enviar e-mails de teste, para conferir como cada alerta automático aparece na caixa de
  entrada antes de confiar nele em produção.

### 4.12 Privacidade e proteção dos dados dos pacientes e notificadores

Sem entrar em detalhes técnicos, vale destacar como princípio de gestão:

- Cada pessoa só acessa o sistema com login e senha próprios, protegidos de forma que nem
  mesmo um administrador consegue "ver" a senha de outra pessoa.
- As informações pessoais de quem notifica um caso (nome, categoria profissional, e-mail)
  ficam guardadas separadamente dos dados clínicos, o que permite tratá-las com o cuidado
  extra que a LGPD exige.
- Toda ação relevante fica registrada com autor e data/hora — não existe alteração "anônima"
  no sistema.
- Um caso já concluído fica protegido contra edição acidental: só pode voltar a ser alterado
  por uma ação explícita de reabertura, que também fica registrada.

---

## 5. Pontos fortes do sistema

- **Nada se perde por esquecimento.** Uma vez que um caso entra no sistema — seja por
  detecção automática, seja por notificação da equipe — ele fica visível até ser encerrado.
  Não depende mais da memória de uma pessoa.
- **Decisão clínica mais justa e consistente.** O uso de um questionário padronizado para
  avaliar causalidade tira a subjetividade da decisão e torna o critério igual para todos os
  farmacêuticos, em qualquer plantão.
- **Toda a equipe participa da vigilância, não só a farmácia.** Enfermagem e medicina têm um
  canal direto e simples para notificar, o que amplia a capacidade de detecção do hospital
  muito além do que o robô de busca automática conseguiria sozinho.
- **Tempo de resposta visível e mensurável.** A gestão passa a enxergar, com dados reais,
  quanto tempo a farmácia leva para responder a um alerta — informação essencial para
  planejar equipe e prioridades.
- **Notificação à Anvisa muito mais rápida.** O trabalho de preencher o caso na investigação
  já alimenta boa parte do que a Anvisa pede, evitando repetir a digitação de dados que o
  sistema já tem.
- **Histórico protegido.** Um caso concluído (principalmente se já foi enviado à Anvisa) não
  corre o risco de ser alterado por engano — qualquer mudança exige uma ação deliberada e
  fica registrada.
- **Visão de gestão, não só de operação.** Não é apenas uma ferramenta para o farmacêutico
  do dia a dia — é também um painel de indicadores que apoia decisões da coordenação e da
  diretoria técnica sobre segurança do paciente.

---

## 6. Soluções entregues (o problema e o que o sistema resolveu)

| Problema antes do sistema | Solução entregue pelo VigiRAM |
|---|---|
| Revisão manual de prontuário, sem lista de quem observar | Detecção automática dos pacientes que usaram medicamentos de risco |
| Relatos informais da equipe, fáceis de perder | Formulário único, direto para o farmacêutico responsável |
| Julgamento "no olho" sobre causalidade | Questionário clínico padronizado, com resultado objetivo |
| Nenhum indicador consolidado para a gestão | Painel com números, gravidade, tempo de resposta e ranking por setor |
| Notificação à Anvisa exigia redigitar tudo | Boa parte do arquivo é gerada a partir do que já foi investigado |
| Sem trilha clara de quem fez o quê | Toda ação relevante registrada com autor, data e hora |
| Caso concluído podia ser alterado por engano | Trava de edição após conclusão, só reaberta por ação deliberada |

---

## 7. Desafios atuais (com honestidade)

Nenhum sistema resolve tudo sozinho, e é importante que a gestão conheça os limites atuais
para decidir os próximos investimentos com clareza:

- **O julgamento clínico continua — e deve continuar — sendo humano.** O sistema organiza,
  padroniza e apoia a decisão, mas quem confirma se de fato houve reação, e o quão grave ela
  foi, é sempre o farmacêutico responsável. Isso é intencional: é uma ferramenta de apoio,
  não um substituto do profissional.
- **Falta um dicionário médico com licença própria.** Existe um vocabulário técnico
  internacional (sujeito a uma licença paga) que permitiria classificar a reação com um
  código padronizado dentro do documento enviado à Anvisa. Sem essa licença, esse único
  campo específico ainda precisa de um ajuste manual no VigiMed — mesmo com todo o resto do
  caso já pronto e correto. Essa é hoje a principal decisão de investimento pendente.
- **Hoje o sistema cobre a notificação inicial.** Se surgir uma informação nova sobre um
  caso que já foi enviado à Anvisa, essa atualização (chamada de "seguimento") ainda precisa
  ser feita à parte, diretamente no sistema da Anvisa.
- **Cada caso hoje trata um medicamento e uma reação por vez.** Situações mais raras, como
  suspeita de interação entre dois medicamentos usados ao mesmo tempo, ainda exigem
  tratamento manual complementar.
- **O sistema só é tão bom quanto o hábito de usá-lo.** O maior risco não é técnico: é a
  adesão da equipe. Enfermagem, medicina e farmácia precisam manter a notificação como parte
  natural da rotina, para que a base de dados continue confiável e útil para a gestão.
- **Depende de configuração inicial e manutenção leve.** A lista de medicamentos
  monitorados, os setores e os farmacêuticos responsáveis precisam ser mantidos atualizados
  no painel administrativo — não é um processo "plugue e esqueça".

---

## 8. Resumo final

O VigiRAM transformou um processo que dependia inteiramente de memória, disponibilidade e
julgamento individual em um **fluxo único, visível e mensurável** de vigilância de
medicamentos. Ele não elimina a necessidade do farmacêutico — pelo contrário, dá a ele
ferramentas melhores para fazer esse trabalho com mais agilidade, mais consistência e menos
risco de um caso passar despercebido.

Os desafios que restam não são falhas do sistema, e sim **decisões de investimento e de
cultura organizacional**: licenciar um dicionário médico, ampliar a cobertura para casos mais
complexos, e manter viva a cultura de notificação em toda a equipe assistencial.
