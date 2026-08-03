'use strict';
/**
 * Lightweight TypeScript loader using esbuild transformSync.
 * Replaces tsx at runtime to cut V8 heap waste:
 *   - No inline source-map data URIs
 *   - Minimal CJS interop polyfill vs tsx's bloated wrapper
 *   - Compiled JS is smaller than original TS source retained by tsx
 *   - Shared CJS helpers instead of per-file inlining
 *   - Precompiled plugins skip runtime compilation entirely
 *
 * Path aliases (@utils/*, etc.) are resolved by tsconfig-paths/register,
 * which must be loaded via -r BEFORE this module.
 */
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

// Register ESM loader for dynamic import() with path aliases and .ts files
register(pathToFileURL(path.join(__dirname, 'esbuild-esm-loader.mjs')).href);

// Read target from tsconfig.json once at startup
let target = 'es2020';
try {
  const tsconfig = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'tsconfig.json'), 'utf8')
  );
  if (tsconfig.compilerOptions && tsconfig.compilerOptions.target) {
    target = tsconfig.compilerOptions.target;
  }
} catch {
  // fall back to es2020
}

// Precompiled plugin cache
const PROJECT_ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(PROJECT_ROOT, '.plugin-cache');
const PLUGIN_DIRS = [
  path.join(PROJECT_ROOT, 'plugins'),
  path.join(PROJECT_ROOT, 'src', 'plugin'),
];
const HELPERS_PATH = path.join(__dirname, 'cjs-helpers.js');

// Strip esbuild's inline CJS helpers (replaced by shared cjs-helpers.js module)
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

function getCachedPluginPath(filename) {
  const normalized = path.resolve(filename);
  for (const pluginDir of PLUGIN_DIRS) {
    if (normalized.startsWith(pluginDir + path.sep)) {
      const relPath = path.relative(PROJECT_ROOT, normalized);
      const cachePath = path.join(CACHE_DIR, relPath.replace(/\.ts$/, '.js'));
      if (fs.existsSync(cachePath)) {
        return cachePath;
      }
    }
  }
  return null;
}

/**
 * Compile a .ts (or .tsx) file with esbuild and hand the JS to Node's module system.
 * - Precompiled plugins load cached .js directly (no runtime compilation)
 * - All other .ts files are compiled on-the-fly with shared CJS helpers
 *   (helpers stripped and replaced with a require() for the shared module)
 */
function compileTS(module, filename) {
  // Check for precompiled cache first (plugin files)
  const cachedPath = getCachedPluginPath(filename);
  if (cachedPath) {
    const code = fs.readFileSync(cachedPath, 'utf8');
    module._compile(code, filename);
    return;
  }

  // On-the-fly compilation for non-plugin files
  const source = fs.readFileSync(filename, 'utf8');
  const ext = path.extname(filename);
  const result = esbuild.transformSync(source, {
    loader: ext === '.tsx' ? 'tsx' : 'ts',
    target: target,
    format: 'cjs',
    sourcemap: false,
    sourcefile: filename,
  });

  // Strip inline CJS helpers and inject shared helpers require
  let code = result.code;
  if (code.startsWith('var __')) {
    code = stripHelpers(code);
    const helpersRequire = `const { __create, __defProp, __getOwnPropDesc, __getOwnPropNames, __getProtoOf, __hasOwnProp, __defNormalProp, __export, __copyProps, __toESM, __toCommonJS, __publicField } = require(${JSON.stringify(HELPERS_PATH)});\n`;
    code = helpersRequire + code;
  }

  module._compile(code, filename);
}

require.extensions['.ts'] = compileTS;
require.extensions['.tsx'] = compileTS;