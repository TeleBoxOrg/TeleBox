import path from "path";

export type TeleBoxVersion = "teleproto" | "mtcute";

export interface PluginIndexEntry {
  url: string;
  desc?: string;
}

export interface PluginCompatibilityReport {
  common: string[];
  teleprotoOnly: string[];
  mtcuteOnly: string[];
}

export interface MatchedPlugin {
  name: string;
  url: string;
}

export type PluginMigrationStep =
  | { kind: "backup"; plugin: string; from: string; to: string }
  | { kind: "merge-tree"; plugin: string; from: string; to: string };

export type SwitchStep =
  | { kind: "stop"; version: TeleBoxVersion }
  | { kind: "start"; version: TeleBoxVersion }
  | { kind: "wait-ready"; version: TeleBoxVersion; timeoutMs: number }
  | { kind: "rollback-on-failure"; version: TeleBoxVersion };

function normalizedPluginNames(files: string[]): string[] {
  return [...new Set(
    files
      .filter((file) => file.endsWith(".ts"))
      .map((file) => path.basename(file, ".ts"))
      .filter(Boolean),
  )].sort();
}

export function extractTelegramLoginCode(text: string): string | null {
  if (!/(?:login|log\s*in|code|验证码|登录|确认码|confirmation)/i.test(text)) {
    return null;
  }

  const match = text.match(/(?:\d[\s-]?){5,6}/);
  if (!match) return null;

  const code = match[0].replace(/\D/g, "");
  return code.length === 5 || code.length === 6 ? code : null;
}

export function chooseSessionSource(
  externalPath: string | undefined,
  nativePath: string,
): { kind: "native" | "external"; path: string } {
  if (externalPath?.trim()) {
    return { kind: "external", path: externalPath };
  }
  return { kind: "native", path: nativePath };
}

export function verifyTargetIdentity(expectedId: string, actualId: string): void {
  if (String(expectedId) !== String(actualId)) {
    throw new Error(
      `Target identity mismatch: expected ${expectedId}, received ${actualId}`,
    );
  }
}

export function buildCompatibilityReport(
  teleprotoFiles: string[],
  mtcuteFiles: string[],
): PluginCompatibilityReport {
  const teleproto = normalizedPluginNames(teleprotoFiles);
  const mtcute = normalizedPluginNames(mtcuteFiles);
  const teleprotoSet = new Set(teleproto);
  const mtcuteSet = new Set(mtcute);

  return {
    common: teleproto.filter((name) => mtcuteSet.has(name)).map((name) => `${name}.ts`),
    teleprotoOnly: teleproto.filter((name) => !mtcuteSet.has(name)).map((name) => `${name}.ts`),
    mtcuteOnly: mtcute.filter((name) => !teleprotoSet.has(name)).map((name) => `${name}.ts`),
  };
}

export function matchPlugins(
  sourceInstalledFiles: string[],
  sourceIndex: Record<string, PluginIndexEntry>,
  targetIndex: Record<string, PluginIndexEntry>,
): { install: MatchedPlugin[]; unavailable: string[] } {
  const installed = normalizedPluginNames(sourceInstalledFiles);
  const install: MatchedPlugin[] = [];
  const unavailable: string[] = [];

  for (const name of installed) {
    const source = sourceIndex[name];
    const target = targetIndex[name];
    if (source?.url && target?.url) {
      install.push({ name, url: target.url });
    } else {
      unavailable.push(name);
    }
  }

  return { install, unavailable };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeJsonConfig(source: unknown, target: unknown): unknown {
  if (!isPlainObject(source)) {
    return Array.isArray(source) ? structuredClone(source) : source;
  }
  if (!isPlainObject(target)) {
    return structuredClone(source);
  }

  const result: Record<string, unknown> = structuredClone(target);
  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = result[key];
    result[key] = isPlainObject(sourceValue) && isPlainObject(targetValue)
      ? mergeJsonConfig(sourceValue, targetValue)
      : structuredClone(sourceValue);
  }
  return result;
}

export function planPluginDataMigration(options: {
  plugins: string[];
  sourceAssetsRoot: string;
  targetAssetsRoot: string;
  backupRoot: string;
}): PluginMigrationStep[] {
  return [...new Set(options.plugins)].sort().flatMap((plugin) => [
    {
      kind: "backup" as const,
      plugin,
      from: path.join(options.targetAssetsRoot, plugin),
      to: path.join(options.backupRoot, plugin),
    },
    {
      kind: "merge-tree" as const,
      plugin,
      from: path.join(options.sourceAssetsRoot, plugin),
      to: path.join(options.targetAssetsRoot, plugin),
    },
  ]);
}

export function planSwitch(options: {
  source: TeleBoxVersion;
  target: TeleBoxVersion;
  targetSessionReady: boolean;
  timeoutMs: number;
}): SwitchStep[] {
  if (!options.targetSessionReady) {
    throw new Error("Target session is not ready; refusing to stop source version");
  }
  if (options.source === options.target) {
    throw new Error("Source and target versions must differ");
  }
  return [
    { kind: "stop", version: options.source },
    { kind: "start", version: options.target },
    { kind: "wait-ready", version: options.target, timeoutMs: options.timeoutMs },
    { kind: "rollback-on-failure", version: options.source },
  ];
}
