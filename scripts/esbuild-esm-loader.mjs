/**
 * ESM loader hook for esbuild-register.
 *
 * Handles two things that Node's default ESM resolver can't:
 *  1. tsconfig path aliases (@utils/*, etc.) used in dynamic import()
 *  2. .ts file extension resolution and compilation
 *
 * tsconfig-paths/register only hooks the CJS resolver, so dynamic import()
 * calls with @utils/* specifiers fail without this loader.
 */
import { transformSync } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cwd = process.cwd();
let tsconfigPaths = {};
let target = 'es2020';
try {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(cwd, 'tsconfig.json'), 'utf8'));
  tsconfigPaths = tsconfig.compilerOptions?.paths || {};
  target = tsconfig.compilerOptions?.target || 'es2020';
} catch {
  // defaults
}

const EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];
const INDEX_FILES = EXTS.map((e) => `index${e}`);

function resolveWithExtension(filepath) {
  if (fs.existsSync(filepath) && fs.statSync(filepath).isFile()) return filepath;
  for (const ext of EXTS) {
    const p = filepath + ext;
    if (fs.existsSync(p)) return p;
  }
  // Try directory index
  if (fs.existsSync(filepath) && fs.statSync(filepath).isDirectory()) {
    for (const idx of INDEX_FILES) {
      const p = path.join(filepath, idx);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function resolveAlias(specifier) {
  for (const [pattern, targets] of Object.entries(tsconfigPaths)) {
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -2);
      if (specifier === prefix || specifier.startsWith(prefix + '/')) {
        const rest = specifier === prefix ? '' : specifier.slice(prefix.length + 1);
        for (const t of targets) {
          const resolved = path.join(cwd, t.replace('*', rest));
          const withExt = resolveWithExtension(resolved);
          if (withExt) return withExt;
        }
      }
    } else if (specifier === pattern) {
      for (const t of targets) {
        const resolved = path.join(cwd, t);
        const withExt = resolveWithExtension(resolved);
        if (withExt) return withExt;
      }
    } else if (pattern === '*') {
      for (const t of targets) {
        const resolved = path.join(cwd, t.replace('*', specifier));
        const withExt = resolveWithExtension(resolved);
        if (withExt) return withExt;
      }
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  // 1. Try tsconfig path aliases
  const aliasResolved = resolveAlias(specifier);
  if (aliasResolved) {
    return {
      url: pathToFileURL(aliasResolved).href,
      shortCircuit: true,
      format: aliasResolved.endsWith('.ts') || aliasResolved.endsWith('.tsx')
        ? 'commonjs'
        : undefined,
    };
  }

  // 2. Try relative paths with .ts extension
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const parentDir = path.dirname(fileURLToPath(context.parentURL));
    const resolved = path.resolve(parentDir, specifier);
    const withExt = resolveWithExtension(resolved);
    if (withExt) {
      return {
        url: pathToFileURL(withExt).href,
        shortCircuit: true,
        format: withExt.endsWith('.ts') || withExt.endsWith('.tsx')
          ? 'commonjs'
          : undefined,
      };
    }
  }

  // 3. Fall back to Node's default resolver (npm packages, built-ins, etc.)
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts') || url.endsWith('.tsx')) {
    const filename = fileURLToPath(url);
    const source = fs.readFileSync(filename, 'utf8');
    const result = transformSync(source, {
      loader: url.endsWith('.tsx') ? 'tsx' : 'ts',
      target,
      format: 'cjs',
      sourcemap: false,
      sourcefile: filename,
    });
    return {
      format: 'commonjs',
      source: result.code,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}