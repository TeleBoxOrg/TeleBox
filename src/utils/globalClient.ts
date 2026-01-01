import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { getApiConfig } from "./apiConfig";
import { readAppName } from "./teleboxInfoHelper";
import { logger } from "./logger";

let client: TelegramClient | null = null;

async function initializeClient() {
  let api = await getApiConfig();
  const proxy = api.proxy;
  if (proxy) {
    console.log("使用代理连接 Telegram:", proxy);
  }

  let connectionRetries = 5;
  const envValue = process.env.TB_CONNECTION_RETRIES;
  if (envValue) {
    const parsed = Number(envValue);
    connectionRetries = Number.isInteger(parsed) ? parsed : 5;
  }
  console.log(
    `连接重试次数: ${connectionRetries}, 可使用环境变量 TB_CONNECTION_RETRIES 设置`
  );

  client = new TelegramClient(
    new StringSession(api.session),
    api.api_id!,
    api.api_hash!,
    { connectionRetries, deviceModel: readAppName(), proxy }
  );
  client.setLogLevel(logger.getGramJSLogLevel() as any);

  (global as any).telegramClient = client;
}

export async function getGlobalClient(): Promise<TelegramClient> {
  if (!client) {
    await initializeClient();
    return client!;
  }
  return client;
}

export function getGlobalClientSync(): TelegramClient | null {
  return client || (global as any).telegramClient || null;
}

export function registerEventHandler(
  client: TelegramClient,
  handler: any,
  event: any,
  pluginName: string = 'unknown',
  type: 'command' | 'listen' | 'event' | 'cron' = 'command'
): void {
  client.addEventHandler(handler, event);
}

export async function cleanupGlobalClient(): Promise<void> {
  console.log('[GlobalClient] Starting client cleanup...');
  if (client) {
    try {
      await client.disconnect();
      console.log('[GlobalClient] Client disconnected');
      client = null;
      delete (global as any).telegramClient;
      console.log('[GlobalClient] Client cleanup completed');
    } catch (error) {
      console.error('[GlobalClient] Error during client cleanup:', error);
    }
  }
}