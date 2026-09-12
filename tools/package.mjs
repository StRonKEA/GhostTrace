// GhostTrace - Chrome Web Store paketleyici
//
// Kullanim: npm run package  ->  dist/ghosttrace-<surum>.zip
//
// Yalnizca eklentinin calismasi icin gereken dosyalari alir; test, arac,
// yapilandirma ve dokumantasyon dosyalari paketten cikarilir.
// Harici bagimlilik yok: ZIP, node:zlib ile elle yazilir.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Pakete girecek koklar
const INCLUDE = ['manifest.json', 'service-worker.js', 'lib', 'locales', '_locales', 'popup', 'options', 'ui', 'content', 'icons'];
// Bu adlar hiçbir zaman paketlenmez
const EXCLUDE_NAMES = new Set(['node_modules', 'test', 'tools', 'dist', '.cache', '.git', '.gitignore',
  'package.json', 'package-lock.json', 'eslint.config.mjs']);

function collect(pathFromRoot, out = []) {
  const absolute = join(ROOT, pathFromRoot);
  const info = statSync(absolute);
  if (info.isDirectory()) {
    for (const entry of readdirSync(absolute)) {
      if (EXCLUDE_NAMES.has(entry)) continue;
      collect(join(pathFromRoot, entry), out);
    }
  } else {
    out.push(pathFromRoot);
  }
  return out;
}

// --------------------------------------------------------------------------
// Minimal ZIP yazici (deflate)
// --------------------------------------------------------------------------

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

function buildZip(entries, date = new Date()) {
  const { time, day } = dosDateTime(date);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name.split(sep).join('/'), 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // yerel baslik imzasi
    local.writeUInt16LE(20, 4);           // gerekli surum
    local.writeUInt16LE(0x0800, 6);       // UTF-8 bayragi
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // merkezi dizin imzasi
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // 30-40 arasi alanlar (ek alan, yorum, disk, nitelikler) sifir kalir
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }

  const localBuffer = Buffer.concat(localParts);
  const centralBuffer = Buffer.concat(centralParts);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(localBuffer.length, 16);

  return Buffer.concat([localBuffer, centralBuffer, end]);
}

// --------------------------------------------------------------------------

const files = INCLUDE.flatMap(root => collect(root));
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

const entries = files.map(file => ({
  name: relative('', file),
  data: readFileSync(join(ROOT, file))
}));

mkdirSync(join(ROOT, 'dist'), { recursive: true });
const outputPath = join(ROOT, 'dist', `ghosttrace-${manifest.version}.zip`);
const zip = buildZip(entries);
writeFileSync(outputPath, zip);

const totalRaw = entries.reduce((sum, entry) => sum + entry.data.length, 0);
console.log(`${entries.length} dosya paketlendi`);
console.log(`Ham boyut  : ${(totalRaw / 1024).toFixed(1)} KB`);
console.log(`ZIP boyutu : ${(zip.length / 1024).toFixed(1)} KB`);
console.log(`Cikti      : ${outputPath}`);
