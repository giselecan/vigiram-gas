/**
 * Gerador do subset de ícones (icons.html) — extrai do pacote oficial
 * @fortawesome/fontawesome-free apenas os ícones solid realmente usados
 * nos .html e emite um <style> autocontido baseado em CSS mask.
 *
 * Mantém o markup existente intacto: <i class="fas fa-xxx"> continua
 * funcionando, inclusive os ícones montados dinamicamente em template
 * strings do JS. Nenhuma requisição externa.
 */
const fs   = require('fs');
const path = require('path');

const ROOT = __dirname;
const META = require(path.join(ROOT, 'node_modules/@fortawesome/fontawesome-free/metadata/icon-families.json'));

// 1) Nomes de ícone realmente usados nos HTML (fa-xxx), menos modificadores.
const MODIFICADORES = new Set(['spin','fw','lg','2x','3x','xs','sm','pulse','border','inverse','stack','stack-1x','stack-2x','li','ul','rotate-90','rotate-180','rotate-270','flip-horizontal','flip-vertical']);
// icons.html é a SAÍDA deste script — não pode ser lido como fonte, senão
// suas próprias custom props (--fa-svg/--fa-ar) entram como "ícones usados".
const htmls = fs.readdirSync(ROOT).filter(f => f.endsWith('.html') && f !== 'icons.html');
const usados = new Set();
for (const f of htmls) {
  // Remove comentários HTML antes do scan: um "fa-xxx" citado em comentário
  // de documentação não é um ícone real e faria o build falhar como "não resolvido".
  const txt = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const m = txt.match(/fa-[a-z0-9-]+/g) || [];
  for (const cls of m) {
    const nome = cls.slice(3);
    if (!MODIFICADORES.has(nome)) usados.add(nome);
  }
}

// 2) Índice: nome (canônico OU alias) -> dados solid do ícone canônico.
const indice = {};
for (const [canon, data] of Object.entries(META)) {
  const solid = data.svgs && data.svgs.classic && data.svgs.classic.solid;
  if (!solid || !solid.path) continue;
  const registro = { path: solid.path, w: solid.width, h: solid.height };
  indice[canon] = registro;
  const aliases = (data.aliases && data.aliases.names) || [];
  for (const a of aliases) if (!indice[a]) indice[a] = registro;
}

// 3) Resolve cada usado; acumula faltantes para falhar alto (nunca silencioso).
const faltando = [];
const escolhidos = [];
for (const nome of [...usados].sort()) {
  const ic = indice[nome];
  if (!ic) { faltando.push(nome); continue; }
  escolhidos.push([nome, ic]);
}
if (faltando.length) {
  console.error('ÍCONES NÃO RESOLVIDOS (revisar/renomear):', faltando.join(', '));
  process.exit(1);
}

// 4) Monta o data-URI de cada ícone. Usa aspect-ratio p/ largura fiel ao FA.
function dataUri(ic) {
  // Codificação mínima p/ data-URI de SVG (técnica "optimized SVG data URI"):
  // aspas simples nos atributos e só escapamos os caracteres que quebram o
  // url()/data-URI. Espaços/vírgulas do path ficam crus — muito menor que
  // encodeURIComponent e ainda comprime bem no gzip do GAS.
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${ic.w} ${ic.h}'><path d='${ic.path}'/></svg>`;
  const enc = svg
    .replace(/%/g, '%25')
    .replace(/#/g, '%23')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/"/g, '%22');
  return `url("data:image/svg+xml,${enc}")`;
}

let regras = '';
for (const [nome, ic] of escolhidos) {
  const ar = (ic.w / ic.h).toFixed(4).replace(/\.?0+$/, '');
  regras += `.fa-${nome}{--fa-svg:${dataUri(ic)};--fa-ar:${ar}}\n`;
}

const out = `<style>
  /* =====================================================
     ÍCONES — SUBSET SOLID DO FONT AWESOME (self-contained)
     Gerado por scratchpad-build-icons.js a partir de
     @fortawesome/fontawesome-free (${escolhidos.length} ícones usados).
     Substitui o CDN cdnjs (CSS + webfont ~150 KB, render-blocking):
     cada .fa-xxx é desenhado via CSS mask com o SVG embutido, então
     o markup <i class="fas fa-xxx"> segue idêntico e herda a cor do
     texto (currentColor) e o tamanho (1em). Zero requisição externa.
     Para adicionar um ícone novo: use a classe no HTML e rode
     \`node scratchpad-build-icons.js\` de novo.
  ===================================================== */
  .fa, .fas {
    display: inline-block;
    height: 1em;
    width: auto;              /* largura vem do aspect-ratio (fiel ao FA) */
    aspect-ratio: var(--fa-ar, 1);
    background-color: currentColor;
    -webkit-mask: var(--fa-svg) no-repeat center / contain;
            mask: var(--fa-svg) no-repeat center / contain;
    vertical-align: -0.125em;
    -webkit-font-smoothing: antialiased;
  }
  .fa-spin { animation: fa-spin 1.4s linear infinite; }
  @keyframes fa-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .fa-spin { animation: none; } }

  ${regras.trim()}
</style>
`;

fs.writeFileSync(path.join(ROOT, 'icons.html'), out);
console.log('OK: icons.html gerado com', escolhidos.length, 'ícones.');
console.log('Usados:', [...usados].sort().join(' '));
