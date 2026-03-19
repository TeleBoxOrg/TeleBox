import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { getPrefixes, loadPlugins } from "@utils/pluginManager";
import fs from "fs";
import path from "path";

const htmlEscape = (t: string) =>
  t.replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" } as any)[m] || m
  );
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const help_text = `🛠 <b>前缀管理</b>

• <code>${htmlEscape(mainPrefix)}prefix</code> - 查看当前前缀
• <code>${htmlEscape(mainPrefix)}prefix set [前缀...]</code> - 设置并持久化
• <code>${htmlEscape(mainPrefix)}prefix add [前缀...]</code> - 追加前缀
• <code>${htmlEscape(mainPrefix)}prefix del [前缀...]</code> - 删除前缀`;

class PrefixPlugin extends Plugin {
  description: string = help_text;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    prefix: async (msg) => {
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts;
      const sub = (args[0] || "").toLowerCase();
      if (!sub) {
        const ps = getPrefixes();
        await msg.edit({
          text: `🔧 当前前缀: ${ps
            .map((p) => `<code>${htmlEscape(p)}</code>`)
            .join(" • ")}\n用法: <code>${htmlEscape(ps[0])}prefix set . ！</code>`,
          parseMode: "html",
        });
        return;
      }
      if (sub === "help" || sub === "h") {
        await msg.edit({ text: help_text, parseMode: "html" });
        return;
      }
      if (
        args[1] &&
        (args[1].toLowerCase() === "help" || args[1].toLowerCase() === "h")
      ) {
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
      }
      if (sub === "del") {
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
      }
      if (sub !== "set" && !base) {
        await msg.edit({ text: help_text, parseMode: "html" });
        return;
      }
      const list = (base ?? args.slice(1)).filter(Boolean);
      if (list.length === 0) {
        await msg.edit({ text: `❌ 参数不足\n\n${help_text}`, parseMode: "html" });
        return;
      }
      const uniq = Array.from(new Set(list));
      // 直接设置前缀以避免缓存问题
      const pluginManager = require("@utils/pluginManager");
      if (pluginManager.setPrefixes) {
        pluginManager.setPrefixes(uniq);
      } else {
        // 备用方案：修改环境变量后重载
        console.log('[prefix] setPrefixes 不可用，使用备用方案');
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
      }
      await loadPlugins();
      await msg.edit({
        text: `✅ 已设置前缀: ${uniq
          .map((p) => `<code>${htmlEscape(p)}</code>`)
          .join(" • ")} ${persisted ? "(已写入 .env)" : "(.env 写入失败, 仅本次生效)"}`,
        parseMode: "html",
      });
    },
  };
}

export default new PrefixPlugin();
