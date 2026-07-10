/**
 * @fileoverview Favicon.gs — ícone da aba do navegador (escudo VigiRAM).
 *
 * POR QUE NO SERVIDOR: o app roda dentro de um iframe sandbox do Apps Script.
 * Um <link rel="icon"> no HTML cai NO IFRAME e é ignorado pela aba (o ícone vem
 * da página de cima, gerada pelo Google). O único jeito suportado é
 * HtmlOutput.setFaviconUrl(...) no doGet (Router.gs → aplicarFavicon_).
 *
 * IMPORTANTE — setFaviconUrl é EXIGENTE:
 *   - REJEITA data URI (data:image/png;base64,...) → "tipo de imagem
 *     incompatível". Por isso NÃO dá para embutir a imagem aqui.
 *   - Precisa de uma URL http(s) PÚBLICA de uma imagem PNG/ICO/GIF
 *     (idealmente terminando em .png/.ico/.gif), acessível sem login.
 *
 * COMO ATIVAR: hospede o PNG do escudo (favicon.png, na raiz do repo) numa URL
 * pública e cole em FAVICON_URL abaixo. Ex.: GitHub raw
 * (https://raw.githubusercontent.com/<owner>/<repo>/main/favicon.png) se o repo
 * for público, ou qualquer host de imagem. Enquanto estiver vazio, mantém o
 * ícone padrão do Google (sem quebrar nada).
 */
// Hotlink de imagem do Google Drive (arquivo compartilhado como "Qualquer pessoa
// com o link"). Se o setFaviconUrl recusar por não terminar em .png, troque por
// um link direto .png (ex.: postimages.org) — o app não quebra de qualquer forma.
const FAVICON_URL = 'https://lh3.googleusercontent.com/d/1iMAlsxB8dZl_z-UKg1eGxj3sLC4MgwLs';

/**
 * Aplica o favicon num HtmlOutput servido pelo doGet, de forma SEGURA:
 * uma URL ausente/inválida NUNCA pode derrubar a página (era o que estava
 * acontecendo — a exceção do setFaviconUrl quebrava o doGet inteiro).
 */
function aplicarFavicon_(htmlOutput) {
  if (!FAVICON_URL) return htmlOutput; // sem URL → não faz nada
  try {
    return htmlOutput.setFaviconUrl(FAVICON_URL);
  } catch (e) {
    console.warn('aplicarFavicon_: favicon ignorado — ' + e.message);
    return htmlOutput; // degrada sem ícone custom, mas a página carrega
  }
}
