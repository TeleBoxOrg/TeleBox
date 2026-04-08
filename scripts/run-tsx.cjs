'use strict';
/**
 * Node 22+ exposes global localStorage backed by --localstorage-file.
 * teleproto → store2 touches localStorage at load time; without a valid path,
 * Node warns. tsx may spawn child Node processes that only inherit env, not
 * the parent argv flag — so this sets NODE_OPTIONS (merged with any existing).
 *
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

const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entryArgs = process.argv.slice(2);
if (entryArgs.length === 0) {
  console.error('usage: node scripts/run-tsx.cjs <script.ts> [args...]');
  process.exit(1);
}

const env = { ...process.env };
const flag = `--localstorage-file=${lsFile}`;
const existing = (env.NODE_OPTIONS || '').trim();
env.NODE_OPTIONS = existing ? `${existing} ${flag}` : flag;

const r = spawnSync(
  process.execPath,
  [tsxCli, '-r', 'tsconfig-paths/register', ...entryArgs],
  { cwd: root, env, stdio: 'inherit' }
);
process.exit(r.status === null ? 1 : r.status);
