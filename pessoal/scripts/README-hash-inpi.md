# Hash do código-fonte para o depósito no INPI (serviço 730)

O INPI (registro de programa de computador) pede o código-fonte do programa
como parte do depósito. Este script empacota o código-fonte do VigiRAM e gera
um hash SHA-256 do pacote, que pode ser citado como comprovante de integridade
no requerimento (junto com data/hora e o próprio arquivo entregue).

## Como gerar

```bash
npm run hash:inpi
```

Gera em `pessoal/dist-inpi/` (pasta ignorada pelo git, é saída de build):

- `vigiram-codigo-fonte.zip` — o pacote de código-fonte a anexar/depositar.
- `manifesto-sha256.txt` — SHA-256 de cada arquivo individualmente.
- `hash-zip-sha256.txt` — SHA-256 do próprio `.zip` (o valor a citar no INPI).

## O que entra no pacote

Só o **código-fonte do programa**: arquivos `.gs`, `.js`, `.html`, `.css` e
`.json` (inclui `appsscript.json`, `package.json`, `tailwind.config.js`).

Ficam de fora por não serem código do programa em si:

- imagens (`.png`, `.jpg`) — ex.: `favicon.png`;
- `package-lock.json` — gerado automaticamente pelo npm, não é código autoral;
- documentação (`.md`) e dotfiles (`.claspignore`).

A lista de extensões/exclusões está no topo de `gerar-hash-inpi.js` — ajuste
ali se o escopo do depósito mudar.

## Reprodutibilidade

O script copia os arquivos para uma área temporária com timestamp fixo antes
de compactar, então o `.zip` gerado é **byte-a-byte idêntico** em qualquer
máquina/execução (mesmos arquivos de entrada ⇒ mesmo hash). Isso importa para
o INPI: o hash citado no requerimento tem que ser sempre reproduzível a partir
do mesmo código-fonte, para servir como prova de integridade/data.

Se qualquer arquivo do código-fonte mudar, o hash muda — rode o script de novo
antes de cada depósito/atualização.
