import "dotenv/config";
import { logger } from "@utils/logger"; // 引入 logger 以便尽早初始化
import { login } from "@utils/loginManager";
import { loadPlugins } from "@utils/pluginManager";
import { patchMsgEdit } from "hook/listen";
import "./hook/patches/telegram.patch";

// patchMsgEdit();

async function run() {
  await login();
  await loadPlugins();
}

run();
