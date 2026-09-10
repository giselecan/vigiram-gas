#!/usr/bin/env node
/**
 * obfuscate.js — ofusca o "coração" da lógica de negócio (E2B/Naranjo) antes
 * de um `clasp push`, e restaura o código-fonte legível depois.
 *
 * VigiRAM é propriedade intelectual de Gisele Cristine Araujo Nascimento.
 * O Apps Script não tem como esconder código de quem tem acesso de Editor —
 * este script não resolve isso, só torna a leitura/engenharia reversa do
 * arquivo mais custosa para quem só tiver acesso ao Web App publicado ou a
 * uma cópia do código sem contexto de desenvolvimento.
 *
 * USO:
 *   node obfuscate.js            # ofusca os arquivos-alvo (faz backup 1x)
 *   node obfuscate.js --restore  # devolve os arquivos originais legíveis
 *
 * FLUXO RECOMENDADO:
 *   1. node obfuscate.js
 *   2. clasp push
 *   3. node obfuscate.js --restore   (volta a trabalhar no código legível)
 *
 * Nunca commitar os arquivos NO ESTADO OFUSCADO — o backup usado por este
 * script fica em .obfuscate-backup/ (git-ignorado); o código-fonte legível
 * é sempre o que fica versionado no repositório.
 */

const fs   = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURAÇÃO — arquivos-alvo (o "coração" da lógica: E2B/Naranjo).
// Adicione outros .gs aqui se quiser ofuscar mais módulos sensíveis.
// ─────────────────────────────────────────────────────────────────────────────
const ARQUIVOS_ALVO = [
  'E2b.gs'
];

const DIR_BACKUP = path.join(__dirname, '.obfuscate-backup');

const OPCOES_OFUSCADOR = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: true,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,

  // CRÍTICO para Apps Script: todos os .gs do projeto compartilham o MESMO
  // escopo global (é assim que Router.gs chama funções definidas em Auth.gs,
  // Ingest.gs, etc.). Se renameGlobals ficasse true, funções/consts de nível
  // superior seriam renomeadas DENTRO do arquivo ofuscado, mas as chamadas a
  // elas em OUTROS arquivos (não ofuscados) quebrariam. false preserva os
  // nomes de nível superior — só a lógica INTERNA da função é embaralhada.
  renameGlobals: false,

  // Recursos do obfuscador que dependem de globais de NAVEGADOR/timers
  // (window, setInterval) para se defenderem contra debugging/formatação —
  // o runtime V8 do Apps Script não é um navegador nem tem essas APIs;
  // habilitá-los quebraria a execução no servidor.
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,

  target: 'node'
};

function listarArquivosAlvo() {
  return ARQUIVOS_ALVO.map(function (nome) {
    return path.join(__dirname, nome);
  });
}

function ofuscar() {
  if (fs.existsSync(DIR_BACKUP)) {
    console.error(
      '[obfuscate.js] Já existe um backup em .obfuscate-backup/ — os arquivos ' +
      'parecem já estar ofuscados. Rode "node obfuscate.js --restore" antes ' +
      'de ofuscar de novo.'
    );
    process.exit(1);
  }

  fs.mkdirSync(DIR_BACKUP, { recursive: true });

  listarArquivosAlvo().forEach(function (caminho) {
    const nome = path.basename(caminho);

    if (!fs.existsSync(caminho)) {
      console.warn('[obfuscate.js] Arquivo-alvo não encontrado, pulando: ' + nome);
      return;
    }

    const codigoOriginal = fs.readFileSync(caminho, 'utf8');

    // Backup do original legível — restaurado por --restore.
    fs.writeFileSync(path.join(DIR_BACKUP, nome), codigoOriginal, 'utf8');

    const resultado = JavaScriptObfuscator.obfuscate(codigoOriginal, OPCOES_OFUSCADOR);
    const codigoOfuscado =
      '// VigiRAM — build ofuscado (gerado por obfuscate.js). NÃO EDITAR.\n' +
      '// Propriedade intelectual de Gisele Cristine Araujo Nascimento.\n' +
      '// Fonte legível em .obfuscate-backup/' + nome + ' — rode `node obfuscate.js --restore`.\n' +
      resultado.getObfuscatedCode();

    fs.writeFileSync(caminho, codigoOfuscado, 'utf8');
    console.log('[obfuscate.js] Ofuscado: ' + nome);
  });

  console.log(
    '[obfuscate.js] Pronto. Rode `clasp push` agora e depois ' +
    '`node obfuscate.js --restore` para voltar a trabalhar no código legível.'
  );
}

function restaurar() {
  if (!fs.existsSync(DIR_BACKUP)) {
    console.error('[obfuscate.js] Nenhum backup encontrado em .obfuscate-backup/ — nada a restaurar.');
    process.exit(1);
  }

  listarArquivosAlvo().forEach(function (caminho) {
    const nome = path.basename(caminho);
    const caminhoBackup = path.join(DIR_BACKUP, nome);

    if (!fs.existsSync(caminhoBackup)) {
      console.warn('[obfuscate.js] Sem backup para ' + nome + ', pulando.');
      return;
    }

    fs.copyFileSync(caminhoBackup, caminho);
    fs.unlinkSync(caminhoBackup);
    console.log('[obfuscate.js] Restaurado: ' + nome);
  });

  fs.rmdirSync(DIR_BACKUP);
  console.log('[obfuscate.js] Código-fonte legível restaurado.');
}

const modo = process.argv[2];
if (modo === '--restore') {
  restaurar();
} else if (!modo) {
  ofuscar();
} else {
  console.error('Uso: node obfuscate.js [--restore]');
  process.exit(1);
}
