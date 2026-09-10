/**
 * @fileoverview Projeto institucional MÍNIMO — só a tela de redirecionamento.
 *
 * O QUE É: substitui o projeto Apps Script institucional INTEIRO do VigiRAM
 * (todo o Router.gs/Cases.gs/Admin.gs/Auth.gs/Security.gs/.html do painel
 * etc.) por só isto — 2 arquivos, nenhuma lógica de negócio. É a alternativa
 * mais segura a apagar o projeto institucional de vez (ver
 * plano_migracao_conta_pessoal.md, Fase 6): mantém a URL antiga funcionando
 * pra sempre (favoritos antigos, e-mails antigos com o link salvo) sem
 * deixar NENHUM código do sistema (nenhum caso, nenhuma senha, nenhuma
 * regra de negócio) acessível a quem ainda tiver acesso à conta
 * institucional.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * COMO USAR (uma vez só, DEPOIS de confirmar que a implantação nova está
 * estável por alguns dias)
 * ═══════════════════════════════════════════════════════════════════════
 *  1. No editor do projeto institucional (o que já está publicado na URL
 *     antiga): apague TODOS os arquivos .gs e .html que existirem hoje
 *     (Router.gs, Cases.gs, Admin.gs, index.html, tudo).
 *  2. Cole este arquivo (Redirect.gs) e o redirecionamento.html desta
 *     mesma pasta no lugar.
 *  3. A Script Property VIGIRAM_URL_MIGRACAO — que você já configurou
 *     quando ativou a tela de transição — continua sendo usada. Se por
 *     algum motivo ela não existir mais, defina de novo (Configurações do
 *     projeto → Propriedades do script) com a URL .../exec da implantação
 *     NOVA (pessoal).
 *  4. Implantar → Gerenciar implantações → editar (lápis) a implantação
 *     que tem a URL antiga → Versão: Nova versão → Implantar.
 *  5. Testa a URL antiga: deve mostrar só "Entrando no VigiRAM…" e cair
 *     na URL nova, sem nenhum vestígio do sistema.
 *
 * A partir daqui, o projeto institucional não tem mais NADA que valha a
 * pena copiar — só isto. Continua sendo mais seguro que apagar o projeto
 * de vez, porque links antigos continuam funcionando indefinidamente.
 * ═══════════════════════════════════════════════════════════════════════
 */

function doGet() {
  const novaUrl = PropertiesService.getScriptProperties().getProperty('VIGIRAM_URL_MIGRACAO') || '';
  const template = HtmlService.createTemplateFromFile('redirecionamento');
  template.novaUrl = novaUrl;
  return template.evaluate()
    .setTitle('VigiRAM')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
