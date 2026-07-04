import { Api, TelegramClient } from "teleproto";
import type { GenerationContext } from "@utils/generationContext";
import { safeGetMessages } from "@utils/safeGetMessages";
import { safeGetMe } from "@utils/authGuards";
import { LeechDB } from "./leechDB";
import { serializeLeechMessage } from "./messageSerializer";
import { StructuredLeechLogger, createLeechActionId } from "./structuredLogger";
import { resolveLeechTarget } from "./targetResolver";
import type { LeechChatIdentity, LeechJobSummary, LeechRunOptions, LeechStats } from "./types";

export interface LeechRunResult {
  actionId: string;
  jobId: number;
  chat: LeechChatIdentity;
  savedCount: number;
  scannedCount: number;
  dbPath: string;
  stoppedReason: string;
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("Leech operation aborted");
}

function throwIfAborted(lifecycle?: GenerationContext): void {
  if (lifecycle?.signal.aborted) {
    throw abortError(lifecycle.signal.reason);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LeechService {
  constructor(
    private readonly db: LeechDB,
    private readonly logger: StructuredLeechLogger = new StructuredLeechLogger(db)
  ) {}

  /**
   * Check current Telegram session. The actual login is owned by TeleBox runtime.
   * 检查当前 Telegram Session；真正的登录流程由 TeleBox runtime 负责。
   */
  async checkSession(client: TelegramClient, actor?: string): Promise<{ id?: string; username?: string; name: string }> {
    const actionId = createLeechActionId("leech_session");
    this.logger.log({
      actionId,
      action: "session.check",
      status: "start",
      actor,
    });

    const me = await safeGetMe(client);
    const name = [me?.firstName, me?.lastName].filter(Boolean).join(" ") || me?.username || "unknown";

    this.logger.log({
      actionId,
      action: "session.check",
      status: "success",
      actor,
      details: {
        id: me?.id ? String(me.id) : null,
        username: me?.username ? `@${me.username}` : null,
        name,
      },
    });

    return {
      id: me?.id ? String(me.id) : undefined,
      username: me?.username ? `@${me.username}` : undefined,
      name,
    };
  }

  async runChatLeech(params: {
    client: TelegramClient;
    commandMessage: Api.Message;
    options: LeechRunOptions;
    lifecycle?: GenerationContext;
  }): Promise<LeechRunResult> {
    const actionId = createLeechActionId("leech_chat");
    const { client, commandMessage, options, lifecycle } = params;
    let jobId = 0;
    let savedCount = 0;
    let scannedCount = 0;
    let chat: LeechChatIdentity | undefined;
    let stoppedReason = "completed";

    this.logger.log({
      actionId,
      action: "chat.leech.command",
      status: "start",
      actor: options.actor,
      target: options.targetInput,
      details: {
        range: options.range.label,
        fromTs: options.range.fromTs,
        toTs: options.range.toTs,
        batchSize: options.batchSize,
        limit: options.limit ?? null,
      },
    });

    try {
      throwIfAborted(lifecycle);
      const resolved = await resolveLeechTarget({
        client,
        commandMessage,
        targetInput: options.targetInput,
      });
      chat = resolved.identity;

      jobId = this.db.createJob({
        actionId,
        target: options.targetInput,
        chat,
        range: options.range,
        batchSize: options.batchSize,
        limit: options.limit,
        options: {
          actor: options.actor,
          targetInput: options.targetInput,
        },
      });

      this.logger.log({
        actionId,
        jobId,
        action: "chat.resolve_target",
        status: "success",
        actor: options.actor,
        target: chat.chatId,
        details: { ...chat },
      });

      let offsetId = 0;
      // Telegram offsetDate is exclusive, so +1 second keeps the --to second inclusive.
      // Telegram 的 offsetDate 是排除边界，因此 +1 秒来保证 --to 当秒被包含。
      let offsetDate = options.range.toTs + 1;
      let batchNo = 0;

      while (true) {
        throwIfAborted(lifecycle);
        if (options.limit && savedCount >= options.limit) {
          stoppedReason = "limit_reached";
          break;
        }

        batchNo += 1;
        const fetchLimit = options.limit
          ? Math.max(1, Math.min(options.batchSize, options.limit - savedCount))
          : options.batchSize;

        this.logger.log({
          actionId,
          jobId,
          action: "chat.fetch_batch",
          status: "start",
          actor: options.actor,
          target: chat.chatId,
          details: {
            batchNo,
            offsetId,
            offsetDate,
            fetchLimit,
          },
        });

        const messages = await (lifecycle
          ? lifecycle.runTask(
              async () =>
                await safeGetMessages(client, resolved.entity, {
                  limit: fetchLimit,
                  offsetId,
                  offsetDate,
                }),
              { label: `leech:fetch:${chat.chatId}:batch-${batchNo}` }
            )
          : safeGetMessages(client, resolved.entity, {
              limit: fetchLimit,
              offsetId,
              offsetDate,
            }));

        const batchMessages = messages.filter((message): message is Api.Message => {
          return !!message && typeof (message as any).id === "number";
        });

        this.logger.log({
          actionId,
          jobId,
          action: "chat.fetch_batch",
          status: "success",
          actor: options.actor,
          target: chat.chatId,
          details: {
            batchNo,
            received: batchMessages.length,
          },
        });

        if (batchMessages.length === 0) {
          stoppedReason = "no_more_messages";
          break;
        }

        let reachedFromBoundary = false;
        for (const message of batchMessages) {
          const dateTs = Number((message as any).date || 0);
          scannedCount += 1;

          if (dateTs < options.range.fromTs) {
            reachedFromBoundary = true;
            continue;
          }
          if (dateTs > options.range.toTs) {
            continue;
          }

          const row = serializeLeechMessage(message, chat, jobId);
          if (!row) {
            this.logger.log({
              actionId,
              jobId,
              action: "chat.save_message",
              status: "skipped",
              actor: options.actor,
              target: chat.chatId,
              details: {
                messageId: (message as any).id,
                reason: "serialize_failed",
              },
            });
            continue;
          }

          this.db.upsertMessage(row);
          savedCount += 1;

          if (options.limit && savedCount >= options.limit) {
            stoppedReason = "limit_reached";
            break;
          }
        }

        this.db.updateJobProgress(jobId, savedCount, scannedCount);
        this.logger.log({
          actionId,
          jobId,
          action: "chat.save_batch",
          status: "progress",
          actor: options.actor,
          target: chat.chatId,
          details: {
            batchNo,
            savedCount,
            scannedCount,
          },
        });

        if (reachedFromBoundary) {
          stoppedReason = "from_boundary_reached";
          break;
        }

        const last = batchMessages[batchMessages.length - 1] as any;
        offsetId = Number(last.id);
        offsetDate = Number(last.date || 0);

        if (batchMessages.length < fetchLimit) {
          stoppedReason = "short_batch";
          break;
        }
      }

      this.db.finishJob(jobId, savedCount, scannedCount);
      this.logger.log({
        actionId,
        jobId,
        action: "chat.leech.command",
        status: "success",
        actor: options.actor,
        target: chat.chatId,
        details: {
          savedCount,
          scannedCount,
          stoppedReason,
          dbPath: this.db.dbPath,
        },
      });

      return {
        actionId,
        jobId,
        chat,
        savedCount,
        scannedCount,
        dbPath: this.db.dbPath,
        stoppedReason,
      };
    } catch (error) {
      if (jobId) this.db.failJob(jobId, error, savedCount, scannedCount);
      this.logger.log({
        actionId,
        jobId: jobId || null,
        action: "chat.leech.command",
        status: "error",
        actor: options.actor,
        target: chat?.chatId ?? options.targetInput,
        details: {
          error: errorMessage(error),
          savedCount,
          scannedCount,
        },
      });
      throw error;
    }
  }

  listJobs(limit?: number): LeechJobSummary[] {
    return this.db.listJobs(limit);
  }

  stats(chatId?: string): LeechStats {
    return this.db.stats(chatId);
  }

  get dbPath(): string {
    return this.db.dbPath;
  }
}
