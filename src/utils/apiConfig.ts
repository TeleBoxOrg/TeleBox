import fs from "fs";
import path from "path";
import readline from "readline";

interface TelegramAPI {
  api_id?: number;
  api_hash?: string;
  session?: string;
  proxy?: any;
  connectionRetries?: number;
}

const CONFIG_PATH = path.join(process.cwd(), "config.json");

function ensureConfigFileExists(): void {
  if (!fs.existsSync(CONFIG_PATH) || fs.statSync(CONFIG_PATH).size === 0) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2), "utf-8");
  }
}

function loadConfig(): TelegramAPI {
  ensureConfigFileExists();
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("❌ 无法读取 config.json:", e);
    return {};
  }
}

function saveConfig(config: TelegramAPI): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

function promptInput(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function storeStringSession(session: string): void {
  const config = loadConfig();
  config.session = session;
  saveConfig(config);
}

async function initConfig(): Promise<TelegramAPI> {
  const config = loadConfig();

  let { api_id, api_hash } = config;

  if (!api_id || !api_hash) {
    // 缺失时，提示输入
    if (!api_id) {
      let input: string;
      while (true) {
        input = await promptInput("请输入 API_ID: ");
        if (input) break; // 输入有效，跳出循环
        console.error("❌ API_ID 不能为空，请重新输入。");
      }
      api_id = parseInt(input);
    }

    if (!api_hash) {
      let input: string;
      while (true) {
        input = await promptInput("请输入 API_HASH: ");
        if (input) break; // 输入有效，跳出循环
        console.error("❌ API_HASH 不能为空，请重新输入。");
      }
      api_hash = input;
    }

    const newConfig: TelegramAPI = { api_id, api_hash };
    saveConfig(newConfig);
    return newConfig;
  }

  return config;
}

let configPromise: Promise<TelegramAPI> | null = null;

function getApiConfig(): Promise<TelegramAPI> {
  if (!configPromise) {
    configPromise = initConfig();
  }
  return configPromise;
}

export { getApiConfig, storeStringSession };
