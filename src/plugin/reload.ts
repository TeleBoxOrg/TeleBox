import { Plugin } from "@utils/pluginBase";
import { loadPlugins } from "@utils/pluginManager";
import { Api } from "telegram";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInTemp } from "@utils/pathHelpers";
import fs from "fs";
import path from "path";
import { getGlobalClient } from "@utils/globalClient";
import { exec } from "child_process";
import { promisify } from "util";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const execAsync = promisify(exec);

const exitDir = createDirectoryInTemp("exit");
const exitFile = path.join(exitDir, "msg.json");

const editExitMsg = async () => {
  try {
    const data = fs.readFileSync(exitFile, "utf-8");
    const { messageId, chatId, time } = JSON.parse(data);
    const client = await getGlobalClient();
    if (client) {
      // NOTE: https://docs.telethon.dev/en/stable/concepts/entities.html
      await client.getDialogs();

      await client.editMessage(chatId, {
        message: messageId,
        text: `✅ 重启完成, 耗时 ${Date.now() - time}ms`,
      });
      fs.unlinkSync(exitFile);
    }
  } catch (e) {
    console.error("Failed to edit exit message:", e);
  }
};

if (fs.existsSync(exitFile)) {
  editExitMsg();
}

class ReloadPlugin extends Plugin {
  description:
    | string
    | (() => string)
    | (() => Promise<string>) = `<code>${mainPrefix}reload</code> - 重新加载所有插件
<code>${mainPrefix}exit</code> - 结束进程 若配置了进程管理工具, 将自动重启`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    reload: async (msg) => {
      // Show loading message for better UX
      await msg.edit({ text: "🔄 正在重新加载插件..." });

      try {
        const startTime = Date.now();
        await loadPlugins();
        const loadTime = Date.now() - startTime;
        const timeText =
          loadTime > 1000
            ? `${(loadTime / 1000).toFixed(2)}s`
            : `${loadTime}ms`;
        await msg.edit({
          text: `✅ 插件已重新加载完成 (耗时: ${timeText})`,
        });
      } catch (error) {
        console.error("Plugin reload failed:", error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        await msg.edit({
          text: `❌ 插件重新加载失败\n错误信息: ${errorMessage}\n请检查控制台日志获取详细信息`,
        });
      }
    },
    exit: async (msg) => {
      const result = await msg.edit({
        text: "🔄 结束进程...若配置了进程管理工具, 将自动重启",
      });
      if (result) {
        fs.writeFileSync(
          exitFile,
          JSON.stringify({
            messageId: result.id,
            chatId: result.chatId || result.peerId,
            time: Date.now(),
          }),
          "utf-8"
        );
      }
      process.exit(0);
    },
    pmr: async (msg) => {
      await msg.delete();
      setTimeout(async () => {
        try {
          await execAsync("pm2 restart telebox");
        } catch (error) {
          console.error("PM2 restart failed:", error);
        }
      }, 500);
    },
  };
}

const reloadPlugin = new ReloadPlugin();

export default reloadPlugin;
