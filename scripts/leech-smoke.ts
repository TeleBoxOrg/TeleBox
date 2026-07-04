import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { Api } from "teleproto";
import { LeechDB } from "@utils/leech/leechDB";
import { LeechService } from "@utils/leech/leechService";
import { parseLeechDateRange } from "@utils/leech/dateRange";

type FakeMessage = {
  id: number;
  date: number;
  message: string;
  senderId: string;
  chatId: string;
  peerId: string;
  sender?: {
    username?: string;
    firstName?: string;
    lastName?: string;
  };
};

function unix(date: string): number {
  return Math.floor(new Date(date).getTime() / 1000);
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore missing smoke DB files
    }
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function createFakeMessages(): FakeMessage[] {
  return [
    {
      id: 3,
      date: unix("2026-01-02T10:00:00.000Z"),
      message: "inside range - day 2",
      senderId: "42",
      chatId: "-100999",
      peerId: "-100999",
      sender: { username: "alice", firstName: "Alice" },
    },
    {
      id: 2,
      date: unix("2026-01-01T10:00:00.000Z"),
      message: "inside range - day 1",
      senderId: "43",
      chatId: "-100999",
      peerId: "-100999",
      sender: { username: "bob", firstName: "Bob" },
    },
    {
      id: 1,
      date: unix("2025-12-31T10:00:00.000Z"),
      message: "outside range - old",
      senderId: "44",
      chatId: "-100999",
      peerId: "-100999",
      sender: { username: "carol", firstName: "Carol" },
    },
  ];
}

function createFakeClient(fakeMessages: FakeMessage[]) {
  return {
    async getMe() {
      return new Api.User({
        id: BigInt(123456),
        firstName: "Smoke",
        lastName: "Tester",
        username: "smoke_tester",
      } as any);
    },

    async getEntity() {
      return {
        className: "Channel",
        id: "999",
        title: "Smoke Group",
        username: "smoke_group",
        broadcast: false,
      };
    },

    async getMessages(_entity: unknown, params: { limit?: number; offsetDate?: number; offsetId?: number }) {
      const limit = params.limit ?? 100;
      const offsetDate = params.offsetDate ?? Number.MAX_SAFE_INTEGER;
      const offsetId = params.offsetId || Number.MAX_SAFE_INTEGER;
      return fakeMessages
        .filter((message) => message.date < offsetDate && message.id < offsetId)
        .slice(0, limit);
    },
  };
}

async function runServiceSmoke(): Promise<void> {
  const dbPath = path.join(process.cwd(), "temp", "leech-smoke.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  cleanupDb(dbPath);

  const fakeMessages = createFakeMessages();
  const fakeClient = createFakeClient(fakeMessages);

  // Service-layer smoke / 服务层 smoke：验证核心抓取、保存、日志。
  const db = new LeechDB(dbPath);
  const service = new LeechService(db);
  const result = await service.runChatLeech({
    client: fakeClient as any,
    commandMessage: {
      chatId: "-100999",
      peerId: "-100999",
      senderId: "1",
      message: ".leech chat here --from 2026-01-01 --to 2026-01-02",
    } as any,
    options: {
      targetInput: "here",
      range: parseLeechDateRange("2026-01-01", "2026-01-02"),
      batchSize: 2,
      actor: "smoke",
    },
  });

  assert(result.savedCount === 2, `expected savedCount=2, got ${result.savedCount}`);
  assert(result.scannedCount === 3, `expected scannedCount=3, got ${result.scannedCount}`);
  assert(result.stoppedReason === "from_boundary_reached", `unexpected stop reason: ${result.stoppedReason}`);

  const stats = service.stats("-100999");
  assert(stats.totalMessages === 2, `expected totalMessages=2, got ${stats.totalMessages}`);
  db.close();

  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const actionCount = (sqlite.prepare("SELECT COUNT(*) AS n FROM leech_actions").get() as { n: number }).n;
    const jobCount = (sqlite.prepare("SELECT COUNT(*) AS n FROM leech_jobs").get() as { n: number }).n;
    const messageCount = (sqlite.prepare("SELECT COUNT(*) AS n FROM leech_messages").get() as { n: number }).n;
    assert(actionCount >= 6, `expected >=6 structured action logs, got ${actionCount}`);
    assert(jobCount === 1, `expected 1 job, got ${jobCount}`);
    assert(messageCount === 2, `expected 2 saved messages, got ${messageCount}`);
    console.log("leech service smoke ok", {
      dbPath,
      actionCount,
      jobCount,
      messageCount,
      result,
    });
  } finally {
    sqlite.close();
  }
}

function installFakeGlobalClient(fakeClient: unknown): void {
  const moduleId = require.resolve("@utils/globalClient");
  require.cache[moduleId] = {
    id: moduleId,
    filename: moduleId,
    loaded: true,
    exports: {
      getGlobalClient: async () => fakeClient,
      tryGetCurrentGenerationContext: () => undefined,
      getCurrentGeneration: () => 1,
      getCurrentGenerationContext: () => {
        throw new Error("smoke GenerationContext is not installed");
      },
    },
  } as NodeModule;
}

function makeCommandMessage(text: string, edits: Array<{ text?: string; parseMode?: string }>) {
  return {
    id: 999,
    chatId: "-100999",
    peerId: "-100999",
    senderId: "1",
    message: text,
    text,
    out: true,
    async edit(params: { text?: string; parseMode?: string }) {
      edits.push(params);
      return this;
    },
  };
}

async function runPluginSmoke(): Promise<void> {
  const dbPath = path.join(process.cwd(), "temp", "leech-plugin-smoke.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  cleanupDb(dbPath);
  process.env.TB_LEECH_DB_PATH = dbPath;

  const fakeClient = createFakeClient(createFakeMessages());
  installFakeGlobalClient(fakeClient);

  // Import after monkey-patching @utils/globalClient.
  // 必须在 monkey patch 之后 import 插件，确保命令入口拿到 fake client。
  const plugin = require("../src/plugin/leech").default as {
    cmdHandlers: Record<string, (msg: any) => Promise<void>>;
  };

  const edits: Array<{ text?: string; parseMode?: string }> = [];
  for (const command of [
    ".leech login",
    ".leech chat here --from 2026-01-01 --to 2026-01-02 --batch 2",
    ".leech jobs 5",
    ".leech stats",
    ".leech db",
  ]) {
    await plugin.cmdHandlers.leech(makeCommandMessage(command, edits));
  }

  assert(edits.some((edit) => edit.text?.includes("Telegram session OK")), "login command did not report session OK");
  assert(edits.some((edit) => edit.text?.includes("Leech completed")), "chat command did not complete");
  assert(edits.some((edit) => edit.text?.includes("Recent Leech Jobs")), "jobs command did not render jobs");
  assert(edits.some((edit) => edit.text?.includes("Leech SQLite Stats")), "stats command did not render stats");
  assert(edits.some((edit) => edit.text?.includes("Leech SQLite DB")), "db command did not render db path");

  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const actionCount = (sqlite.prepare("SELECT COUNT(*) AS n FROM leech_actions").get() as { n: number }).n;
    const jobCount = (sqlite.prepare("SELECT COUNT(*) AS n FROM leech_jobs").get() as { n: number }).n;
    const messageCount = (sqlite.prepare("SELECT COUNT(*) AS n FROM leech_messages").get() as { n: number }).n;
    assert(actionCount >= 12, `expected >=12 plugin action logs, got ${actionCount}`);
    assert(jobCount === 1, `expected 1 plugin job, got ${jobCount}`);
    assert(messageCount === 2, `expected 2 plugin messages, got ${messageCount}`);
    console.log("leech plugin smoke ok", {
      dbPath,
      actionCount,
      jobCount,
      messageCount,
      editCount: edits.length,
    });
  } finally {
    sqlite.close();
    delete process.env.TB_LEECH_DB_PATH;
  }
}

/**
 * Local smoke test for SQLite + structured log + date range + plugin command logic.
 * 本地 smoke 测试：不连接 Telegram，验证 SQLite、结构化日志、日期范围、插件命令入口。
 */
async function main(): Promise<void> {
  await runServiceSmoke();
  await runPluginSmoke();
}

main().catch((error) => {
  console.error("leech smoke failed", error);
  process.exit(1);
});
