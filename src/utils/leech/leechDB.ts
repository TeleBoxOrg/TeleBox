import Database from "better-sqlite3";
import path from "path";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { safeJsonStringify } from "./json";
import type {
  LeechActionLogInput,
  LeechJobCreateInput,
  LeechJobSummary,
  LeechStats,
  LeechStoredMessage,
} from "./types";

export class LeechDB {
  private db: Database.Database;
  readonly dbPath: string;

  constructor(dbPath: string = process.env.TB_LEECH_DB_PATH || path.join(createDirectoryInAssets("leech"), "leech.db")) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leech_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_id TEXT NOT NULL,
        target TEXT NOT NULL,
        chat_id TEXT,
        chat_title TEXT,
        chat_type TEXT,
        from_ts INTEGER NOT NULL,
        to_ts INTEGER NOT NULL,
        status TEXT NOT NULL,
        requested_limit INTEGER,
        batch_size INTEGER NOT NULL,
        saved_count INTEGER NOT NULL DEFAULT 0,
        scanned_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT,
        options_json TEXT
      );

      CREATE TABLE IF NOT EXISTS leech_messages (
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        first_job_id INTEGER NOT NULL,
        last_job_id INTEGER NOT NULL,
        date_ts INTEGER NOT NULL,
        date_iso TEXT NOT NULL,
        edit_date_ts INTEGER,
        sender_id TEXT,
        sender_username TEXT,
        sender_name TEXT,
        message_text TEXT,
        raw_json TEXT NOT NULL,
        media_type TEXT,
        reply_to_msg_id INTEGER,
        grouped_id TEXT,
        views INTEGER,
        forwards INTEGER,
        is_out INTEGER NOT NULL DEFAULT 0,
        saved_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_leech_messages_date
        ON leech_messages(chat_id, date_ts);

      CREATE TABLE IF NOT EXISTS leech_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_id TEXT NOT NULL,
        job_id INTEGER,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        actor TEXT,
        target TEXT,
        details_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_leech_actions_action_id
        ON leech_actions(action_id);
    `);
  }

  createJob(input: LeechJobCreateInput): number {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO leech_jobs (
          action_id, target, chat_id, chat_title, chat_type,
          from_ts, to_ts, status, requested_limit, batch_size,
          started_at, options_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`
      )
      .run(
        input.actionId,
        input.target,
        input.chat?.chatId ?? null,
        input.chat?.chatTitle ?? null,
        input.chat?.chatType ?? null,
        input.range.fromTs,
        input.range.toTs,
        input.limit ?? null,
        input.batchSize,
        now,
        safeJsonStringify(input.options ?? {})
      );
    return Number(info.lastInsertRowid);
  }

  updateJobChat(jobId: number, chat: LeechJobCreateInput["chat"]): void {
    if (!chat) return;
    this.db
      .prepare(
        `UPDATE leech_jobs
         SET chat_id = ?, chat_title = ?, chat_type = ?
         WHERE id = ?`
      )
      .run(chat.chatId, chat.chatTitle, chat.chatType, jobId);
  }

  updateJobProgress(jobId: number, savedCount: number, scannedCount: number): void {
    this.db
      .prepare(
        `UPDATE leech_jobs
         SET saved_count = ?, scanned_count = ?
         WHERE id = ?`
      )
      .run(savedCount, scannedCount, jobId);
  }

  finishJob(jobId: number, savedCount: number, scannedCount: number): void {
    this.db
      .prepare(
        `UPDATE leech_jobs
         SET status = 'completed', saved_count = ?, scanned_count = ?, finished_at = ?
         WHERE id = ?`
      )
      .run(savedCount, scannedCount, new Date().toISOString(), jobId);
  }

  failJob(jobId: number, error: unknown, savedCount = 0, scannedCount = 0): void {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    this.db
      .prepare(
        `UPDATE leech_jobs
         SET status = 'failed', saved_count = ?, scanned_count = ?, finished_at = ?, error = ?
         WHERE id = ?`
      )
      .run(savedCount, scannedCount, new Date().toISOString(), message, jobId);
  }

  upsertMessage(message: LeechStoredMessage): void {
    this.db
      .prepare(
        `INSERT INTO leech_messages (
          chat_id, message_id, first_job_id, last_job_id, date_ts, date_iso,
          edit_date_ts, sender_id, sender_username, sender_name, message_text,
          raw_json, media_type, reply_to_msg_id, grouped_id, views, forwards,
          is_out, saved_at
        ) VALUES (
          @chatId, @messageId, @firstJobId, @lastJobId, @dateTs, @dateIso,
          @editDateTs, @senderId, @senderUsername, @senderName, @messageText,
          @rawJson, @mediaType, @replyToMsgId, @groupedId, @views, @forwards,
          @isOut, @savedAt
        )
        ON CONFLICT(chat_id, message_id) DO UPDATE SET
          last_job_id = excluded.last_job_id,
          date_ts = excluded.date_ts,
          date_iso = excluded.date_iso,
          edit_date_ts = excluded.edit_date_ts,
          sender_id = excluded.sender_id,
          sender_username = excluded.sender_username,
          sender_name = excluded.sender_name,
          message_text = excluded.message_text,
          raw_json = excluded.raw_json,
          media_type = excluded.media_type,
          reply_to_msg_id = excluded.reply_to_msg_id,
          grouped_id = excluded.grouped_id,
          views = excluded.views,
          forwards = excluded.forwards,
          is_out = excluded.is_out,
          saved_at = excluded.saved_at`
      )
      .run({
        ...message,
        isOut: message.isOut ? 1 : 0,
      });
  }

  recordAction(input: LeechActionLogInput): void {
    this.db
      .prepare(
        `INSERT INTO leech_actions (
          action_id, job_id, action, status, timestamp, actor, target, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.actionId,
        input.jobId ?? null,
        input.action,
        input.status,
        new Date().toISOString(),
        input.actor ?? null,
        input.target ?? null,
        safeJsonStringify(input.details ?? {})
      );
  }

  listJobs(limit = 10): LeechJobSummary[] {
    return this.db
      .prepare(
        `SELECT *
         FROM leech_jobs
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(Math.max(1, Math.min(limit, 50))) as LeechJobSummary[];
  }

  stats(chatId?: string): LeechStats {
    const messageRow = this.db
      .prepare(
        `SELECT
          COUNT(*) AS totalMessages,
          MIN(date_iso) AS firstMessageIso,
          MAX(date_iso) AS lastMessageIso
         FROM leech_messages
         WHERE (? IS NULL OR chat_id = ?)`
      )
      .get(chatId ?? null, chatId ?? null) as {
      totalMessages: number;
      firstMessageIso?: string | null;
      lastMessageIso?: string | null;
    };

    const jobRow = this.db
      .prepare(
        `SELECT
          COUNT(*) AS totalJobs,
          (SELECT status FROM leech_jobs WHERE (? IS NULL OR chat_id = ?) ORDER BY id DESC LIMIT 1) AS lastJobStatus,
          (SELECT finished_at FROM leech_jobs WHERE (? IS NULL OR chat_id = ?) ORDER BY id DESC LIMIT 1) AS lastJobFinishedAt
         FROM leech_jobs
         WHERE (? IS NULL OR chat_id = ?)`
      )
      .get(
        chatId ?? null,
        chatId ?? null,
        chatId ?? null,
        chatId ?? null,
        chatId ?? null,
        chatId ?? null
      ) as {
      totalJobs: number;
      lastJobStatus?: string | null;
      lastJobFinishedAt?: string | null;
    };

    return {
      chatId,
      totalMessages: Number(messageRow.totalMessages || 0),
      firstMessageIso: messageRow.firstMessageIso ?? null,
      lastMessageIso: messageRow.lastMessageIso ?? null,
      totalJobs: Number(jobRow.totalJobs || 0),
      lastJobStatus: jobRow.lastJobStatus ?? null,
      lastJobFinishedAt: jobRow.lastJobFinishedAt ?? null,
    };
  }

  close(): void {
    this.db.close();
  }
}
