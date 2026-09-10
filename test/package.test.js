import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildZip, runtimeFiles, manifestForUpload } from '../tools/package.js';

const EOCD_SIGNATURE = 0x06054b50;

/** Reads the end-of-central-directory record, which is the last 22 bytes here. */
function eocd(zip) {
  const at = zip.length - 22;
  assert.equal(zip.readUInt32LE(at), EOCD_SIGNATURE, 'archive must end with an EOCD record');
  return {
    entries: zip.readUInt16LE(at + 10),
    cdSize: zip.readUInt32LE(at + 12),
    cdOffset: zip.readUInt32LE(at + 16),
  };
}

test('the archive ships the manifest at the root, where Chrome looks for it', () => {
  assert.ok(runtimeFiles().includes('manifest.json'));
});

test('the archive ships every icon the manifest names', () => {
  const files = runtimeFiles();
  for (const size of [16, 32, 48, 128]) {
    assert.ok(files.includes(`icons/icon-${size}.png`), `icon-${size}.png`);
  }
});

test('the archive ships the fonts the stylesheets load', () => {
  const files = runtimeFiles();
  assert.ok(files.includes('assets/fonts/MemoryOf2018.otf'));
  assert.ok(files.includes('assets/fonts/BlueRidge.otf'));
});

// A store upload should be the extension and nothing else: the plans, fixtures,
// build scripts and font licences are all part of the repo, not the product.
test('the archive leaves the repo scaffolding behind', () => {
  for (const name of runtimeFiles()) {
    assert.doesNotMatch(name, /^(test|tools|docs|dev)\//, name);
    assert.doesNotMatch(name, /\.(md|pem|zip)$/, name);
    assert.notEqual(name, 'assets/spotinyl-logo.png', 'the logo is build input, not shipped');
    assert.notEqual(name, 'package.json');
  }
});

// Chrome reads entry names verbatim, and a Windows-style separator in an
// archive is what turns src/popup/popup.js into one oddly named file.
test('every shipped path is relative and uses forward slashes', () => {
  for (const name of runtimeFiles()) {
    assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/, `${name} is not a clean relative path`);
  }
});

test('buildZip writes a local header per file and counts them in the directory', () => {
  const zip = buildZip([
    { name: 'a.txt', data: Buffer.from('hello hello hello hello') },
    { name: 'dir/b.txt', data: Buffer.from('world') },
  ]);
  assert.equal(zip.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004');
  const end = eocd(zip);
  assert.equal(end.entries, 2);
  assert.equal(end.cdOffset + end.cdSize + 22, zip.length, 'the directory must sit just before the EOCD');
});

test('buildZip stores rather than deflates when compression would grow the entry', () => {
  // A single byte always deflates larger than it started.
  const zip = buildZip([{ name: 'tiny', data: Buffer.from([7]) }]);
  assert.equal(zip.readUInt16LE(8), 0, 'method 0 is stored');
  assert.equal(zip.readUInt32LE(18), 1, 'compressed size matches the original');
});

test('buildZip deflates a compressible entry', () => {
  const zip = buildZip([{ name: 'big', data: Buffer.alloc(4096, 0x41) }]);
  assert.equal(zip.readUInt16LE(8), 8, 'method 8 is deflate');
  assert.ok(zip.readUInt32LE(18) < 4096, 'compressed size should be smaller');
});

test('packaging the same tree twice produces identical bytes', () => {
  const entries = [{ name: 'a.txt', data: Buffer.from('repeatable') }];
  assert.deepEqual(buildZip(entries), buildZip(entries));
});

// The store refuses a first upload carrying `key` and ignores it thereafter,
// but a locally loaded build needs it to answer to the published extension ID
// (and so to the published redirect URI). The repo keeps it; the upload does not.
test('manifestForUpload drops a key field before the package is built', () => {
  const raw = Buffer.from(JSON.stringify({ name: 'Spotinyl', version: '1.0.0', key: 'MIIBIjAN' }));
  const parsed = JSON.parse(manifestForUpload(raw).toString());
  assert.ok(!Object.hasOwn(parsed, 'key'), 'key must not reach the store');
  assert.equal(parsed.name, 'Spotinyl', 'every other field survives');
  assert.equal(parsed.version, '1.0.0');
});

test('manifestForUpload leaves a manifest without a key byte-for-byte alone', () => {
  const raw = Buffer.from([`{`, `  "name": "Spotinyl"`, `}`, ``].join(String.fromCharCode(10)));
  assert.equal(manifestForUpload(raw), raw, 'formatting is preserved when there is nothing to strip');
});

test('the packaged manifest never carries a key', () => {
  const shipped = JSON.parse(manifestForUpload(readFileSync(new URL('../manifest.json', import.meta.url))).toString());
  assert.ok(!Object.hasOwn(shipped, 'key'));
  assert.equal(shipped.manifest_version, 3);
});
