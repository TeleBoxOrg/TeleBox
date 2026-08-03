'use strict';
/**
 * Precompile all .ts plugin files to .js with shared CJS helpers.
 * Run this script to generate the plugin cache.
 * Usage: node scripts/precompile-plugins.cjs
 */
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..');
const PLUGIN_DIRS = [
  path.join(PROJECT_ROOT, 'plugins'),
  path.join(PROJECT_ROOT, 'src', 'plugin'),
];
const HELPERS_PATH = path.join(PROJECT_ROOT, 'scripts', 'cjs-helpers.js');
const CACHE_DIR = path.join(PROJECT_ROOT, '.plugin-cache');

// Read target from tsconfig.json
let target = 'es2020';
try {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tsconfig.json'), 'utf8'));
  if (tsconfig.compilerOptions && tsconfig.compilerOptions.target) {
    target = tsconfig.compilerOptions.target;
  }
} catch {
  // fall back to es2020
}

function stripHelpers(code) {
  if (!code.startsWith('var __')) {
    return code; // no helpers to strip
  }
  // Find the first 'var ' line that doesn't start with 'var __'
  // This marks the end of the esbuild CJS helper block
  const match = code.match(/^var [^_]/m);
  if (match) {
    return code.slice(match.index);
  }
  return code;
}

function precompileFile(tsPath, relPath) {
  const source = fs.readFileSync(tsPath, 'utf8');
  const ext = path.extname(tsPath);
  const result = esbuild.transformSync(source, {
    loader: ext === '.tsx' ? 'tsx' : 'ts',
    target: target,
    format: 'cjs',
    sourcemap: false,
    sourcefile: tsPath,
  });

  // Strip the inline CJS helpers (only if present)
  let code = result.code;
  let helpersWereStripped = code.startsWith('var __');
  if (helpersWereStripped) {
    code = stripHelpers(code);
    // Prepend require for shared helpers
    const helpersRequire = `const { __create, __defProp, __getOwnPropDesc, __getOwnPropNames, __getProtoOf, __hasOwnProp, __defNormalProp, __export, __copyProps, __toESM, __toCommonJS, __publicField } = require(${JSON.stringify(HELPERS_PATH)});\n`;
    code = helpersRequire + code;
  }

  // Write to cache
  const cachePath = path.join(CACHE_DIR, relPath.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, code, 'utf8');

  return cachePath;
}

function main() {
  console.log('[precompile] Starting plugin precompilation...');
  console.log('[precompile] Cache dir:', CACHE_DIR);

  // Clean cache dir
  if (fs.existsSync(CACHE_DIR)) {
    fs.rmSync(CACHE_DIR, { recursive: true });
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Copy shared helpers to cache dir
  const helpersSrc = path.join(PROJECT_ROOT, 'scripts', 'cjs-helpers.js');
  const helpersDst = path.join(CACHE_DIR, 'cjs-helpers.js');
  fs.copyFileSync(helpersSrc, helpersDst);
  console.log('[precompile] Copied shared helpers to cache');

  let totalFiles = 0;
  let totalSize = 0;

  for (const dir of PLUGIN_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));
    console.log(`[precompile] Found ${files.length} .ts files in ${path.relative(PROJECT_ROOT, dir)}`);

    for (const file of files) {
      const tsPath = path.join(dir, file);
      const relPath = path.relative(PROJECT_ROOT, tsPath);
      try {
        const cachePath = precompileFile(tsPath, relPath);
        const size = fs.statSync(cachePath).size;
        totalFiles++;
        totalSize += size;
        console.log(`  ✓ ${relPath} → ${(size/1024).toFixed(1)} KB`);
      } catch (err) {
        console.error(`  ✗ ${relPath}: ${err.message}`);
      }
    }
  }

  console.log(`\n[precompile] Done! ${totalFiles} files, ${(totalSize/1024/1024).toFixed(2)} MB total`);
  console.log('[precompile] Cache ready at:', CACHE_DIR);
}

main();