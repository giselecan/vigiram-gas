#!/usr/bin/env node
/**
 * Gera o pacote de código-fonte para depósito no INPI (registro de programa
 * de computador, serviço código 730) e o respectivo comprovante de hash.
 *
 * Saída (em pessoal/dist-inpi/):
 *   - vigiram-codigo-fonte.zip   -> pacote com o código-fonte selecionado
 *   - manifesto-sha256.txt       -> SHA-256 de cada arquivo incluído (ordem estável)
 *   - hash-zip-sha256.txt        -> SHA-256 do próprio arquivo .zip (o "hash do INPI")
 *
 * Reprodutibilidade: mesmos arquivos de entrada -> mesmo ZIP byte-a-byte
 * (timestamps e ordem das entradas são fixados), logo o hash final é estável
 * mesmo em execuções/máquinas diferentes.
 */

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist-inpi");
const STAGE_DIR = path.join(OUT_DIR, "_stage");
const ZIP_NAME = "vigiram-codigo-fonte.zip";
const FIXED_MTIME = new Date("2020-01-01T00:00:00Z"); // timestamp fixo p/ build determinístico

// Extensões consideradas "código-fonte do programa" para fins do depósito.
// Ficam de fora: imagens (.png/.jpg), lockfiles gerados (package-lock.json)
// e documentação (.md) - não fazem parte do código do programa em si.
const INCLUDE_EXT = new Set([".gs", ".js", ".html", ".css", ".json"]);
const EXCLUDE_FILES = new Set(["package-lock.json"]);
const EXCLUDE_DIRS = new Set(["dist-inpi", "node_modules", "scripts"]);

function listSourceFiles(dir, base = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // dotfiles/dotdirs (.claspignore etc.) ficam de fora
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      files = files.concat(listSourceFiles(full, base));
    } else if (entry.isFile()) {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      if (!INCLUDE_EXT.has(path.extname(entry.name))) continue;
      files.push(path.relative(base, full));
    }
  }
  return files.sort((a, b) => a.localeCompare(b, "en"));
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function main() {
  const files = listSourceFiles(ROOT);
  if (files.length === 0) {
    console.error("Nenhum arquivo de código-fonte encontrado em " + ROOT);
    process.exit(1);
  }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(STAGE_DIR, { recursive: true });

  // 1) Manifesto: hash de cada arquivo individualmente, em ordem estável.
  const manifestLines = files.map((rel) => {
    const abs = path.join(ROOT, rel);
    return `${sha256File(abs)}  ${rel.replace(/\\/g, "/")}`;
  });
  const manifestPath = path.join(OUT_DIR, "manifesto-sha256.txt");
  fs.writeFileSync(manifestPath, manifestLines.join("\n") + "\n", "utf8");

  // 2) Área de staging: cópia dos arquivos com timestamp fixo, para que o
  // ZIP final seja byte-a-byte idêntico em qualquer máquina/execução.
  for (const rel of files) {
    const src = path.join(ROOT, rel);
    const dest = path.join(STAGE_DIR, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    fs.utimesSync(dest, FIXED_MTIME, FIXED_MTIME);
  }

  // 3) ZIP determinístico: mesma ordem, sem paths absolutos, timestamps fixos.
  const zipPath = path.join(OUT_DIR, ZIP_NAME);
  fs.rmSync(zipPath, { force: true });
  execFileSync(
    "zip",
    ["-X", "-q", zipPath, ...files.map((f) => f.replace(/\\/g, "/"))],
    { cwd: STAGE_DIR },
  );
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });

  // 4) Hash do pacote final (o valor a citar no requerimento do INPI).
  const zipHash = sha256File(zipPath);
  const hashPath = path.join(OUT_DIR, "hash-zip-sha256.txt");
  fs.writeFileSync(
    hashPath,
    `SHA-256 (${ZIP_NAME}): ${zipHash}\n` +
      `Arquivos incluídos: ${files.length}\n` +
      `Gerado em: ${new Date().toISOString()}\n`,
    "utf8",
  );

  console.log(`Arquivos incluídos (${files.length}):`);
  for (const f of files) console.log("  " + f);
  console.log("");
  console.log("ZIP:      " + path.relative(ROOT, zipPath));
  console.log("Manifesto:" + " " + path.relative(ROOT, manifestPath));
  console.log("");
  console.log("SHA-256 do ZIP (usar no depósito INPI - serviço 730):");
  console.log("  " + zipHash);
}

main();
