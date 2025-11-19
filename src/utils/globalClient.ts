import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { getApiConfig } from "./apiConfig";
import { readAppName } from "./teleboxInfoHelper";
import { logger } from "./logger";

let client: TelegramClient;

async function initializeClient() {
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
}

export async function getGlobalClient(): Promise<TelegramClient> {
  if (!client) {
    await initializeClient();
    return client;
  }
  return client;
}
