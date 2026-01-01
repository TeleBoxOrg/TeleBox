import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getPrefixes, loadPlugins } from "@utils/pluginManager";
import fs from "fs";
import path from "path";

// HTML转义函数
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" } as any)[m] || m
  );

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const help_text = `🛠️ <b>前缀管理插件</b>

<b>📝 功能描述：</b>
• 动态修改命令前缀
• 支持多个前缀同时使用
• 配置持久化到 .env 文件
• 实时生效无需重启

<b>🔧 使用方法：</b>
• <code>${mainPrefix}prefix</code> - 查看当前前缀
• <code>${mainPrefix}prefix set [前缀...]</code> - 设置并持久化
• <code>${mainPrefix}prefix add [前缀...]</code> - 追加前缀
• <code>${mainPrefix}prefix del [前缀...]</code> - 删除前缀
• <code>${mainPrefix}prefix help</code> - 显示此帮助

<b>💡 示例：</b>
• <code>${mainPrefix}prefix set . !</code> - 设置前缀为 . 和 !
• <code>${mainPrefix}prefix add 。</code> - 添加中文句号作为前缀
• <code>${mainPrefix}prefix del !</code> - 删除 ! 前缀

<b>⚠️ 注意事项：</b>
• 至少保留一个前缀
• 修改后自动重载所有插件`;

class PrefixPlugin extends Plugin {
  name = "prefix";
  description = help_text;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    prefix: async (msg) => {
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts;
      const sub = (args[0] || "").toLowerCase();

      if (!sub || sub === "help" || sub === "h") {
        await msg.edit({ text: help_text, parseMode: "html" });
        return;
      }

      let base: string[] | undefined;
      if (sub === "add") {
        const adds = args.slice(1).filter(Boolean);
        if (adds.length === 0) {
          await msg.edit({ text: `❌ 参数不足\n\n${help_text}`, parseMode: "html" });
          return;
        }
        base = Array.from(new Set([...getPrefixes(), ...adds]));
      } else if (sub === "del") {
        const dels = new Set(args.slice(1).filter(Boolean));
        if (dels.size === 0) {
          await msg.edit({ text: `❌ 参数不足\n\n${help_text}`, parseMode: "html" });
          return;
        }
        base = getPrefixes().filter((p) => !dels.has(p));
        if (base.length === 0) {
          await msg.edit({ text: "❌ 至少保留一个前缀", parseMode: "html" });
          return;
        }
      } else if (sub !== "set") {
        await msg.edit({ text: help_text, parseMode: "html" });
        return;
      }

      const list = (base ?? args.slice(1)).filter(Boolean);
      if (list.length === 0) {
        await msg.edit({ text: `❌ 参数不足\n\n${help_text}`, parseMode: "html" });
        return;
      }

      const uniq = Array.from(new Set(list));
      const pluginManager = require("@utils/pluginManager");
      if (pluginManager.setPrefixes) {
        pluginManager.setPrefixes(uniq);
      } else {
        console.log('[PrefixPlugin] setPrefixes 不可用，使用备用方案');
      }
      
      const value = uniq.join(" ");
      (process.env as any).TB_PREFIX = value;

      let persisted = true;
      try {
        const envPath = path.join(process.cwd(), ".env");
        let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
        const line = `TB_PREFIX="${value}"`;
        if (/^[ \t]*TB_PREFIX\s*=.*$/m.test(content)) {
          content = content.replace(/^[ \t]*TB_PREFIX\s*=.*$/m, line);
        } else {
          if (content && !content.endsWith("\n")) content += "\n";
          content += line + "\n";
        }
        fs.writeFileSync(envPath, content, "utf-8");
      } catch (e) {
        persisted = false;
        console.error("[PrefixPlugin] Failed to persist to .env:", e);
      }

      await loadPlugins();
      await msg.edit({
        text: `✅ 已设置前缀：${uniq.map((p) => `<code>${htmlEscape(p)}</code>`).join(" • ")} ${persisted ? "（已写入 .env）" : "（.env写入失败，仅本次生效）"}`,
        parseMode: "html"
      });
    }
  };
  
  async cleanup(): Promise<void> {
    // Prefix 配置是全局的，不需要插件级清理
    console.log("[PrefixPlugin] Cleanup completed");
  }
}

export default new PrefixPlugin();