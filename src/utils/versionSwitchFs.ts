import fs from "fs";
import path from "path";
import { mergeJsonConfig, type MatchedPlugin } from "./versionSwitchCore";

export interface InstalledPluginJournalEntry {
  name: string;
  targetFile: string;
  backupFile: string;
  targetExisted: boolean;
}

export interface InstalledPluginJournal {
  entries: InstalledPluginJournalEntry[];
}

export interface PluginDataJournalEntry {
  plugin: string;
  targetDir: string;
  backupDir: string;
  targetExisted: boolean;
}

export interface PluginDataJournal {
  entries: PluginDataJournalEntry[];
}

function assertPluginName(name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid plugin name: ${name}`);
  }
}

function ensureRegularTree(root: string): void {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to follow symbolic link: ${root}`);
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(root)) {
      ensureRegularTree(path.join(root, entry));
    }
  }
}

function atomicWrite(file: string, content: string | Buffer, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.switch-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, mode === undefined ? undefined : { mode });
  fs.renameSync(temporary, file);
}

function atomicCopy(source: string, target: string): void {
  const stat = fs.lstatSync(source);
  if (!stat.isFile()) {
    throw new Error(`Expected regular file: ${source}`);
  }
  atomicWrite(target, fs.readFileSync(source), stat.mode);
}

function tryMergeJson(source: string, target: string): boolean {
  if (!target.endsWith(".json") || !fs.existsSync(target)) return false;
  try {
    const sourceValue = JSON.parse(fs.readFileSync(source, "utf8")) as unknown;
    const targetValue = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
    const merged = mergeJsonConfig(sourceValue, targetValue);
    const mode = fs.statSync(target).mode;
    atomicWrite(target, `${JSON.stringify(merged, null, 2)}\n`, mode);
    return true;
  } catch {
    return false;
  }
}

function mergeTree(sourceRoot: string, targetRoot: string): void {
  if (!fs.existsSync(sourceRoot)) return;
  ensureRegularTree(sourceRoot);
  fs.mkdirSync(targetRoot, { recursive: true });

  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = path.join(sourceRoot, entry.name);
    const target = path.join(targetRoot, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to migrate symbolic link: ${source}`);
    }
    if (entry.isDirectory()) {
      mergeTree(source, target);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!tryMergeJson(source, target)) {
      atomicCopy(source, target);
    }
  }
}

export async function installMatchedPlugins(options: {
  matches: MatchedPlugin[];
  targetPluginRepo: string;
  targetPluginsDir: string;
  backupRoot: string;
}): Promise<InstalledPluginJournal> {
  fs.mkdirSync(options.targetPluginsDir, { recursive: true });
  fs.mkdirSync(options.backupRoot, { recursive: true });
  const entries: InstalledPluginJournalEntry[] = [];

  try {
    for (const match of options.matches) {
      assertPluginName(match.name);
      const source = path.join(
        options.targetPluginRepo,
        match.name,
        `${match.name}.ts`,
      );
      if (!fs.existsSync(source)) {
        throw new Error(`Target-native plugin implementation not found: ${source}`);
      }
      const targetFile = path.join(options.targetPluginsDir, `${match.name}.ts`);
      const backupFile = path.join(options.backupRoot, `${match.name}.ts`);
      const targetExisted = fs.existsSync(targetFile);
      if (targetExisted) atomicCopy(targetFile, backupFile);
      entries.push({ name: match.name, targetFile, backupFile, targetExisted });
      atomicCopy(source, targetFile);
    }
  } catch (error) {
    restoreInstalledPlugins({ entries });
    throw error;
  }

  return { entries };
}

export function restoreInstalledPlugins(journal: InstalledPluginJournal): void {
  for (const entry of [...journal.entries].reverse()) {
    fs.rmSync(entry.targetFile, { force: true });
    if (entry.targetExisted) atomicCopy(entry.backupFile, entry.targetFile);
  }
}

export function executePluginDataMigration(options: {
  plugins: string[];
  sourceAssetsRoot: string;
  targetAssetsRoot: string;
  backupRoot: string;
}): PluginDataJournal {
  const entries: PluginDataJournalEntry[] = [];
  fs.mkdirSync(options.backupRoot, { recursive: true });

  try {
    for (const plugin of [...new Set(options.plugins)].sort()) {
      assertPluginName(plugin);
      const sourceDir = path.join(options.sourceAssetsRoot, plugin);
      if (!fs.existsSync(sourceDir)) continue;
      const targetDir = path.join(options.targetAssetsRoot, plugin);
      const backupDir = path.join(options.backupRoot, plugin);
      const targetExisted = fs.existsSync(targetDir);

      ensureRegularTree(sourceDir);
      if (targetExisted) {
        ensureRegularTree(targetDir);
        fs.rmSync(backupDir, { recursive: true, force: true });
        fs.cpSync(targetDir, backupDir, { recursive: true, errorOnExist: false });
      }
      entries.push({ plugin, targetDir, backupDir, targetExisted });
      mergeTree(sourceDir, targetDir);
    }
  } catch (error) {
    restorePluginDataMigration({ entries });
    throw error;
  }

  return { entries };
}

export function restorePluginDataMigration(journal: PluginDataJournal): void {
  for (const entry of [...journal.entries].reverse()) {
    fs.rmSync(entry.targetDir, { recursive: true, force: true });
    if (entry.targetExisted) {
      fs.mkdirSync(path.dirname(entry.targetDir), { recursive: true });
      fs.cpSync(entry.backupDir, entry.targetDir, {
        recursive: true,
        errorOnExist: false,
      });
    }
  }
}

export interface ArchivedPluginEntry {
  name: string;
  reason: string;
  pluginFile?: string;
  assetsDir?: string;
}

export interface UnmatchedArchiveReport {
  sourceVersion: string;
  targetVersion: string;
  archivedAt: string;
  archiveRoot: string;
  entries: ArchivedPluginEntry[];
}

/**
 * Save plugins that exist on the source version but have no counterpart on the
 * target version. Keeps both the plugin source file and assets/<plugin>/ so
 * configs are not lost when switching.
 */
export function archiveUnmatchedPlugins(options: {
  names: string[];
  sourceVersion: string;
  targetVersion: string;
  sourcePluginsDir: string;
  sourceAssetsRoot: string;
  archiveRoot: string;
  reason?: string;
}): UnmatchedArchiveReport {
  const reason = options.reason ?? "target_version_has_no_matching_plugin";
  const entries: ArchivedPluginEntry[] = [];
  fs.mkdirSync(options.archiveRoot, { recursive: true, mode: 0o700 });

  for (const name of [...new Set(options.names)].sort()) {
    assertPluginName(name);
    const entry: ArchivedPluginEntry = { name, reason };
    const srcPlugin = path.join(options.sourcePluginsDir, `${name}.ts`);
    const srcAssets = path.join(options.sourceAssetsRoot, name);
    const destDir = path.join(options.archiveRoot, name);
    fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });

    if (fs.existsSync(srcPlugin) && fs.lstatSync(srcPlugin).isFile()) {
      const destPlugin = path.join(destDir, `${name}.ts`);
      atomicCopy(srcPlugin, destPlugin);
      entry.pluginFile = destPlugin;
    }

    if (fs.existsSync(srcAssets)) {
      ensureRegularTree(srcAssets);
      const destAssets = path.join(destDir, "assets");
      fs.rmSync(destAssets, { recursive: true, force: true });
      fs.cpSync(srcAssets, destAssets, { recursive: true, errorOnExist: false });
      entry.assetsDir = destAssets;
    }

    // Only record if we actually saved something
    if (entry.pluginFile || entry.assetsDir) {
      entries.push(entry);
    }
  }

  const report: UnmatchedArchiveReport = {
    sourceVersion: options.sourceVersion,
    targetVersion: options.targetVersion,
    archivedAt: new Date().toISOString(),
    archiveRoot: options.archiveRoot,
    entries,
  };
  atomicWrite(
    path.join(options.archiveRoot, "manifest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}
