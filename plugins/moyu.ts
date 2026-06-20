import { Plugin } from "@utils/pluginBase";
import { Api, TelegramClient } from "teleproto";
import axios from "axios";
import { CustomFile } from "teleproto/client/uploads.js";

const url = "https://api.52vmy.cn/api/wl/moyu";

const CN_TIME_ZONE = "Asia/Shanghai";

function formatCN(date: Date): string {
  return date.toLocaleString("zh-CN", { timeZone: CN_TIME_ZONE });
}

class MoyuPlugin extends Plugin {

  description: string = "摸鱼日报";
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    moyu: async (msg) => {
      try {
        await msg.edit({ text: "开摸..." });
        const caption = `摸鱼日报 ${formatCN(new Date())}`;

        const res = await axios.get(url, {
          responseType: "arraybuffer",
          validateStatus: () => true,
        });

        const buf = Buffer.from(res.data);
        const file = new CustomFile(`moyu.jpg`, buf.length, "", buf);

        await msg.client?.sendFile(msg.peerId, {
          file,
          caption,
          forceDocument: false,
        });
        await msg.delete();
      } catch (error) {
        console.error("[MoyuPlugin] 执行失败:", error);
        try {
          await msg.edit({ text: "❌ 获取摸鱼日报失败，请稍后重试" });
        } catch (_) {
          /* ignore edit failure */
        }
      }
    },
  };
}

const plugin = new MoyuPlugin();

export default plugin;
