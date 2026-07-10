# Build do CSS (Tailwind pré-compilado)

O VigiRAM **não** usa mais o Tailwind Play CDN (`https://cdn.tailwindcss.com`).
Aquele CDN baixava ~3 MB do compilador e gerava o CSS **no navegador de cada
usuário, a cada carregamento**. Agora o CSS é pré-compilado **uma vez** e fica
embutido em `styles.html`, servido pelo próprio Apps Script.

## O que roda onde

- **Usuário final** (farmacêuticos, formulário da assistência): não instala nada.
  Abre a URL do web app e recebe o HTML com o CSS já embutido. Mais rápido e
  sem depender de CDN externo (importante em rede hospitalar com firewall).
- **Quem vai só publicar** o app: nada a fazer — `styles.html` já vem pronto no
  repositório. É só publicar (editor do Apps Script / integração GitHub).
- **Quem vai mexer nas classes** (adicionar/alterar classes Tailwind em algum
  `.html`): precisa regerar o CSS. Passos abaixo.

## Como regerar o CSS (só ao adicionar/mudar classes Tailwind)

Pré-requisito: Node.js instalado (https://nodejs.org).

```bash
npm install          # uma vez por máquina (instala o Tailwind localmente)
npm run build:css    # gera tw-output.css a partir dos .html
```

Depois, cole o conteúdo de `tw-output.css` DENTRO do primeiro `<style>` de
`styles.html` (o bloco marcado como "TAILWIND PRE-COMPILADO"), substituindo o
CSS antigo desse bloco — **sem** tocar no `<style>` de baixo (CSS custom:
`badge-sla`, `kanban-card`, `skeleton`, etc.). Depois publique.

> `tw-output.css` e `node_modules/` estão no `.gitignore` — são artefatos de
> build. A "fonte da verdade" que vai para produção é o `styles.html`.

## Por que funciona em qualquer computador

A tooling de build (`tailwind.config.js`, `tw-input.css`, `package.json`) está
versionada no repositório. Qualquer pessoa que clonar o repo tem exatamente o
mesmo build — nada fica preso numa máquina específica. E como o `styles.html`
gerado também está no repo, quem só publica nem precisa rodar o build.

## Observações

- O scan (`tailwind.config.js` → `content: ['./*.html']`) lê todos os `.html`,
  inclusive as classes dentro de template strings dos `js_*.html`.
- As classes do VigiRAM são strings **literais** (mesmo as condicionais, tipo
  `isDE ? 'bg-purple-100' : 'bg-red-100'`), então são detectadas. Só entra em
  `safelist` (no config) uma classe montada por interpolação parcial
  (ex.: `` `bg-${cor}-500` ``) — auditado e hoje não há nenhuma.
- Se após publicar algum elemento aparecer "sem estilo", é sinal de uma classe
  nova não capturada: adicione-a ao `safelist` do `tailwind.config.js`, rode
  `npm run build:css` de novo e recole.
