/**
 * TeleBox Panel — help / plugin inventory service.
 */

import fs from "fs";
import path from "path";
import {
  getPluginEntry,
  listCommands,
  getPrefixes,
} from "@utils/pluginManager";
import { AliasDB } from "@utils/aliasDB";
import { readDisplayVersion } from "@utils/teleboxInfoHelper";
import { getPanelSettingsProvider } from "./settingsRegistry";
import type { HelpCommandInfo, LoadedPluginInfo } from "./types";

const SYSTEM_PLUGIN_DIR = path.join(process.cwd(), "src", "plugin");
const USER_PLUGIN_DIR = path.join(process.cwd(), "plugins");

function listSystemPluginNames(): Set<string> {
  try {
    return new Set(
      fs
        .readdirSync(SYSTEM_PLUGIN_DIR)
        .filter((f) => f.endsWith(".ts") && !f.includes(".deployed"))
        .map((f) => f.replace(/\.ts$/, "")),
    );
  } catch {
    return new Set();
  }
}

function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:b|i|u|code|pre|a|blockquote)[^>]*>/gi, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

async function resolveDescription(plugin: {
  description?: unknown;
  name?: string;
}): Promise<string> {
  const d = plugin.description;
  if (!d) return "暂无描述";
  if (typeof d === "string") return stripHtml(d.replace(/\\n/g, "\n"));
  if (typeof d === "function") {
    try {
      const out = await d();
      return typeof out === "string" ? stripHtml(out) : "暂无描述";
    } catch {
      return "描述生成失败";
    }
  }
  return "暂无描述";
}

export async function helpOverview(): Promise<{
  version: string;
  prefixes: string[];
  commandCount: number;
  pluginCount: number;
  systemPluginCount: number;
  userPluginCount: number;
  basicCommands: string[];
  modules: Array<{ name: string; commands: string[] }>;
}> {
  const commands = listCommands();
  const systemNames = listSystemPluginNames();
  const aliasDB = new AliasDB();
  try {
    const seenPlugins = new Map<string, Set<string>>();
    const singles: string[] = [];
    const modules: Array<{ name: string; commands: string[] }> = [];

    for (const cmd of commands) {
      const entry = getPluginEntry(cmd);
      if (!entry?.plugin?.cmdHandlers) continue;
      if ((entry as { original?: string }).original) continue;
      if (cmd.includes(" ")) continue;
      const keys = Object.keys(entry.plugin.cmdHandlers).sort();
      const pname = entry.plugin.name || keys[0] || cmd;
      if (!seenPlugins.has(pname)) {
        seenPlugins.set(pname, new Set(keys));
      } else {
        for (const k of keys) seenPlugins.get(pname)!.add(k);
      }
      if (keys.length === 1 && keys[0] === cmd) singles.push(cmd);
    }

    for (const [name, cmds] of seenPlugins) {
      const list = Array.from(cmds).sort();
      if (list.length > 1) modules.push({ name, commands: list });
    }
    modules.sort((a, b) => a.name.localeCompare(b.name));

    let userPluginCount = 0;
    try {
      userPluginCount = fs
        .readdirSync(USER_PLUGIN_DIR)
        .filter((f) => f.endsWith(".ts") && !f.includes("backup")).length;
    } catch {
      userPluginCount = 0;
    }

    return {
      version: readDisplayVersion(),
      prefixes: getPrefixes(),
      commandCount: commands.length,
      pluginCount: seenPlugins.size,
      systemPluginCount: systemNames.size,
      userPluginCount,
      basicCommands: singles.sort(),
      modules,
    };
  } finally {
    aliasDB.close();
  }
}

export async function helpCommandDetail(
  command: string,
): Promise<HelpCommandInfo | null> {
  const cmd = command.trim().toLowerCase();
  if (!cmd) return null;
  const entry = getPluginEntry(cmd);
  if (!entry?.plugin) return null;

  const aliasDB = new AliasDB();
  try {
    const handlers = Object.keys(entry.plugin.cmdHandlers || {}).sort();
    const aliases = aliasDB.getOriginal(cmd) || [];
    const description = await resolveDescription(entry.plugin);
    const systemNames = listSystemPluginNames();
    const pluginName = entry.plugin.name || handlers[0] || cmd;
    return {
      command: cmd,
      aliases,
      description,
      handlers,
      hasCron: !!(
        entry.plugin.cronTasks && Object.keys(entry.plugin.cronTasks).length
      ),
      pluginName,
      isSystem: systemNames.has(pluginName),
    };
  } finally {
    aliasDB.close();
  }
}

export async function listLoadedPlugins(): Promise<LoadedPluginInfo[]> {
  const commands = listCommands();
  const systemNames = listSystemPluginNames();
  const byPlugin = new Map<
    string,
    {
      plugin: {
        name?: string;
        description?: unknown;
        cmdHandlers: Record<string, unknown>;
        cronTasks?: Record<string, unknown>;
      };
      commands: Set<string>;
    }
  >();

  for (const cmd of commands) {
    const entry = getPluginEntry(cmd);
    if (!entry?.plugin) continue;
    if ((entry as { original?: string }).original) continue;
    const pname =
      entry.plugin.name ||
      Object.keys(entry.plugin.cmdHandlers || {})[0] ||
      cmd;
    let bucket = byPlugin.get(pname);
    if (!bucket) {
      bucket = { plugin: entry.plugin, commands: new Set() };
      byPlugin.set(pname, bucket);
    }
    for (const h of Object.keys(entry.plugin.cmdHandlers || {})) {
      bucket.commands.add(h);
    }
  }

  const out: LoadedPluginInfo[] = [];
  for (const [name, bucket] of byPlugin) {
    const description = await resolveDescription(bucket.plugin);
    out.push({
      name,
      commands: Array.from(bucket.commands).sort(),
      description,
      isSystem: systemNames.has(name),
      hasSettings: !!getPanelSettingsProvider(name),
      hasCron: !!(
        bucket.plugin.cronTasks && Object.keys(bucket.plugin.cronTasks).length
      ),
    });
  }
  return out.sort((a, b) => {
    if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
