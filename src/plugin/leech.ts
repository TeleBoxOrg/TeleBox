import { Api } from "teleproto";
import { Plugin } from "@utils/pluginBase";
import { getGlobalClient, tryGetCurrentGenerationContext } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { LeechDB } from "@utils/leech/leechDB";
import { LeechService } from "@utils/leech/leechService";
import { StructuredLeechLogger, createLeechActionId } from "@utils/leech/structuredLogger";
import { parseLeechDateRange } from "@utils/leech/dateRange";

const mainPrefix = getPrefixes()[0] || ".";

function htmlEscape(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function splitArgs(input: string): string[] {
  const args: string[] = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input))) {
    args.push((match[1] ?? match[2] ?? match[3]).replace(/\\(["'])/g, "$1"));
  }
  return args;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const shortMap: Record<string, string> = {
    f: "from",
    t: "to",
    l: "limit",
    b: "batch",
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (/^-?\d+$/.test(token)) {
      positional.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const raw = token.slice(2);
      const [key, inlineValue] = raw.split(/=(.*)/s).filter((part) => part !== undefined);
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
      } else if (args[i + 1] && !args[i + 1].startsWith("--")) {
        flags[key] = args[i + 1];
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }

    if (/^-[A-Za-z]$/.test(token)) {
      const key = shortMap[token.slice(1)] || token.slice(1);
      if (args[i + 1]) {
        flags[key] = args[i + 1];
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }

    positional.push(token);
  }

  return { positional, flags };
}

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function flagNumber(flags: Record<string, string | boolean>, key: string): number | undefined {
  const value = flagString(flags, key);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --${key}: ${value}`);
  }
  return parsed;
}

function clampBatch(input?: number): number {
  if (!input) return 100;
  return Math.max(1, Math.min(Math.floor(input), 100));
}

function actorFromMessage(msg: Api.Message): string {
  return String((msg as any).senderId ?? (msg as any).chatId ?? "unknown");
}

const helpText = `<b>TeleBox Leech V1</b>

<code>${mainPrefix}leech login</code> / <code>${mainPrefix}leech session</code>
  检查当前 Telegram session / Check current Telegram session.

<code>${mainPrefix}leech chat here --from 2026-01-01 --to 2026-01-31</code>
  抓取当前聊天日期范围内的消息并保存到 SQLite。

<code>${mainPrefix}leech chat @username --from 2026-01-01 --to 2026-01-31 --limit 500 --batch 100</code>
  抓取指定 chat/group/channel 的消息。target 支持 @username、数字 ID、t.me 链接、here。

<code>${mainPrefix}leech jobs [limit]</code>
  查看最近任务。

<code>${mainPrefix}leech stats</code>
  查看 SQLite 保存统计。

<code>${mainPrefix}leech db</code>
  显示本地 SQLite DB 路径。

所有 action 会输出 JSON structured log，并写入 <code>leech_actions</code> 表。`;

class LeechPlugin extends Plugin {
  description = helpText;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    leech: async (msg) => {
      const args = splitArgs(msg.message.trim());
      const [, subRaw = "help", ...rest] = args;
      const sub = subRaw.toLowerCase();

      const db = new LeechDB();
      const logger = new StructuredLeechLogger(db);
      const service = new LeechService(db, logger);
      const actor = actorFromMessage(msg);
      const commandActionId = createLeechActionId("leech_command");

      try {
        logger.log({
          actionId: commandActionId,
          action: `command.${sub}`,
          status: "start",
          actor,
          target: (msg as any).chatId ? String((msg as any).chatId) : null,
          details: { raw: msg.message },
        });

        if (sub === "help" || sub === "h") {
          await msg.edit({ text: helpText, parseMode: "html" });
          logger.log({
            actionId: commandActionId,
            action: `command.${sub}`,
            status: "success",
            actor,
          });
          return;
        }

        if (sub === "login" || sub === "session") {
          await this.handleSession(msg, service, actor);
          logger.log({
            actionId: commandActionId,
            action: `command.${sub}`,
            status: "success",
            actor,
          });
          return;
        }

        if (sub === "chat" || sub === "group" || sub === "messages") {
          await this.handleChat(msg, service, rest, actor);
          logger.log({
            actionId: commandActionId,
            action: `command.${sub}`,
            status: "success",
            actor,
          });
          return;
        }

        if (sub === "jobs") {
          await this.handleJobs(msg, service, rest);
          logger.log({
            actionId: commandActionId,
            action: "command.jobs",
            status: "success",
            actor,
          });
          return;
        }

        if (sub === "stats") {
          await this.handleStats(msg, service);
          logger.log({
            actionId: commandActionId,
            action: "command.stats",
            status: "success",
            actor,
          });
          return;
        }

        if (sub === "db") {
          await msg.edit({
            text: `🗄️ Leech SQLite DB:\n<code>${htmlEscape(service.dbPath)}</code>`,
            parseMode: "html",
          });
          logger.log({
            actionId: commandActionId,
            action: "command.db",
            status: "success",
            actor,
            details: { dbPath: service.dbPath },
          });
          return;
        }

        await msg.edit({
          text: `❌ Unknown leech subcommand: <code>${htmlEscape(sub)}</code>\n\n${helpText}`,
          parseMode: "html",
        });
        logger.log({
          actionId: commandActionId,
          action: `command.${sub}`,
          status: "skipped",
          actor,
          details: { reason: "unknown_subcommand" },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.log({
          actionId: commandActionId,
          action: `command.${sub}`,
          status: "error",
          actor,
          details: { error: message },
        });
        await msg.edit({
          text: `❌ Leech error:\n<code>${htmlEscape(message)}</code>`,
          parseMode: "html",
        });
      } finally {
        db.close();
      }
    },
  };

  private async handleSession(msg: Api.Message, service: LeechService, actor: string): Promise<void> {
    const client = await getGlobalClient();
    const me = await service.checkSession(client, actor);
    await msg.edit({
      text:
        `✅ Telegram session OK\n` +
        `· ID: <code>${htmlEscape(me.id || "N/A")}</code>\n` +
        `· Username: <code>${htmlEscape(me.username || "N/A")}</code>\n` +
        `· Name: <code>${htmlEscape(me.name)}</code>`,
      parseMode: "html",
    });
  }

  private async handleChat(
    msg: Api.Message,
    service: LeechService,
    args: string[],
    actor: string
  ): Promise<void> {
    const { positional, flags } = parseFlags(args);
    const targetInput = positional[0] || "here";
    const range = parseLeechDateRange(flagString(flags, "from"), flagString(flags, "to"));
    const batchSize = clampBatch(flagNumber(flags, "batch"));
    const limitRaw = flagNumber(flags, "limit");
    const limit = limitRaw && limitRaw > 0 ? Math.floor(limitRaw) : undefined;
    const client = await getGlobalClient();
    const lifecycle = tryGetCurrentGenerationContext() ?? undefined;

    await msg.edit({
      text:
        `⏳ Leech started\n` +
        `· Target: <code>${htmlEscape(targetInput)}</code>\n` +
        `· Range: <code>${htmlEscape(range.label)}</code>\n` +
        `· Batch: <code>${batchSize}</code>\n` +
        `· Limit: <code>${limit ?? "unlimited"}</code>`,
      parseMode: "html",
    });

    const result = await service.runChatLeech({
      client,
      commandMessage: msg,
      lifecycle,
      options: {
        targetInput,
        range,
        batchSize,
        limit,
        actor,
      },
    });

    await msg.edit({
      text:
        `✅ Leech completed\n` +
        `· Job: <code>${result.jobId}</code>\n` +
        `· Chat: <code>${htmlEscape(result.chat.chatTitle)}</code> (${htmlEscape(result.chat.chatId)})\n` +
        `· Type: <code>${htmlEscape(result.chat.chatType)}</code>\n` +
        `· Saved: <code>${result.savedCount}</code>\n` +
        `· Scanned: <code>${result.scannedCount}</code>\n` +
        `· Stop: <code>${htmlEscape(result.stoppedReason)}</code>\n` +
        `· DB: <code>${htmlEscape(result.dbPath)}</code>`,
      parseMode: "html",
    });
  }

  private async handleJobs(msg: Api.Message, service: LeechService, args: string[]): Promise<void> {
    const requestedLimit = Number(args[0] || 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 20))
      : 10;
    const jobs = service.listJobs(limit);
    if (jobs.length === 0) {
      await msg.edit({ text: "📭 No leech jobs yet." });
      return;
    }

    const lines = jobs.map((job) => {
      return [
        `#${job.id}`,
        htmlEscape(job.status),
        htmlEscape(job.chat_title || job.target),
        `saved=${job.saved_count}`,
        `range=${job.from_ts}-${job.to_ts}`,
      ].join(" | ");
    });

    await msg.edit({
      text: `<b>Recent Leech Jobs</b>\n<pre>${lines.join("\n")}</pre>`,
      parseMode: "html",
    });
  }

  private async handleStats(msg: Api.Message, service: LeechService): Promise<void> {
    const stats = service.stats();
    await msg.edit({
      text:
        `<b>Leech SQLite Stats</b>\n` +
        `· Messages: <code>${stats.totalMessages}</code>\n` +
        `· Jobs: <code>${stats.totalJobs}</code>\n` +
        `· First message: <code>${htmlEscape(stats.firstMessageIso || "N/A")}</code>\n` +
        `· Last message: <code>${htmlEscape(stats.lastMessageIso || "N/A")}</code>\n` +
        `· Last job: <code>${htmlEscape(stats.lastJobStatus || "N/A")}</code>\n` +
        `· DB: <code>${htmlEscape(service.dbPath)}</code>`,
      parseMode: "html",
    });
  }
}

export default new LeechPlugin();
