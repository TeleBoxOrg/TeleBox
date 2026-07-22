/**
 * TeleBox Panel — built-in settings providers.
 * These register PanelSettingProvider entries for the WebApp settings page.
 */

import { registerPanelSettings, unregisterPanelSettings } from "./settingsRegistry";
import type { PanelSettingField } from "./types";
import { writeEnvKey, createDirectoryInAssets } from "@utils/pathHelpers";
import fs from "fs";
import path from "path";
import { JSONFilePreset } from "lowdb/node";

const BUILTIN_IDS = [
  "panel",
  "prefix",
  "status",
  "alias",
  "sudo",
  "env",
  "tpm",
];

function registerPanelSelf(): void {
  registerPanelSettings({
    id: "panel",
    title: "Panel 面板",
    description: "Bot 小程序面板开关、Token、端口、隧道模式、显示名",
    category: "系统",
    icon: "🎛️",
    getSchema: (): PanelSettingField[] => [
      {
        key: "enabled",
        label: "启用面板",
        type: "boolean",
        description: "开关 Panel HTTP 服务与伴随 Bot",
      },
      {
        key: "botToken",
        label: "Bot Token",
        type: "password",
        description: "从 @BotFather 获取的 Bot Token（留空保持不变）",
        placeholder: "123456:ABC-DEF...",
      },
      {
        key: "webappUrl",
        label: "WebApp 公网地址",
        type: "string",
        description: "Telegram Mini App 入口的 HTTPS URL（手动模式用）",
        placeholder: "https://your-domain.com",
      },
      {
        key: "tunnelMode",
        label: "隧道模式",
        type: "select",
        options: [
          { value: "cloudflare", label: "Cloudflare Tunnel（自动、免费、免域名）" },
          { value: "manual", label: "手动指定 URL" },
          { value: "off", label: "关闭（仅本地访问）" },
        ],
        description: "如何提供 WebApp 公网 HTTPS 入口",
      },
      {
        key: "port",
        label: "本地端口",
        type: "number",
        description: "Panel HTTP 服务监听端口（默认 8787）",
        default: 8787,
        min: 1,
        max: 65535,
      },
      {
        key: "bindHost",
        label: "监听地址",
        type: "select",
        options: [
          { value: "0.0.0.0", label: "0.0.0.0（所有网卡，含局域网/公网）" },
          { value: "127.0.0.1", label: "127.0.0.1（仅本机）" },
        ],
        description: "HTTP 服务绑定的网络接口",
      },
      {
        key: "displayName",
        label: "显示名称",
        type: "string",
        description: "小程序标题栏显示的名称（默认 TeleBox Panel）",
        placeholder: "TeleBox Panel",
      },
    ],
    getValues: async () => {
      try {
        const { readPanelConfig, maskToken } = await import("./configStore");
        const cfg = await readPanelConfig();
        return {
          enabled: cfg.enabled,
          botToken: maskToken(cfg.botToken),
          webappUrl: cfg.publicBaseUrl || "",
          tunnelMode: cfg.tunnelMode || "cloudflare",
          port: cfg.bindPort || 8787,
          bindHost: cfg.bindHost || "0.0.0.0",
          displayName: cfg.displayName || "TeleBox Panel",
        };
      } catch {
        return {
          enabled: false,
          botToken: "",
          webappUrl: "",
          tunnelMode: "cloudflare",
          port: 8787,
          bindHost: "0.0.0.0",
          displayName: "TeleBox Panel",
        };
      }
    },
    setValues: async (patch: Record<string, unknown>) => {
      const { setPanelEnabled, setPanelBotToken, updatePanelConfig } = await import("./configStore");
      if (typeof patch.enabled === "boolean") {
        await setPanelEnabled(patch.enabled);
      }
      if (typeof patch.botToken === "string" && patch.botToken.trim()) {
        await setPanelBotToken(patch.botToken.trim());
      }
      const updates: Record<string, unknown> = {};
      if (typeof patch.webappUrl === "string") updates.publicBaseUrl = patch.webappUrl.trim() || undefined;
      if (typeof patch.tunnelMode === "string") updates.tunnelMode = patch.tunnelMode;
      if (typeof patch.port === "number") updates.bindPort = patch.port;
      if (typeof patch.bindHost === "string") updates.bindHost = patch.bindHost;
      if (typeof patch.displayName === "string") updates.displayName = patch.displayName.trim() || "TeleBox Panel";
      if (Object.keys(updates).length) {
        await updatePanelConfig(updates);
      }
    },
  });
}

function registerPrefix(): void {
  registerPanelSettings({
    id: "prefix",
    title: "命令前缀",
    description: "管理命令触发前缀（如 . / ! 等）",
    category: "系统",
    icon: "🔤",
    getSchema: (): PanelSettingField[] => [
      {
        key: "prefixes",
        label: "前缀列表",
        type: "list",
        itemFields: [
          { key: "prefix", label: "前缀字符", type: "string", placeholder: "." },
        ],
        description: "每行一个前缀字符，首位优先作为主前缀",
      },
    ],
    getValues: async () => {
      try {
        const { getPrefixes } = await import("@utils/pluginManager");
        const prefixes = getPrefixes();
        return { prefixes: prefixes.map((p) => ({ prefix: p })) };
      } catch {
        return { prefixes: [] };
      }
    },
    setValues: async (patch: Record<string, unknown>) => {
      try {
        const { writeEnvKey } = await import("@utils/pathHelpers");
        const { setPrefixes } = await import("@utils/pluginManager");
        const prefixes = ((patch.prefixes as Array<{ prefix: string }>) || [])
          .map((p) => p?.prefix?.trim())
          .filter(Boolean);
        if (!prefixes.length) throw new Error("至少需要一个前缀");
        await setPrefixes(prefixes);
        // Also sync to .env for runtime pick-up
        writeEnvKey("TB_PREFIXES", prefixes.join(" "));
      } catch (e) {
        throw new Error("前缀格式错误: " + (e as Error).message);
      }
    },
  });
}

function registerStatus(): void {
  registerPanelSettings({
    id: "status",
    title: "状态卡片",
    description: "自定义 .status 输出模板与可用标签",
    category: "系统",
    icon: "📋",
    getSchema: (): PanelSettingField[] => [
      {
        key: "template",
        label: "模板内容",
        type: "textarea",
        placeholder: "{botName} 运行中\\n版本: {version}\\n运行: {uptime}",
        description: "可用标签见下方列表",
      },
    ],
    getValues: async () => {
      try {
        const dbPath = path.join(createDirectoryInAssets("status"), "config.json");
        if (!fs.existsSync(dbPath)) return { template: "" };
        try {
          const raw = JSON.parse(fs.readFileSync(dbPath, "utf-8")) as { template?: string };
          return { template: raw.template || "" };
        } catch {
          return { template: "" };
        }
      } catch {
        return { template: "" };
      }
    },
    setValues: async (patch: Record<string, unknown>) => {
      const dbPath = path.join(createDirectoryInAssets("status"), "config.json");
      const db = await JSONFilePreset<{ template?: string }>(dbPath, {});
      if (typeof patch.template === "string") {
        db.data.template = patch.template;
        await db.write();
      }
    },
  });
}

function registerAlias(): void {
  registerPanelSettings({
    id: "alias",
    title: "命令别名",
    description: "管理命令别名映射（原命令 → 目标命令）",
    category: "系统",
    icon: "🔗",
    getSchema: (): PanelSettingField[] => [
      {
        key: "entries",
        label: "别名列表",
        type: "list",
        itemFields: [
          { key: "original", label: "原命令", type: "string", placeholder: "ping" },
          { key: "final", label: "目标命令", type: "string", placeholder: "pong" },
        ],
        description: "每行一个映射：原命令 → 目标命令",
      },
    ],
    getValues: () => {
      try {
        const { AliasDB } = require("@utils/aliasDB") as {
          AliasDB: new () => {
            list: () => Array<{ original: string; final: string }>;
            add: (o: string, f: string) => void;
            remove: (o: string) => void;
            close: () => void;
          };
        };
        const db = new AliasDB();
        try {
          return { entries: db.list().map((e) => ({ original: e.original, final: e.final })) };
        } finally {
          db.close();
        }
      } catch {
        return { entries: [] };
      }
    },
    setValues: async (patch: Record<string, unknown>) => {
      try {
        const { AliasDB } = require("@utils/aliasDB") as {
          AliasDB: new () => {
            list: () => Array<{ original: string; final: string }>;
            add: (o: string, f: string) => void;
            remove: (o: string) => void;
            close: () => void;
          };
        };
        const db = new AliasDB();
        try {
          const entries = (patch.entries as Array<{ original: string; final: string }>) || [];
          const current = db.list();
          current.forEach((e) => db.remove(e.original));
          entries.forEach((e) => {
            if (e && typeof e.original === "string" && typeof e.final === "string") {
              db.add(e.original, e.final);
            }
          });
        } finally {
          db.close();
        }
      } catch (e) {
        throw new Error("别名格式错误: " + (e as Error).message);
      }
    },
  });
}

function registerSudo(): void {
  registerPanelSettings({
    id: "sudo",
    title: "Sudo 用户",
    description: "可使用 userbot 命令的授权用户与对话白名单",
    category: "权限",
    icon: "🛡️",
    getSchema: (): PanelSettingField[] => [
      {
        key: "users",
        label: "Sudo 用户",
        type: "list",
        itemFields: [
          { key: "uid", label: "用户 ID", type: "number", placeholder: "123456789" },
          { key: "username", label: "用户名(可选)", type: "string", placeholder: "username" },
        ],
        description: "每行一个用户：ID + 可选用户名",
      },
      {
        key: "chats",
        label: "对话白名单",
        type: "list",
        itemFields: [
          { key: "id", label: "对话 ID", type: "number", placeholder: "-1001234567890" },
          { key: "name", label: "对话名(可选)", type: "string", placeholder: "群组名称" },
        ],
        description: "每行一个对话：ID + 可选名称（私聊/群组/频道）",
      },
    ],
    getValues: () => {
      try {
        const { SudoDB } = require("@utils/sudoDB") as {
          SudoDB: new () => {
            ls: () => Array<{ uid: number; username: string }>;
            lsChats: () => Array<{ id: number; name: string }>;
            close: () => void;
          };
        };
        const db = new SudoDB();
        try {
          return {
            users: db.ls().map((u) => ({ uid: u.uid, username: u.username })),
            chats: db.lsChats().map((c) => ({ id: c.id, name: c.name })),
          };
        } finally {
          db.close();
        }
      } catch {
        return { users: [], chats: [] };
      }
    },
    setValues: async (patch: Record<string, unknown>) => {
      try {
        const { SudoDB } = require("@utils/sudoDB") as {
          SudoDB: new () => {
            ls: () => Array<{ uid: number; username: string }>;
            lsChats: () => Array<{ id: number; name: string }>;
            add: (uid: number, username: string) => void;
            del: (uid: number) => boolean;
            addChat: (id: number, name: string) => void;
            delChat: (id: number) => boolean;
            close: () => void;
          };
        };
        const db = new SudoDB();
        try {
          // Users
          const users = (patch.users as Array<{ uid: number; username?: string }>) || [];
          const currentUsers = db.ls();
          currentUsers.forEach((u) => db.del(u.uid));
          users.forEach((u) => {
            if (u && typeof u.uid === "number") db.add(u.uid, u.username || "");
          });

          // Chats
          const chats = (patch.chats as Array<{ id: number; name?: string }>) || [];
          const currentChats = db.lsChats();
          currentChats.forEach((c) => db.delChat(c.id));
          chats.forEach((c) => {
            if (c && typeof c.id === "number") db.addChat(c.id, c.name || "");
          });
        } finally {
          db.close();
        }
      } catch (e) {
        throw new Error("Sudo 格式错误: " + (e as Error).message);
      }
    },
  });
}

function registerEnv(): void {
  registerPanelSettings({
    id: "env",
    title: "运行环境",
    description: "常用环境开关（写入 .env）",
    category: "系统",
    icon: "🧩",
    getSchema: (): PanelSettingField[] => [
      {
        key: "TB_CMD_IGNORE_EDITED",
        label: "忽略编辑消息命令",
        type: "boolean",
        description: "对应 TB_CMD_IGNORE_EDITED",
      },
      {
        key: "NODE_ENV",
        label: "NODE_ENV",
        type: "select",
        options: [
          { value: "production", label: "production" },
          { value: "development", label: "development" },
        ],
      },
    ],
    getValues: () => ({
      TB_CMD_IGNORE_EDITED: (process.env.TB_CMD_IGNORE_EDITED || "true").toLowerCase() !== "false",
      NODE_ENV: process.env.NODE_ENV || "production",
    }),
    setValues: async (patch: Record<string, unknown>) => {
      const { writeEnvKey } = await import("@utils/pathHelpers");
      if (patch.TB_CMD_IGNORE_EDITED !== undefined) {
        const v = patch.TB_CMD_IGNORE_EDITED ? "true" : "false";
        process.env.TB_CMD_IGNORE_EDITED = v;
        writeEnvKey("TB_CMD_IGNORE_EDITED", v);
      }
      if (typeof patch.NODE_ENV === "string" && patch.NODE_ENV) {
        process.env.NODE_ENV = patch.NODE_ENV;
        writeEnvKey("NODE_ENV", patch.NODE_ENV);
      }
    },
  });
}

function registerTpm(): void {
  registerPanelSettings({
    id: "tpm",
    title: "TPM 插件管理",
    description: "自定义插件源、批量更新等设置",
    category: "系统",
    icon: "📦",
    getSchema: (): PanelSettingField[] => [
      {
        key: "customSourceUrl",
        label: "自定义插件源 URL",
        type: "string",
        placeholder: "https://raw.githubusercontent.com/.../plugins.json",
        description: "设置后将从该源合并插件列表",
      },
      {
        key: "clearCustomSource",
        label: "一键清空自定义源",
        type: "boolean",
        description: "开启后保存即清空自定义插件源，恢复仅使用官方源",
      },
    ],
    getValues: async () => {
      try {
        const { tpmGetSource } = await import("./tpmService");
        const src = await tpmGetSource();
        return { customSourceUrl: src.custom || "", clearCustomSource: false };
      } catch {
        return { customSourceUrl: "", clearCustomSource: false };
      }
    },
    setValues: async (patch: Record<string, unknown>) => {
      const { tpmSetSource, tpmClearSource } = await import("./tpmService");
      const url = String(patch.customSourceUrl || "").trim();
      if (patch.clearCustomSource === true) {
        await tpmClearSource();
      } else if (url) {
        await tpmSetSource(url);
      }
    },
  });
}

export function registerBuiltinPanelProviders(): void {
  registerPanelSelf();
  registerPrefix();
  registerStatus();
  registerAlias();
  registerSudo();
  registerEnv();
  registerTpm();
}

export function unregisterBuiltinPanelProviders(): void {
  for (const id of BUILTIN_IDS) unregisterPanelSettings(id);
}