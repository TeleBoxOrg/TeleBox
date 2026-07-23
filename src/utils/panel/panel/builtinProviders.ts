/**
 * Built-in Panel settings providers for core TeleBox plugins.
 * These do not modify original plugins — they adapt existing files/APIs.
 */

import fs from "fs";
import path from "path";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import {
  getPrefixes,
  setPrefixes,
  loadPlugins,
} from "@utils/pluginManager";
import { logger } from "@utils/logger";
import {
  registerPanelSettings,
  unregisterPanelSettings,
} from "./settingsRegistry";
import {
  readPanelConfig,
  updatePanelConfig,
  maskToken,
} from "./configStore";
import type { PanelSettingField } from "./types";

const BUILTIN_IDS = [
  "panel",
  "prefix",
  "status",
  "alias",
  "sudo",
  "env",
  "tpm",
] as const;

function writeEnvKey(key: string, value: string): boolean {
  try {
    const envPath = path.join(process.cwd(), ".env");
    let content = fs.existsSync(envPath)
      ? fs.readFileSync(envPath, "utf-8")
      : "";
    const line = `${key}="${value.replace(/"/g, '\\"')}"`;
    const re = new RegExp(`^[ \\t]*${key}\\s*=.*$`, "m");
    if (re.test(content)) content = content.replace(re, line);
    else {
      if (content && !content.endsWith("\n")) content += "\n";
      content += line + "\n";
    }
    fs.writeFileSync(envPath, content, "utf-8");
    return true;
  } catch (e: unknown) {
    logger.warn(`[panel] write .env ${key} failed`, e);
    return false;
  }
}

function registerPanelSelf(): void {
  registerPanelSettings({
    id: "panel",
    title: "Panel 本体",
    description: "管理小程序开关、Bot Token、公网地址与绑定端口",
    category: "系统",
    icon: "🎛️",
    getSchema: (): PanelSettingField[] => [
      {
        key: "enabled",
        label: "启用 Panel",
        type: "boolean",
        description: "关闭后 Bot 与 HTTP 服务会停止",
      },
      {
        key: "botToken",
        label: "Bot Token",
        type: "password",
        secret: true,
        description: "用于小程序的 Bot API Token",
      },
      {
        key: "publicBaseUrl",
        label: "公网 HTTPS 地址",
        type: "string",
        placeholder: "https://panel.example.com",
        description: "Telegram WebApp 必须是 HTTPS 公网 URL",
      },
      {
        key: "bindHost",
        label: "监听地址",
        type: "string",
        default: "0.0.0.0",
      },
      {
        key: "bindPort",
        label: "监听端口",
        type: "number",
        min: 1,
        max: 65535,
        default: 8787,
      },
      {
        key: "displayName",
        label: "显示名称",
        type: "string",
        default: "TeleBox Panel",
      },
    ],
    getValues: async () => {
      const cfg = await readPanelConfig();
      return {
        enabled: cfg.enabled,
        botToken: cfg.botToken ? maskToken(cfg.botToken) : "",
        publicBaseUrl: cfg.publicBaseUrl,
        bindHost: cfg.bindHost,
        bindPort: cfg.bindPort,
        displayName: cfg.displayName,
      };
    },
    setValues: async (patch: Record<string, unknown>) => {
      const next: Record<string, unknown> = { ...patch };
      if (typeof next.botToken === "string" && next.botToken.includes("••••")) {
        delete next.botToken;
      }
      if (typeof next.bindPort === "string") {
        next.bindPort = Number(next.bindPort);
      }
      await updatePanelConfig(next as Parameters<typeof updatePanelConfig>[0]);
      // Hot-apply runtime via controller (dynamic import avoids cycle).
      const { applyPanelRuntimeFromConfig } = await import("./controller");
      await applyPanelRuntimeFromConfig();
    },
  });
}

function registerPrefix(): void {
  registerPanelSettings({
    id: "prefix",
    title: "命令前缀",
    description: "TeleBox 指令前缀（写入 .env TB_PREFIX）",
    category: "系统",
    icon: "❕",
    getSchema: (): PanelSettingField[] => [
      {
        key: "prefixes",
        label: "前缀列表",
        type: "string",
        description: "多个前缀用空格分隔，例如 . ！",
        required: true,
      },
    ],
    getValues: () => ({
      prefixes: getPrefixes().join(" "),
    }),
    setValues: async (patch: Record<string, unknown>) => {
      const raw = String(patch.prefixes ?? "").trim();
      if (!raw) throw new Error("至少保留一个前缀");
      const list = Array.from(
        new Set(raw.split(/\s+/).filter(Boolean)),
      );
      if (list.length === 0) throw new Error("至少保留一个前缀");
      setPrefixes(list);
      process.env.TB_PREFIX = list.join(" ");
      writeEnvKey("TB_PREFIX", list.join(" "));
      await loadPlugins();
    },
  });
}

function registerStatus(): void {
  registerPanelSettings({
    id: "status",
    title: "Status 模板",
    description: "系统状态消息自定义模板",
    category: "系统",
    icon: "📊",
    getSchema: (): PanelSettingField[] => [
      {
        key: "template",
        label: "状态模板",
        type: "textarea",
        description: "支持 {cpu} {mem} {telebox} 等占位符",
      },
    ],
    getValues: async () => {
      const dbPath = path.join(
        createDirectoryInAssets("status"),
        "config.json",
      );
      if (!fs.existsSync(dbPath)) return { template: "" };
      try {
        const raw = JSON.parse(fs.readFileSync(dbPath, "utf-8")) as {
          template?: string;
        };
        return { template: raw.template || "" };
      } catch {
        return { template: "" };
      }
    },
    setValues: async (patch: Record<string, unknown>) => {
      const dbPath = path.join(
        createDirectoryInAssets("status"),
        "config.json",
      );
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
    description: "管理命令别名映射",
    category: "系统",
    icon: "🔗",
    getSchema: (): PanelSettingField[] => [
      {
        key: "entries",
        label: "别名列表 (JSON)",
        type: "textarea",
        description: "格式: {\"原命令\": \"目标命令\"}...",
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
          return { entries: JSON.stringify(db.list(), null, 2) };
        } finally {
          db.close();
        }
      } catch {
        return { entries: "{}" };
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
          const entries = JSON.parse(String(patch.entries || "{}")) as Record<string, string>;
          // Clear and rebuild
          const current = db.list();
          current.forEach((e) => db.remove(e.original));
          Object.entries(entries).forEach(([o, f]) => {
            if (typeof f === "string") db.add(o, f);
          });
        } finally {
          db.close();
        }
      } catch (e) {
        throw new Error("JSON 格式错误: " + (e as Error).message);
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
        label: "Sudo 用户 (JSON)",
        type: "textarea",
        description: "格式: [{ \"uid\": 123456, \"username\": \"user\" }]",
      },
      {
        key: "chats",
        label: "对话白名单 (JSON)",
        type: "textarea",
        description: "格式: [{ \"id\": -100123456, \"name\": \"群组\" }]",
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
            users: JSON.stringify(db.ls(), null, 2),
            chats: JSON.stringify(db.lsChats(), null, 2),
          };
        } finally {
          db.close();
        }
      } catch {
        return { users: "[]", chats: "[]" };
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
          const users = JSON.parse(String(patch.users || "[]")) as Array<{ uid: number; username?: string }>;
          const currentUsers = db.ls();
          currentUsers.forEach((u) => db.del(u.uid));
          users.forEach((u) => {
            if (u && typeof u.uid === "number") db.add(u.uid, u.username || "");
          });

          // Chats
          const chats = JSON.parse(String(patch.chats || "[]")) as Array<{ id: number; name?: string }>;
          const currentChats = db.lsChats();
          currentChats.forEach((c) => db.delChat(c.id));
          chats.forEach((c) => {
            if (c && typeof c.id === "number") db.addChat(c.id, c.name || "");
          });
        } finally {
          db.close();
        }
      } catch (e) {
        throw new Error("JSON 格式错误: " + (e as Error).message);
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
      TB_CMD_IGNORE_EDITED:
        (process.env.TB_CMD_IGNORE_EDITED || "true").toLowerCase() !== "false",
      NODE_ENV: process.env.NODE_ENV || "production",
    }),
    setValues: async (patch: Record<string, unknown>) => {
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
