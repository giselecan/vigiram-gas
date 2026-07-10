/**
 * Config do build de CSS do VigiRAM.
 *
 * POR QUÊ: em produção não se usa o Play CDN (https://cdn.tailwindcss.com) —
 * ele baixa ~3 MB do compilador e gera o CSS na main thread do navegador a cada
 * carregamento. Aqui o Tailwind CLI pré-compila UMA vez só as classes que o
 * projeto realmente usa, e o resultado é colado em styles.html (servido pelo GAS).
 *
 * COMO GERAR:  npm install  &&  npm run build:css
 *   → gera tw-output.css. Cole o conteúdo dele DENTRO do <style> no topo de
 *     styles.html (antes do CSS custom que já existe lá). Ver README-build-css.md.
 *
 * content: escaneia TODOS os .html (o HTML e as classes dentro de template
 * strings dos js_*.html). As classes do VigiRAM são strings LITERAIS (inclusive
 * as condicionais tipo `isDE ? 'bg-purple-100' : 'bg-red-100'`), então são
 * detectadas normalmente. Só precisaria de `safelist` se alguma classe fosse
 * montada por interpolação parcial (ex.: `bg-${cor}-500`) — auditado em 07/2026
 * e NÃO há nenhuma; o safelist fica vazio de propósito.
 */
module.exports = {
  content: ['./*.html'],
  safelist: [
    // Adicione aqui SOMENTE classes montadas por interpolação parcial que o
    // scanner não consiga ver (ex.: 'bg-teal-500'). Hoje: nenhuma.
  ],
  theme: { extend: {} },
  plugins: [],
};
