import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { StringSession } from "telegram/sessions";
import input from "input";
import qr from "qrcode-terminal";
import { Logger } from "telegram/extensions";
import { storeStringSession } from "./apiConfig";

Logger.setLevel("error");

const QR_REFRESH_INTERVAL = 2000;
const QR_TIMEOUT_MS = 90_000;

export async function login() {
  console.log("Connecting to Telegram...");

  const client = await getGlobalClient();
  await client.connect();

  if (await client.checkAuthorization()) {
    console.log("✅ Existing session detected. Logged in successfully.");
    return;
  }

  const useQr = await input.text("Use QR code login? [y/N]: ");

  let loggedIn = false;

  if (useQr.trim().toLowerCase() === "y") {
    loggedIn = await loginWithQr(client);
  }

  if (!loggedIn) {
    console.log("Falling back to phone login...");
    await loginWithPhone(client);
  }

  const session = (client.session as StringSession).save();
  storeStringSession(session);

  console.log("✅ Login completed. Session saved.");
}

async function loginWithPhone(client: any) {
  await client.start({
    phoneNumber: async () => await input.text("Enter phone number (+86...): "),
    password: async () => await input.text("Enter 2FA password (if any): "),
    phoneCode: async () => await input.text("Enter the verification code: "),
    onError: (err) => console.error("❌ Login error:", err),
  });
}

async function loginWithQr(client: any): Promise<boolean> {
  console.log("\nRequesting QR login token...");

  const startTime = Date.now();
  let lastToken: string | null = null;
  let lastRenderedSecond = -1;

  while (Date.now() - startTime < QR_TIMEOUT_MS) {
    let result: Api.TypeLoginToken;

    try {
      result = await client.invoke(
        new Api.auth.ExportLoginToken({
          apiId: client.apiId,
          apiHash: client.apiHash,
          exceptIds: [],
        })
      );
    } catch {
      await delay(QR_REFRESH_INTERVAL);
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

      await delay(QR_REFRESH_INTERVAL);
      continue;
    }

    if (result instanceof Api.auth.LoginTokenSuccess) {
      process.stdout.write("\n");
      console.log(`✅ Login successful. Welcome, ${result.user.firstName}.`);
      await client.getMe();
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

function renderProgressBar(remaining: number, total: number) {
  const width = 20;
  const progress = Math.round(((total - remaining) / total) * width);
  const bar =
    "█".repeat(progress) + "░".repeat(Math.max(0, width - progress));

  process.stdout.write(`\r${bar}  ${remaining}s remaining`);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}