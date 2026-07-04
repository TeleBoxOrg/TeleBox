import { randomUUID } from "crypto";
import type { LeechActionLogInput } from "./types";
import { safeJsonStringify } from "./json";
import type { LeechDB } from "./leechDB";

export function createLeechActionId(prefix = "leech"): string {
  return `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

export class StructuredLeechLogger {
  constructor(private readonly db: LeechDB) {}

  /**
   * Emit one machine-readable log line and persist it to SQLite.
   * 输出一行可机器解析的 JSON 日志，并同步写入 SQLite，方便后续审计/回放。
   */
  log(input: LeechActionLogInput): void {
    const payload = {
      scope: "telebox.leech",
      timestamp: new Date().toISOString(),
      actionId: input.actionId,
      jobId: input.jobId ?? null,
      action: input.action,
      status: input.status,
      actor: input.actor ?? null,
      target: input.target ?? null,
      details: input.details ?? {},
    };

    console.log(safeJsonStringify(payload));

    try {
      this.db.recordAction(input);
    } catch (error) {
      console.error("[LeechStructuredLogger] Failed to persist action log:", error);
    }
  }
}

