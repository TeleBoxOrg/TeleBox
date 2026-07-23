/**
 * TeleBox Panel — config store (assets/panel/config.json).
 * Local-only: assets/* is gitignored.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { JSONFilePreset } from "lowdb/node";
import type { Low } from "lowdb";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import type { PanelAdmin, PanelConfig } from "./types";

const DEFAULT_CONFIG: PanelConfig = {
  enabled: false,
  botToken: "",
  publicBaseUrl: "",
  bindHost: "0.0.0.0",
  bindPort: 8787,
  sessionSecret: "",
  admins: [],
  displayName: "TeleBox Panel",
  updatedAt: 0,
  tunnelMode: "off",
  tunnelUrl: "",
};

let db: Low<PanelConfig> | null = null;
let dbPromise: Promise<Low<PanelConfig>> | null = null;

function configPath(): string {
  return path.join(createDirectoryInAssets("panel"), "config.json");
}

function ensureSecret(cfg: PanelConfig): boolean {
  if (cfg.sessionSecret && cfg.sessionSecret.length >= 24) return false;
  cfg.sessionSecret = crypto.randomBytes(32).toString("hex");
  return true;
}

async function getDb(): Promise<Low<PanelConfig>> {
  if (db) return db;
  if (!dbPromise) {
    dbPromise = (async () => {
      const file = configPath();
      const instance = await JSONFilePreset<PanelConfig>(file, {
        ...DEFAULT_CONFIG,
      });
      let dirty = false;
      // Merge defaults for forward-compat fields.
      const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;
      const data = instance.data as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(defaults)) {
        if (data[k] === undefined) {
          data[k] = v;
          dirty = true;
        }
      }
      if (!Array.isArray(instance.data.admins)) {
        instance.data.admins = [];
        dirty = true;
      }
      if (ensureSecret(instance.data)) dirty = true;
      if (dirty) await instance.write();
      db = instance;
      return instance;
    })();
  }
  return dbPromise;
}

export async function readPanelConfig(): Promise<PanelConfig> {
  const instance = await getDb();
  return { ...instance.data, admins: [...instance.data.admins] };
}

export async function updatePanelConfig(
  patch: Partial<PanelConfig>,
): Promise<PanelConfig> {
  const instance = await getDb();
  const next: PanelConfig = {
    ...instance.data,
    ...patch,
    admins: patch.admins ? [...patch.admins] : [...instance.data.admins],
    updatedAt: Date.now(),
  };
  ensureSecret(next);
  // Normalize token / url
  if (typeof next.botToken === "string") next.botToken = next.botToken.trim();
  if (typeof next.publicBaseUrl === "string") {
    next.publicBaseUrl = next.publicBaseUrl.trim().replace(/\/+$/, "");
  }
  if (!Number.isFinite(next.bindPort) || next.bindPort <= 0) {
    next.bindPort = DEFAULT_CONFIG.bindPort;
  }
  instance.data = next;
  await instance.write();
  return { ...next, admins: [...next.admins] };
}

export async function setPanelEnabled(enabled: boolean): Promise<PanelConfig> {
  return updatePanelConfig({ enabled });
}

export async function setPanelBotToken(token: string): Promise<PanelConfig> {
  return updatePanelConfig({ botToken: token.trim() });
}

export async function listPanelAdmins(): Promise<PanelAdmin[]> {
  const cfg = await readPanelConfig();
  return cfg.admins;
}

export async function addPanelAdmin(
  userId: number,
  note?: string,
): Promise<PanelAdmin[]> {
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error("无效的 userId");
  }
  const cfg = await readPanelConfig();
  if (cfg.admins.some((a) => a.userId === userId)) {
    return cfg.admins;
  }
  const admins = [
    ...cfg.admins,
    { userId, note: note?.trim() || undefined, addedAt: Date.now() },
  ];
  await updatePanelConfig({ admins });
  return admins;
}

export async function removePanelAdmin(userId: number): Promise<PanelAdmin[]> {
  const cfg = await readPanelConfig();
  const admins = cfg.admins.filter((a) => a.userId !== userId);
  await updatePanelConfig({ admins });
  return admins;
}

export function maskToken(token: string): string {
  if (!token) return "(未设置)";
  if (token.length < 12) return "***";
  const [id] = token.split(":");
  return `${id}:••••••••`;
}

/** Invalidate in-memory handle (e.g. after external file rewrite). */
export function resetPanelConfigCache(): void {
  db = null;
  dbPromise = null;
}

export { DEFAULT_CONFIG };
