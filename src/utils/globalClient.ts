import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { getApiConfig } from "./apiConfig";
import { readAppName } from "./teleboxInfoHelper";
import { logger } from "./logger";

let client: TelegramClient;
let initializingPromise: Promise<TelegramClient> | null = null;
let connectingPromise: Promise<TelegramClient> | null = null;

async function initializeClient(): Promise<TelegramClient> {
  let api = await getApiConfig();
  const proxy = api.proxy;
  if (proxy) {
    console.log("使用代理连接 Telegram:", proxy);
  }
  let connectionRetries = 5; // 默认值
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
  return client;
}

async function ensureClientInitialized(): Promise<TelegramClient> {
  if (client) return client;
  if (!initializingPromise) {
    initializingPromise = initializeClient().finally(() => {
      initializingPromise = null;
    });
  }
  return await initializingPromise;
}

async function ensureClientConnected(): Promise<TelegramClient> {
  const instance = await ensureClientInitialized();
  if (instance.connected) {
    return instance;
  }

  if (!connectingPromise) {
    connectingPromise = (async () => {
      await instance.connect();
      return instance;
    })().finally(() => {
      connectingPromise = null;
    });
  }

  return await connectingPromise;
}

export async function getGlobalClient(): Promise<TelegramClient> {
  return await ensureClientConnected();
}
