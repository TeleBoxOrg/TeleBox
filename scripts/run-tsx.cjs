'use strict';
/**
 * Node 22+ exposes global localStorage backed by --localstorage-file.
 * teleproto → store2 touches localStorage at load time; without a valid path,
 * Node warns. tsx may spawn child processes that only inherit env, not
 * the parent argv flag — so this sets NODE_OPTIONS (merged with any existing).
 *
 * Only applies the flag on Node.js 22+, as it causes errors on earlier versions.
 * Override file path with TB_LOCALSTORAGE_FILE.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.join(__dirname, '..');
const cacheBase = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
const defaultFile = path.join(cacheBase, 'telebox', 'node-localstorage');
const lsFile = process.env.TB_LOCALSTORAGE_FILE || defaultFile;

fs.mkdirSync(path.dirname(lsFile), { recursive: true });

// Check Node.js version - --localstorage-file requires Node 22+
const nodeVersion = process.versions.node.split('.').map(Number);
const majorVersion = nodeVersion[0];

const esbuildRegister = path.join(__dirname, 'esbuild-register.cjs');
const entryArgs = process.argv.slice(2);
if (entryArgs.length === 0) {
  console.error('usage: node scripts/run-tsx.cjs <script.ts> [args...]');
  process.exit(1);
}

const env = { ...process.env };

// Only add --localstorage-file for Node.js 22+
if (majorVersion >= 22) {
  const flag = `--localstorage-file=${lsFile}`;
  const existing = (env.NODE_OPTIONS || '').trim();
  env.NODE_OPTIONS = existing ? `${existing} ${flag}` : flag;
}

// Limit V8 heap to 192 MB and expose gc() for the health plugin.
// Without this, V8 can grow heap unbounded during active channel hours.
const heapFlags = '--max-old-space-size=192 --expose-gc';
const existingOpts = (env.NODE_OPTIONS || '').trim();
env.NODE_OPTIONS = existingOpts ? `${existingOpts} ${heapFlags}` : heapFlags;

// Use esbuild-register instead of tsx to eliminate heap waste from
// inline source maps, CJS polyfill duplication, and source string retention.
// Precompile plugins to shared-helpers cache if cache is missing.
const cacheDir = path.join(root, '.plugin-cache');
if (!fs.existsSync(path.join(cacheDir, 'cjs-helpers.js'))) {
  console.log('[run-tsx] Plugin cache missing, precompiling...');
  const pre = spawnSync(process.execPath, [path.join(__dirname, 'precompile-plugins.cjs')], {
    cwd: root, stdio: 'inherit',
  });
  if (pre.status !== 0) {
    console.error('[run-tsx] Precompile failed, continuing with on-the-fly compilation');
  }
}

const r = spawnSync(
  process.execPath,
  ['-r', 'tsconfig-paths/register', '-r', esbuildRegister, ...entryArgs],
  { cwd: root, env, stdio: 'inherit' }
);
process.exit(r.status === null ? 1 : r.status);