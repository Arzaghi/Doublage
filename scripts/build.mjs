/**
 * Builds a signed CRX3 package (and ZIP) for the Doublage Chrome extension.
 *
 * Usage:
 *   node scripts/build.mjs
 *
 * Behaviour:
 *   1. Reads extension/manifest.json.
 *   2. Uses the version specified in manifest.json (does NOT modify the manifest).
 *   3. Validates that the version is a valid Chrome extension version (X.Y.Z format).
 *   4. Packs extension/ into a CRX3 file signed with the extension private key
 *      (extension.pem by default) plus a plain ZIP for Chrome Web Store upload.
 *   5. Writes the version to dist/VERSION and prints the output paths.
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

// ---- 1. Read and validate the manifest version --------------------------------
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const version = manifest.version;

if (!version) {
  console.error('❌ Error: extension/manifest.json does not define a version.');
  process.exit(1);
}

// Validate Chrome extension version format: X.Y.Z where X, Y, Z are non-negative integers.
const versionRegex = /^\d+(\.\d+){2}$/;
if (!versionRegex.test(version)) {
  console.error(
    `❌ Error: extension/manifest.json version "${version}" is not a valid Chrome extension version.`
  );
  console.error('Expected format: X.Y.Z (e.g., 1.0.0)');
  process.exit(1);
}

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

// ---- 3. Record the version (without modifying manifest) -------------------------
writeFileSync(join(DIST, 'VERSION'), version + '\n');
console.log(`✓ Doublage v${version} built:`);
console.log(`  CRX: ${crxPath}`);
console.log(`  ZIP: ${zipPath}`);