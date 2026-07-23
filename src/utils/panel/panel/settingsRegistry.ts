/**
 * TeleBox Panel — plugin settings registry (hooks for any plugin).
 *
 * Plugins (or built-in adapters) call:
 *   import { registerPanelSettings } from "@utils/panel";
 *   registerPanelSettings({ id, title, getSchema, getValues, setValues });
 *
 * Built-in providers cover core system plugins without modifying them.
 */

import { logger } from "@utils/logger";
import type { PanelSettingField, PanelSettingsProvider } from "./types";
import { getPluginPanelAdapters } from "@utils/pluginManager";

const providers = new Map<string, PanelSettingsProvider>();

export function registerPanelSettings(provider: PanelSettingsProvider): void {
  if (!provider?.id || typeof provider.id !== "string") {
    throw new Error("panel settings provider requires a string id");
  }
  if (typeof provider.getSchema !== "function" || typeof provider.getValues !== "function" || typeof provider.setValues !== "function") {
    throw new Error(`panel settings provider "${provider.id}" missing getSchema/getValues/setValues`);
  }
  providers.set(provider.id, provider);
  logger.info(`[panel] settings provider registered: ${provider.id}`);
}

export function unregisterPanelSettings(id: string): void {
  if (providers.delete(id)) {
    logger.info(`[panel] settings provider removed: ${id}`);
  }
}

export function listPanelSettingsProviders(): PanelSettingsProvider[] {
  return Array.from(providers.values()).sort((a, b) =>
    a.title.localeCompare(b.title, "zh-CN"),
  );
}

export function getPanelSettingsProvider(
  id: string,
): PanelSettingsProvider | undefined {
  return providers.get(id);
}

export async function getProviderSnapshot(id: string): Promise<{
  id: string;
  title: string;
  description?: string;
  category?: string;
  icon?: string;
  schema: PanelSettingField[];
  values: Record<string, unknown>;
}> {
  const p = providers.get(id);
  if (!p) throw new Error(`未找到设置提供者: ${id}`);
  const [schema, values] = await Promise.all([
    Promise.resolve(p.getSchema()),
    Promise.resolve(p.getValues()),
  ]);
  // Redact secret fields in values for UI list (still editable via set).
  const safeValues: Record<string, unknown> = { ...values };
  for (const field of schema) {
    if (field.secret && safeValues[field.key] != null && safeValues[field.key] !== "") {
      safeValues[field.key] = "••••••••";
    }
  }
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    category: p.category,
    icon: p.icon,
    schema,
    values: safeValues,
  };
}

export async function applyProviderValues(
  id: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const p = providers.get(id);
  if (!p) throw new Error(`未找到设置提供者: ${id}`);
  if (!patch || typeof patch !== "object") {
    throw new Error("patch 必须是对象");
  }
  // Don't write redacted placeholders back.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === "••••••••") continue;
    clean[k] = v;
  }
  await p.setValues(clean);
  const snap = await getProviderSnapshot(id);
  return snap.values;
}

export function clearPanelSettingsProviders(): void {
  providers.clear();
}

/** Auto-register all plugin panel adapters (called from controller on startup) */
export function registerPluginPanelAdapters(): void {
  const adapters = getPluginPanelAdapters();
  for (const adapter of adapters) {
    // Wrap adapter into PanelSettingsProvider format
    const provider: PanelSettingsProvider = {
      id: adapter.id,
      title: adapter.title,
      description: adapter.description,
      category: adapter.category || "插件配置",
      icon: adapter.icon || "⚙️",
      getSchema: adapter.getSchema.bind(adapter),
      getValues: adapter.getValues.bind(adapter),
      setValues: adapter.setValues.bind(adapter),
    };
    registerPanelSettings(provider);
  }
}

export function unregisterPluginPanelAdapters(): void {
  const adapters = getPluginPanelAdapters();
  for (const adapter of adapters) {
    unregisterPanelSettings(adapter.id);
  }
}
