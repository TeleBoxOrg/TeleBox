import fs from "fs";
import path from "path";

const ASSETS_PATH = path.join(process.cwd(), "assets");
const TEMP_PATH = path.join(process.cwd(), "temp");

/**
 * Write or update a key=value pair in .env file.
 * Handles quoting and escaping automatically.
 */
export function writeEnvKey(key: string, value: string): boolean {
  try {
    const envPath = path.join(process.cwd(), ".env");
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
    const line = `${key}="${value.replace(/"/g, '\\"')}"`;
    const re = new RegExp(`^[ \\t]*${key}\\s*=.*$`, "m");
    if (re.test(content)) {
      content = content.replace(re, line);
    } else {
      if (content && !content.endsWith("\n")) content += "\n";
      content += line + "\n";
    }
    fs.writeFileSync(envPath, content, "utf-8");
    return true;
  } catch (e: unknown) {
    console.warn(`[pathHelpers] write .env ${key} failed`, e);
    return false;
  }
}

function createDirectoryInDirectory(name: string, basePath: string): string {
  const filePath = path.join(basePath, name);
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(filePath, { recursive: true });
    return filePath;
  }
  return filePath;
}

function isEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

/**
 * Merge legacy asset directory into the canonical plugin name.
 * - If dest missing/empty and only one legacy exists: rename (atomic-ish).
 * - Else: copy missing files/dirs from each legacy into dest (non-destructive).
 * Does not delete legacy dirs by default (safe for shared-legacy cases).
 */
function migrateAssetDirectory(
  canonical: string,
  legacyNames: string[],
  options?: { removeLegacy?: boolean; basePath?: string },
): string {
  const base = options?.basePath ?? ASSETS_PATH;
  const dest = path.join(base, canonical);
  const removeLegacy = options?.removeLegacy ?? false;

  for (const legacy of legacyNames) {
    if (!legacy || legacy === canonical) continue;
    const src = path.join(base, legacy);
    if (!fs.existsSync(src)) continue;
    try {
      const st = fs.lstatSync(src);
      if (st.isSymbolicLink()) continue;
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }

    if (!fs.existsSync(dest) || isEmptyDir(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) {
        try {
          fs.renameSync(src, dest);
          console.log(`[assets] migrated dir ${legacy} → ${canonical}`);
          continue;
        } catch {
          // cross-device or busy: fall through to copy
        }
      }
    }

    // Merge: copy only paths that do not already exist at dest
    const copyMissing = (from: string, to: string) => {
      fs.mkdirSync(to, { recursive: true });
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const f = path.join(from, entry.name);
        const t = path.join(to, entry.name);
        if (entry.isDirectory()) {
          if (!fs.existsSync(t)) {
            fs.cpSync(f, t, { recursive: true });
          } else {
            copyMissing(f, t);
          }
        } else if (entry.isFile()) {
          if (!fs.existsSync(t)) {
            fs.copyFileSync(f, t);
          }
        }
      }
    };
    try {
      copyMissing(src, dest);
      console.log(`[assets] merged dir ${legacy} → ${canonical}`);
      if (removeLegacy) {
        fs.rmSync(src, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn(`[assets] migrate ${legacy} → ${canonical} failed:`, e);
    }
  }

  return createDirectoryInDirectory(canonical, base);
}

/**
 * Ensure a config/data file lives under the new path; copy from legacy locations if needed.
 */
function migrateAssetFile(
  destFile: string,
  legacyFiles: string[],
  options?: { removeLegacy?: boolean },
): string {
  const removeLegacy = options?.removeLegacy ?? false;
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  if (fs.existsSync(destFile)) return destFile;

  for (const leg of legacyFiles) {
    if (!leg || leg === destFile) continue;
    if (!fs.existsSync(leg)) continue;
    try {
      const st = fs.lstatSync(leg);
      if (!st.isFile()) continue;
      fs.copyFileSync(leg, destFile);
      console.log(`[assets] migrated file ${path.basename(leg)} → ${path.basename(destFile)}`);
      if (removeLegacy) {
        try {
          fs.rmSync(leg, { force: true });
        } catch {
          /* ignore */
        }
      }
      return destFile;
    } catch (e) {
      console.warn(`[assets] migrate file ${leg} failed:`, e);
    }
  }
  return destFile;
}

/**
 * 在 assets 目录下创建一个子目录。
 * 如果目录已存在，则直接返回其路径。
 *
 * @param name - 规范插件名（或子路径，如 `t/cache`）
 * @param legacyNames - 历史目录名（更名遗留），会在创建前自动合并/迁移
 */
function createDirectoryInAssets(name: string, legacyNames: string[] = []): string {
  if (legacyNames.length > 0) {
    return migrateAssetDirectory(name, legacyNames);
  }
  return createDirectoryInDirectory(name, ASSETS_PATH);
}

/**
 * 在临时目录下创建一个子目录。
 */
function createDirectoryInTemp(name: string, legacyNames: string[] = []): string {
  if (legacyNames.length > 0) {
    return migrateAssetDirectory(name, legacyNames, { basePath: TEMP_PATH });
  }
  return createDirectoryInDirectory(name, TEMP_PATH);
}

/**
 * 解析插件配置文件路径：目录用规范名，文件名用规范名，并从历史路径迁移内容。
 */
function resolvePluginAssetFile(options: {
  plugin: string;
  fileName: string;
  legacyDirs?: string[];
  legacyFiles?: Array<{ dir: string; fileName: string }>;
  removeLegacy?: boolean;
}): string {
  const dir = createDirectoryInAssets(options.plugin, options.legacyDirs ?? []);
  const dest = path.join(dir, options.fileName);
  const legs = (options.legacyFiles ?? []).map((x) =>
    path.join(ASSETS_PATH, x.dir, x.fileName),
  );
  return migrateAssetFile(dest, legs, { removeLegacy: options.removeLegacy });
}

export {
  createDirectoryInAssets,
  createDirectoryInTemp,
  migrateAssetDirectory,
  migrateAssetFile,
  resolvePluginAssetFile,
  ASSETS_PATH,
};
