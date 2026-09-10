import { deflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, posix, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// An allowlist, not an ignore list: a store upload should contain exactly what
// the extension runs and nothing that happens to be sitting in the tree. Source
// maps, plans, fixtures and font licences all stay behind.
const INCLUDE = [
  'manifest.json',
  ['icons', /\.png$/],
  ['src', /\.(js|html|css)$/],
  ['assets/fonts', /\.otf$/],
];

function collect(entry) {
  if (typeof entry === 'string') return [entry];
  const [dir, pattern] = entry;
  const out = [];
  const walk = (relDir) => {
    for (const name of readdirSync(join(ROOT, relDir)).sort()) {
      const rel = posix.join(relDir, name);
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (pattern.test(name)) out.push(rel);
    }
  };
  walk(dir);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A fixed DOS timestamp (1980-01-01 00:00) so repackaging the same source twice
// produces byte-identical archives. Chrome ignores it; reproducibility does not.
const DOS_TIME = 0;
const DOS_DATE = 33;

/** Writes a ZIP with deflated entries: local headers, central directory, EOCD. */
export function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    // Storing beats deflating when compression makes the entry bigger.
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

/**
 * The manifest as the store has to receive it.
 *
 * `key` pins a locally loaded build to the published extension ID, which is
 * worth keeping in the repo: without it the unpacked build answers to a
 * different `chrome.identity.getRedirectURL()` than the published one, and the
 * Spotify app has to have both registered. The store will not take it on a
 * first upload — "key field is not allowed in manifest" — and ignores it on
 * every upload after that, so dropping it here lets one manifest serve both.
 */
export function manifestForUpload(raw) {
  const parsed = JSON.parse(raw);
  // Nothing to strip: ship the file exactly as it is written, formatting and all.
  if (!Object.hasOwn(parsed, 'key')) return raw;
  delete parsed.key;
  return Buffer.from(`${JSON.stringify(parsed, null, 2)}
`, 'utf8');
}

/** The runtime file list, as forward-slash paths relative to the extension root. */
export function runtimeFiles() {
  return INCLUDE.flatMap(collect);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const names = runtimeFiles();
  const files = names.map((name) => {
    const data = readFileSync(join(ROOT, name.split(posix.sep).join(sep)));
    return { name, data: name === 'manifest.json' ? manifestForUpload(data) : data };
  });

  const zip = buildZip(files);
  const outDir = join(ROOT, 'dist');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `spotinyl-${manifest.version}.zip`);
  writeFileSync(out, zip);

  const raw = files.reduce((sum, f) => sum + f.data.length, 0);
  for (const f of files) console.log(`  ${f.name} (${f.data.length} bytes)`);
  console.log(`\n${files.length} files, ${raw} bytes raw`);
  console.log(`wrote ${relative(ROOT, out)} (${zip.length} bytes)`);
}
