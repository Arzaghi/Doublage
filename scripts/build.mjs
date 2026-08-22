/**
 * Builds a signed CRX3 package (and ZIP) for the Doublage Chrome extension.
 *
 * Usage:
 *   node scripts/build.mjs
 *
 * Behaviour:
 *   1. Reads extension/manifest.json and bumps the patch version (1.0.0 -> 1.0.1).
 *   2. Writes the bumped manifest back to extension/manifest.json.
 *   3. Packs extension/ into a CRX3 file signed with the extension private key
 *      (extension.pem by default) plus a plain ZIP for Chrome Web Store upload.
 *   4. Writes the new version to dist/VERSION and prints the output paths.
 *
 * Environment:
 *   EXTENSION_KEY_PATH - optional path to the private key (default: <repo>/extension.pem).
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// Paths relative to the repository root.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXT_DIR = join(ROOT, 'extension');
const MANIFEST_PATH = join(EXT_DIR, 'manifest.json');
const DIST = join(ROOT, 'dist');
const KEY_PATH = process.env.EXTENSION_KEY_PATH || join(ROOT, 'extension.pem');
const EXTENSION_NAME = 'Doublage';

// ---- 1. Bump the patch version -------------------------------------------------
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const parts = String(manifest.version ?? '0.0.0').split('.').map((p) => parseInt(p, 10) || 0);
while (parts.length < 3) parts.push(0);
parts[parts.length - 1] += 1;
const version = parts.join('.');
manifest.version = version;
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');

// ---- 2. Build the signed CRX3 + ZIP -------------------------------------------
mkdirSync(DIST, { recursive: true });
const crxPath = join(DIST, `${EXTENSION_NAME}-v${version}.crx`);
const zipPath = join(DIST, `${EXTENSION_NAME}-v${version}.zip`);

let crx3Bin;
try {
  crx3Bin = require.resolve('crx3/bin/crx3.js');
} catch {
  crx3Bin = 'crx3';
}

// Signs the extension directory with the private key and writes both a CRX3 and
// a plain ZIP. An existing key file is reused; otherwise one is created.
execFileSync(process.execPath, [crx3Bin, '-z', zipPath, '-p', KEY_PATH, '-o', crxPath, EXT_DIR], {
  stdio: 'inherit',
});

// ---- 3. Record the new version -------------------------------------------------
writeFileSync(join(DIST, 'VERSION'), version + '\n');
console.log(`Doublage v${version} built:`);
console.log(`  CRX: ${crxPath}`);
console.log(`  ZIP: ${zipPath}`);