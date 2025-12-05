import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import { spawn } from "child_process";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { getPrefixes } from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 时区设置
const CN_TIME_ZONE = "Asia/Shanghai";

function formatCN(date: Date): string {
  return date.toLocaleString("zh-CN", { timeZone: CN_TIME_ZONE });
}

async function formatEntity(
  target: any,
  mention?: boolean,
  throwErrorIfFailed?: boolean
) {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");
  if (!target) throw new Error("无效的目标");
  let id: any;
  let entity: any;
  try {
    entity = target?.className
      ? target
      : ((await client?.getEntity(target)) as any);
    if (!entity) throw new Error("无法获取 entity");
    id = entity.id;
    if (!id) throw new Error("无法获取 entity id");
  } catch (e: any) {
    console.error(e);
    if (throwErrorIfFailed)
      throw new Error(
        `无法获取 ${target} 的 entity: ${e?.message || "未知错误"}`
      );
  }
  const displayParts: string[] = [];

  if (entity?.title) displayParts.push(entity.title);
  if (entity?.firstName) displayParts.push(entity.firstName);
  if (entity?.lastName) displayParts.push(entity.lastName);
  if (entity?.username)
    displayParts.push(
      mention ? `@${entity.username}` : `<code>@${entity.username}</code>`
    );

  if (id) {
    displayParts.push(
      entity instanceof Api.User
        ? `<a href="tg://user?id=${id}">${id}</a>`
        : `<a href="https://t.me/c/${id}">${id}</a>`
    );
  } else if (!target?.className) {
    displayParts.push(`<code>${target}</code>`);
  }

  return {
    id,
    entity,
    display: displayParts.join(" ").trim(),
  };
}

// 类型定义
interface BackupConfig {
  target_chat_ids: string[];
}

interface FileInfo {
  file_name: string;
  file_size: number;
  message_id: number;
  chat_id: number;
  date: string;
}

// 配置管理类
class ConfigManager {
  private static db: Low<BackupConfig> | null = null;

  static async getDB(): Promise<Low<BackupConfig>> {
    if (!this.db) {
      const configDir = createDirectoryInAssets("bf");
      const configPath = path.join(configDir, "bf_config.json");
      const adapter = new JSONFile<BackupConfig>(configPath);
      this.db = new Low<BackupConfig>(adapter, { target_chat_ids: [] });
      await this.db.read();
    }
    return this.db;
  }

  static async getTargets(): Promise<string[]> {
    const db = await this.getDB();
    return db.data.target_chat_ids || [];
  }

  static async setTargets(targets: string[]): Promise<void> {
    const db = await this.getDB();
    db.data.target_chat_ids = targets;
    await db.write();
  }

  static async addTargets(newTargets: string[]): Promise<string[]> {
    const current = await this.getTargets();
    const combined = [...new Set([...current, ...newTargets])];
    await this.setTargets(combined);
    return combined;
  }

  static async removeTarget(target: string): Promise<string[]> {
    if (target === "all") {
      await this.setTargets([]);
      return [];
    }
    const current = await this.getTargets();
    const filtered = current.filter((t) => t !== target);
    await this.setTargets(filtered);
    return filtered;
  }
}

// 工具函数
function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9_.-]/g, "_").substring(0, 100);
}

function generateBackupName(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "_");
  const randomId = crypto.randomBytes(4).toString("hex");
  return sanitizeFilename(`telebox_backup_${timestamp}_${randomId}.tar.gz`);
}

// 创建备份压缩包
async function createBackup(dirs: string[], outputPath: string): Promise<void> {
  const tempDir = path.join(
    os.tmpdir(),
    `backup_${crypto.randomBytes(8).toString("hex")}`
  );
  const backupDir = path.join(tempDir, "telebox_backup");

  try {
    // 创建临时目录
    fs.mkdirSync(backupDir, { recursive: true });

    // 复制目录
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;

      const baseName = path.basename(dir);
      const targetDir = path.join(backupDir, baseName);

      copyDirRecursive(dir, targetDir);
    }

    // 创建tar.gz
    await new Promise<void>((resolve, reject) => {
      const tar = spawn("tar", [
        "-czf",
        outputPath,
        "-C",
        tempDir,
        "telebox_backup",
      ]);

      tar.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar exited with code ${code}`));
      });

      tar.on("error", reject);
    });
  } finally {
    // 清理临时目录
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

// 递归复制目录
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 解压备份文件
async function extractBackup(archivePath: string): Promise<string> {
  const extractDir = path.join(os.tmpdir(), `extract_${Date.now()}`);
  fs.mkdirSync(extractDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const tar = spawn("tar", ["-xzf", archivePath, "-C", extractDir]);

    tar.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${code}`));
    });

    tar.on("error", reject);
  });

  return extractDir;
}

// 恢复备份
async function restoreBackup(extractPath: string): Promise<void> {
  const programDir = process.cwd();
  const backupRoot = path.join(extractPath, "telebox_backup");

  if (!fs.existsSync(backupRoot)) {
    throw new Error("无效的备份文件格式");
  }

  // 创建当前状态备份
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const currentBackupDir = path.join(
    programDir,
    `_restore_backup_${timestamp}`
  );
  fs.mkdirSync(currentBackupDir, { recursive: true });

  // 恢复 plugins 和 assets
  const dirs = ["plugins", "assets"];

  for (const dir of dirs) {
    const currentPath = path.join(programDir, dir);
    const backupPath = path.join(backupRoot, dir);
    const savePath = path.join(currentBackupDir, dir);

    // 备份当前目录
    if (fs.existsSync(currentPath)) {
      copyDirRecursive(currentPath, savePath);
      fs.rmSync(currentPath, { recursive: true, force: true });
    }

    // 恢复备份
    if (fs.existsSync(backupPath)) {
      copyDirRecursive(backupPath, currentPath);
    }
  }

  console.log(`恢复完成，原文件备份在: ${currentBackupDir}`);
}

const help_text = `<code>${mainPrefix}bf</code> 备份 plugins + assets 目录
<code>${mainPrefix}bf all</code> - 备份整个程序（包含所有文件）
<code>${mainPrefix}bf set 对话ID</code> - 设置备份发送到的目标对话
<code>${mainPrefix}bf to 对话ID</code> - 仅本次备份发送到目标对话
<code>${mainPrefix}bf del 对话ID/all</code> - 删除备份发送到的目标对话
<code>${mainPrefix}hf</code> 恢复备份`;

// 插件类
class BfPlugin extends Plugin {
  description = `\n📦 备份插件\n\n${help_text}

若想实现定时备份, 可安装并使用 <code>${mainPrefix}tpm i acron</code>
每天2点自动备份(调用 <code>${mainPrefix}bf</code> 命令)

<pre>${mainPrefix}acron cmd 0 0 2 * * * me 定时备份
.bf</pre>
`;

  cmdHandlers = {
    bf: async (msg: Api.Message) => {
      const args = msg.message.slice(1).split(" ").slice(1);
      const cmd = args[0] || "";

      // 设置目标
      if (cmd === "set") {
        if (args.length < 2) {
          await msg.edit({
            text: help_text,
            parseMode: "html",
          });
          return;
        }

        const ids = args
          .slice(1)
          .join(" ")
          .replace(/,/g, " ")
          .split(/\s+/)
          .filter(Boolean);
        const valid = ids
          .filter((id) => /^-?\d+$/.test(id))
          .map((id) => {
            // 自动转换100开头的频道ID为负数
            if (/^100\d+$/.test(id)) {
              return `-${id}`;
            }
            return id;
          });

        if (valid.length === 0) {
          await msg.edit({ text: "❌ 无效的聊天ID", parseMode: "html" });
          return;
        }

        const targets = await ConfigManager.addTargets(valid);
        await msg.edit({
          text: `✅ 目标已更新: ${targets.join(", ") || "无"}`,
          parseMode: "html",
        });
        return;
      }

      // 删除目标
      if (cmd === "del") {
        if (args.length < 2) {
          await msg.edit({
            text: help_text,
            parseMode: "html",
          });
          return;
        }

        const target = args[1];
        const remaining = await ConfigManager.removeTarget(target);

        await msg.edit({
          text:
            target === "all"
              ? "✅ 已清空所有目标"
              : `✅ 已删除 ${target}\n当前目标: ${
                  remaining.join(", ") || "无"
                }`,
          parseMode: "html",
        });
        return;
      }

      // 支持一次性目标: .bf to 对话ID
      let oneTimeTargets: string[] | null = null;
      if (cmd === "to") {
        if (args.length < 2) {
          await msg.edit({
            text: help_text,
            parseMode: "html",
          });
          return;
        }
        const ids = args
          .slice(1)
          .join(" ")
          .replace(/,/g, " ")
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => {
            // 自动转换100开头的频道ID为负数
            if (/^100\d+$/.test(id)) {
              return `-${id}`;
            }
            return id;
          });
        if (ids.length === 0) {
          await msg.edit({ text: "❌ 无效的聊天ID", parseMode: "html" });
          return;
        }
        oneTimeTargets = ids;
      }

      // 执行备份
      const client = await getGlobalClient();

      try {
        await msg.edit({ text: "🔄 正在创建备份...", parseMode: "html" });

        const programDir = process.cwd();
        const backupName = generateBackupName();
        const backupPath = path.join(os.tmpdir(), backupName);

        if (cmd === "all") {
          const parentDir = path.dirname(programDir);
          const dirName = path.basename(programDir);
          
          await new Promise<void>((resolve, reject) => {
            const tar = spawn("tar", [
              "-czvf",
              backupPath,
              "-C",
              parentDir,
              dirName,
            ]);

            tar.on("close", (code) => {
              if (code === 0) resolve();
              else reject(new Error(`tar exited with code ${code}`));
            });

            tar.on("error", reject);
          });
        } else {
          const dirsToBackup = [
            path.join(programDir, "plugins"),
            path.join(programDir, "assets"),
          ].filter(fs.existsSync);

          if (dirsToBackup.length === 0) {
            await msg.edit({
              text: "❌ 没有找到可备份的目录",
              parseMode: "html",
            });
            return;
          }

          await createBackup(dirsToBackup, backupPath);
        }

        await msg.edit({ text: "📤 正在上传备份...", parseMode: "html" });

        const stats = fs.statSync(backupPath);
        const backupType = cmd === "all" ? "全量备份" : "标准备份";
        const contentDesc = cmd === "all" 
          ? "整个程序目录（包含所有文件）"
          : "plugins, assets";
        
        const caption =
          `📦 <b>TeleBox ${backupType}</b>\n\n` +
          `🕐 <b>时间</b>: ${formatCN(new Date())}\n` +
          `📊 <b>大小</b>: ${(stats.size / 1024 / 1024).toFixed(2)} MB\n` +
          `📋 <b>内容</b>: ${contentDesc}`;

        // 上传文件
        const savedTargets = await ConfigManager.getTargets();
        const destinations =
          oneTimeTargets && oneTimeTargets.length > 0
            ? oneTimeTargets
            : savedTargets.length > 0
            ? savedTargets
            : ["me"];
        const destDisplays = [];

        for (const dest of destinations) {
          const { display } = await formatEntity(dest);
          destDisplays.push(display);
          try {
            await client.sendFile(dest, {
              file: backupPath,
              caption,
              forceDocument: true,
              parseMode: "html",
            });
          } catch (err) {
            console.error(`发送到 ${dest} 失败:`, err);
            if (dest !== "me") {
              await client.sendFile("me", {
                file: backupPath,
                caption: `⚠️ 发送到 ${dest} 失败\n\n${caption}`,
                forceDocument: true,
                parseMode: "html",
              });
            }
          }
        }

        // 清理临时文件
        try {
          fs.unlinkSync(backupPath);
        } catch {}

        const backupTypeDisplay = cmd === "all" ? "全量备份" : "备份";
        const contentDisplay = cmd === "all" 
          ? "整个程序目录（包含所有文件）"
          : "plugins, assets";
        
        await msg.edit({
          text:
            `✅ <b>${backupTypeDisplay}完成</b>\n\n` +
            `🎯 <b>发送到</b>: ${destDisplays.join(", ")}\n` +
            `📦 <b>内容</b>: ${contentDisplay}\n` +
            `💾 <b>大小</b>: ${(stats.size / 1024 / 1024).toFixed(2)} MB`,
          parseMode: "html",
        });
      } catch (error) {
        await msg.edit({
          text: `❌ 备份失败: ${String(error)}`,
          parseMode: "html",
        });
      }
    },

    hf: async (msg: Api.Message) => {
      const args = msg.message.slice(1).split(" ").slice(1);
      const cmd = args[0] || "";

      if (cmd === "help" || cmd === "帮助") {
        await msg.edit({
          text:
            "🔄 <b>TeleBox 恢复系统</b>\n\n" +
            "📁 回复备份文件消息，发送 <code>hf</code> 恢复\n" +
            "📦 支持格式: .tar.gz 备份文件\n" +
            "🔄 恢复后会自动重载插件",
          parseMode: "html",
        });
        return;
      }

      if (!msg.replyTo) {
        await msg.edit({
          text: "❌ 请回复一个备份文件消息后使用 <code>hf</code>",
          parseMode: "html",
        });
        return;
      }

      const client = await getGlobalClient();

      try {
        // 获取回复的消息
        const messages = await client.getMessages(msg.peerId, {
          ids: [msg.replyTo.replyToMsgId!],
        });

        const backupMsg = messages[0];
        if (!backupMsg?.file?.name?.endsWith(".tar.gz")) {
          await msg.edit({
            text: "❌ 回复的消息不是有效的备份文件",
            parseMode: "html",
          });
          return;
        }

        await msg.edit({ text: "📥 正在下载备份...", parseMode: "html" });

        // 下载文件
        const tempPath = path.join(os.tmpdir(), `restore_${Date.now()}.tar.gz`);
        const buffer = await client.downloadMedia(backupMsg);

        if (!buffer) {
          throw new Error("下载失败");
        }

        fs.writeFileSync(tempPath, buffer);

        await msg.edit({ text: "📦 正在解压备份...", parseMode: "html" });

        // 解压文件
        const extractPath = await extractBackup(tempPath);

        await msg.edit({ text: "🔄 正在恢复备份...", parseMode: "html" });

        // 恢复备份
        await restoreBackup(extractPath);

        // 清理临时文件
        try {
          fs.unlinkSync(tempPath);
          fs.rmSync(extractPath, { recursive: true, force: true });
        } catch {}

        // 尝试重载插件
        try {
          const pluginManager = require("@utils/pluginManager");
          if (pluginManager.loadPlugins) {
            await pluginManager.loadPlugins();
            await msg.edit({
              text: "✅ 恢复完成并已重载插件",
              parseMode: "html",
            });
          } else {
            await msg.edit({
              text: "✅ 恢复完成，请重启程序",
              parseMode: "html",
            });
          }
        } catch {
          await msg.edit({
            text: "✅ 恢复完成，请重启程序",
            parseMode: "html",
          });
        }
      } catch (error) {
        await msg.edit({
          text: `❌ 恢复失败: ${String(error)}`,
          parseMode: "html",
        });
      }
    },
  };
}

export default new BfPlugin();
