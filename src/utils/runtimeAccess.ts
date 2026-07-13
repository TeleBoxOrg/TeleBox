/**
 * Late-bound runtime accessors.
 *
 * Breaks the pluginManager ↔ runtimeManager import cycle: pluginManager (and
 * channelGapBreaker / loginManager) import this module only; runtimeManager
 * registers concrete implementations at module load time.
 *
 * Callers must not invoke these before runtimeManager has been required at
 * least once (normal for TeleBox: index → runtimeManager → pluginManager).
 */

export type RuntimeSnapshot = {
  client?: unknown;
  generation?: number;
  meId?: string;
  state?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RuntimeAccess = {
  getCurrentGeneration: () => number;
  // Intentionally loose: TeleBoxRuntime (teleproto/mtcute) is structural.
  tryGetCurrentRuntime: () => any;
  getGlobalClient: () => Promise<any>;
  reloadRuntime: () => Promise<any>;
  startRuntime: () => Promise<any>;
};

let access: RuntimeAccess | null = null;

export function registerRuntimeAccess(impl: RuntimeAccess): void {
  access = impl;
}

function requireAccess(): RuntimeAccess {
  if (!access) {
    throw new Error(
      "Runtime access is not registered yet (runtimeManager not loaded)"
    );
  }
  return access;
}

export function getCurrentGeneration(): number {
  return requireAccess().getCurrentGeneration();
}

export function tryGetCurrentRuntime(): RuntimeSnapshot | null {
  return (requireAccess().tryGetCurrentRuntime() as RuntimeSnapshot | null) ?? null;
}

export async function getGlobalClient(): Promise<unknown> {
  return requireAccess().getGlobalClient();
}

export async function reloadRuntime(): Promise<unknown> {
  return requireAccess().reloadRuntime();
}

export async function startRuntime(): Promise<unknown> {
  return requireAccess().startRuntime();
}
