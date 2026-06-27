import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { createInterface, Interface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import qr from "qrcode-terminal";
import { storeStringSession } from "./apiConfig";
import { isAuthKeyUnregisteredError, safeCheckAuthorization, safeGetMe } from "./authGuards";
import type { GenerationContext } from "./generationContext";


const QR_REFRESH_INTERVAL = 2000;
const QR_TIMEOUT_MS = 90_000;

// 创建 readline 接口
let rl: Interface | null = null;

// 获取 readline 接口的辅助函数
function getReadlineInterface(): Interface {
  if (!rl) {
    rl = createInterface({ input, output });
  }
  return rl;
}

// 关闭 readline 接口
function closeReadlineInterface(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("Login operation aborted");
}

function throwIfAborted(lifecycle?: GenerationContext): void {
  if (lifecycle?.signal.aborted) {
    throw abortError(lifecycle.signal.reason);
  }
}

// 获取用户输入的辅助函数
async function getUserInput(prompt: string, lifecycle?: GenerationContext): Promise<string> {
  throwIfAborted(lifecycle);
  const readline = getReadlineInterface();
  if (!lifecycle) {
    return await readline.question(prompt);
  }

  return await lifecycle.runTask(async (signal) => {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const dispose = lifecycle.trackDisposable(() => closeReadlineInterface(), {
        label: "login:readline-question",
      });

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        void Promise.resolve(dispose()).catch((error) => {
          console.error("[LOGIN] Readline cleanup failed:", error);
        });
        callback();
      };

      const onAbort = (): void => {
        finish(() => reject(abortError(signal.reason)));
      };

      signal.addEventListener("abort", onAbort, { once: true });
      readline.question(prompt).then(
        (answer) => finish(() => resolve(answer)),
        (error: unknown) => finish(() => reject(error))
      );

      if (signal.aborted) {
        onAbort();
      }
    });
  }, { label: "login:readline-question" });
}

export async function initializeClientSession(
  client: TelegramClient,
  lifecycle?: GenerationContext
): Promise<{ meId?: string }> {
  console.log("Connecting to Telegram...");

  throwIfAborted(lifecycle);
  await client.connect();
  throwIfAborted(lifecycle);

  try {
    if (await safeCheckAuthorization(client)) {
      console.log("✅ Existing session detected. Logged in successfully.");
      closeReadlineInterface();
      const me = await safeGetMe(client);
      return { meId: me?.id ? String(me.id) : undefined };
    }
  } catch (error) {
    if (!isAuthKeyUnregisteredError(error)) {
      throw error;
    }

    console.warn(
      "⚠️ Stored session is no longer valid. Clearing it and starting a fresh login."
    );
    await resetBrokenSession(client);
    throwIfAborted(lifecycle);
  }

  const useQr = await getUserInput("Use QR code login? [y/N]: ", lifecycle);

  let loggedIn = false;

  if (useQr.trim().toLowerCase() === "y") {
    loggedIn = await loginWithQr(client, lifecycle);
  }

  if (!loggedIn) {
    throwIfAborted(lifecycle);
    console.log("Falling back to phone login...");
    await loginWithPhone(client, lifecycle);
  }

  throwIfAborted(lifecycle);
  const session = (client.session as StringSession).save();
  storeStringSession(session);

  console.log("✅ Login completed. Session saved.");
  closeReadlineInterface();
  const me = await safeGetMe(client);
  return { meId: me?.id ? String(me.id) : undefined };
}

export async function login(): Promise<void> {
  const { startRuntime }: typeof import("./runtimeManager") = require("./runtimeManager");
  await startRuntime();
}

async function loginWithPhone(client: TelegramClient, lifecycle?: GenerationContext): Promise<void> {
  throwIfAborted(lifecycle);
  await client.start({
    phoneNumber: async () => await getUserInput("Enter phone number (+86...): ", lifecycle),
    password: async () => await getUserInput("Enter 2FA password (if any): ", lifecycle),
    phoneCode: async () => await getUserInput("Enter the verification code: ", lifecycle),
    onError: (err: Error) => {
      console.error("❌ Login error:", err);
      closeReadlineInterface();
    },
  });
  throwIfAborted(lifecycle);
}

async function loginWithQr(client: TelegramClient, lifecycle?: GenerationContext): Promise<boolean> {
  console.log("\nRequesting QR login token...");

  const startTime = Date.now();
  let lastToken: string | null = null;
  let lastRenderedSecond = -1;

  while (Date.now() - startTime < QR_TIMEOUT_MS) {
    throwIfAborted(lifecycle);
    let result: Api.auth.LoginToken | Api.auth.LoginTokenSuccess | Api.auth.LoginTokenMigrateTo;

    try {
      result = await client.invoke(
        new Api.auth.ExportLoginToken({
          apiId: client.apiId,
          apiHash: client.apiHash,
          exceptIds: [],
        })
      );
      throwIfAborted(lifecycle);
    } catch {
      await delay(QR_REFRESH_INTERVAL, lifecycle, "login:qr-refresh-retry");
      continue;
    }

    if (result instanceof Api.auth.LoginToken) {
      const token = result.token.toString("base64url");

      if (token !== lastToken) {
        lastToken = token;

        console.log("\nScan this QR code using Telegram:");
        console.log("Settings → Devices → Link Desktop Device\n");

        qr.generate(`tg://login?token=${token}`, { small: true });
      }

      const elapsed = Date.now() - startTime;
      const remaining = Math.max(
        0,
        Math.ceil((QR_TIMEOUT_MS - elapsed) / 1000)
      );

      if (remaining !== lastRenderedSecond) {
        renderProgressBar(remaining, QR_TIMEOUT_MS / 1000);
        lastRenderedSecond = remaining;
      }

      await delay(QR_REFRESH_INTERVAL, lifecycle, "login:qr-refresh");
      continue;
    }

    if (result instanceof Api.auth.LoginTokenSuccess) {
      process.stdout.write("\n");
      const me = await client.getMe();
      const name = me && "firstName" in me ? me.firstName : "";
      console.log(`✅ Login successful. Welcome, ${name}.`);
      return true;
    }

    if (result instanceof Api.auth.LoginTokenMigrateTo) {
      console.error(
        `\n❌ Account is located in another DC (DC ${result.dcId}).`
      );
      return false;
    }
  }

  process.stdout.write("\n");
  console.warn("⚠️ QR login timed out.");
  return false;
}

function renderProgressBar(remaining: number, total: number): void {
  const width = 20;
  const progress = Math.round(((total - remaining) / total) * width);
  const bar =
    "█".repeat(progress) + "░".repeat(Math.max(0, width - progress));

  process.stdout.write(`\r${bar}  ${remaining}s remaining`);
}

function delay(ms: number, lifecycle?: GenerationContext, label = "login:delay"): Promise<void> {
  if (lifecycle) {
    return lifecycle.delay(ms, { label });
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}


async function resetBrokenSession(client: TelegramClient): Promise<void> {
  try {
    await client.disconnect();
  } catch (e) {
    console.warn("[LOGIN] disconnect() error during session reset:", e);
  }

  try {
    await client.destroy();
  } catch (e) {
    console.warn("[LOGIN] destroy() error during session reset:", e);
  }

  (client.session as StringSession).delete();
  storeStringSession("");
  await client.connect();
}

