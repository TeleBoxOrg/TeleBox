import { listCommands, getPluginEntry, getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import fs from "fs";
import path from "path";
import { Api } from "telegram";
import { AliasDB } from "@utils/aliasDB";

// HTML转义函数
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" } as any)[m] || m
  );

// Entity 规划器：管理Telegram 100个Entity限制
class EntityPlanner {
  private readonly LIMIT = 95;
  private used = 0;

  consume(count: number) {
    this.used += count;
  }

  canFit(count: number): boolean {
    return this.used + count <= this.LIMIT;
  }
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
    return pkg.version || "未知版本";
  } catch {
    return "未知版本";
  }
}

function formatCommandsSafely(commands: string[], aliasDB: AliasDB, prefix: string, planner: EntityPlanner): { text: string } {
  const result: string[] = [];
  for (const cmd of commands) {
    const alias = aliasDB.getOriginal(cmd) || [];
    const need = 1 + alias.length;
    let text = "";
    if (planner.canFit(need)) {
      planner.consume(1);
      text = `<code>${prefix}${htmlEscape(cmd)}</code>`;
      if (alias.length) {
        const aliasText = alias.map((a) => {
          planner.consume(1);
          return `<code>${htmlEscape(a)}</code>`;
        }).join(", ");
        text += ` (${aliasText})`;
      }
    } else {
      text = `${prefix}${cmd}`;
      if (alias.length) text += ` (${alias.join(", ")})`;
    }
    result.push(text);
  }
  return { text: result.join(" • ") };
}

function formatBasicCommands(commands: string[], planner: EntityPlanner): { text: string } {
  const aliasDB = new AliasDB();
  const singles: string[] = [];
  for (const cmd of commands.sort()) {
    const entry = getPluginEntry(cmd);
    if (!entry?.plugin?.cmdHandlers) continue;
    const keys = Object.keys(entry.plugin.cmdHandlers);
    if (keys.length === 1 && keys[0] === cmd) singles.push(cmd);
  }
  planner.consume(1);
  const { text } = formatCommandsSafely(singles, aliasDB, "", planner);
  aliasDB.close();
  if (!text) return { text: "暂无基础命令" };
  return { text: `📋 <b>基础命令：</b> ${text}` };
}

function formatModuleCommands(commands: string[], planner: EntityPlanner): { text: string } {
  const aliasDB = new AliasDB();
  const groups = new Map<string, string[]>();

  for (const cmd of commands.sort()) {
    const entry = getPluginEntry(cmd);
    if (!entry?.plugin?.cmdHandlers) continue;
    const keys = Object.keys(entry.plugin.cmdHandlers).sort();
    if (keys.length > 1) groups.set(keys[0], keys);
  }

  if (!groups.size) {
    aliasDB.close();
    return { text: "" };
  }

  planner.consume(3);
  for (const _ of groups.keys()) {
    if (planner.canFit(1)) planner.consume(1);
  }

  const lines: string[] = [];
  for (const [main, subs] of groups) {
    const { text } = formatCommandsSafely(subs, aliasDB, "", planner);
    lines.push(`<b>${htmlEscape(main)}：</b> ${text}`);
  }

  aliasDB.close();
  return {
    text: `🔧 <b>功能模块：</b>\n<blockquote expandable>${lines.join("\n")}\n</blockquote>`
  };
}

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

class HelpPlugin extends Plugin {
  name = "help";
  description = "📖 帮助系统 - 显示所有可用命令和插件信息";

  cmdHandlers = {
    help: this.handleHelp.bind(this),
    h: this.handleHelp.bind(this)
  };

  private async handleHelp(msg: Api.Message) {
    try {
      const args = msg.text.split(" ").slice(1);
      const commands = listCommands();

      // 主帮助信息（消息1）
      if (args.length === 0) {
        const mainPlanner = new EntityPlanner();
        mainPlanner.consume(1 + prefixes.length + 1 + 2 + 4);

        const header = `🚀 <b>TeleBox v${htmlEscape(readVersion())}</b> | 共 ${commands.length} 个命令`;
        const basic = formatBasicCommands(commands, mainPlanner);
        const prefixLine = `❕ <b>指令前缀：</b> ${prefixes.map((p) => `<code>${htmlEscape(p)}</code>`).join(" • ")}`;
        const helpTip = `💡 <code>${mainPrefix}help [命令]</code> 查看详情 | <code>${mainPrefix}tpm search</code> 显示远程插件`;
        const links = `🔗 <a href='https://github.com/TeleBoxDev/TeleBox'>📦 仓库</a> | <a href='https://github.com/TeleBoxDev/TeleBox_Plugins'>🔌 插件</a> | <a href='https://t.me/teleboxdevgroup'>👥 群组</a> | <a href='https://t.me/teleboxdev'>📣 频道</a>`;

        await msg.edit({
          text: [header, "", basic.text, "", prefixLine, helpTip, links].join("\n"),
          parseMode: "html",
          linkPreview: false
        });

        // 模块列表（消息2）
        const modulePlanner = new EntityPlanner();
        const modules = formatModuleCommands(commands, modulePlanner);
        if (modules.text) {
          await msg.reply({
            message: modules.text + `\n💡 使用 <i><code>${mainPrefix}help [模块名]</code></i> 查看具体模块的使用方法`,
            parseMode: "html",
            linkPreview: false
          });
        }
        return;
      }

      // 单个命令/模块详情
      const command = args[0].toLowerCase();
      const pluginEntry = getPluginEntry(command);

      if (!pluginEntry?.plugin) {
        await msg.edit({
          text: `❌ 未找到命令 <code>${htmlEscape(command)}</code>\n\n💡 使用 <code>${mainPrefix}help</code> 查看所有命令`,
          parseMode: "html"
        });
        return;
      }

      const plugin = pluginEntry.plugin;
      const aliasDB = new AliasDB();
      const planner = new EntityPlanner();
      planner.consume(6);

      const { text: cmdText } = formatCommandsSafely(Object.keys(plugin.cmdHandlers).sort(), aliasDB, mainPrefix, planner);
      aliasDB.close();

      let description: string;
      if (!plugin.description) description = "暂无描述信息";
      else if (typeof plugin.description === "string") description = plugin.description;
      else {
        try {
          description = await plugin.description({ plugin: pluginEntry });
        } catch {
          description = "生成描述信息出错";
        }
      }

      let cronInfo = "";
      if (plugin.cronTasks && Object.keys(plugin.cronTasks).length) {
        const cronTasks = Object.entries(plugin.cronTasks)
          .map(([k, v]) => `• <code><b>${htmlEscape(k)}：</b></code> ${v.description} <code>(${htmlEscape(v.cron)})</code>`)
          .join("\n");
        cronInfo = `\n📅 <b>定时任务：</b>\n${cronTasks}\n`;
      }

      await msg.edit({
        text: [
          `🔧 <b>${htmlEscape(command.toUpperCase())}</b>`,
          "",
          `📝 <b>功能描述：</b>`,
          description,
          "",
          `🏷️ <b>命令：</b>`,
          cmdText,
          "",
          `⚡ <b>使用方法：</b>`,
          `<code>${mainPrefix}${command} [参数]</code>`,
          cronInfo,
          `💡 <i>提示：使用 </i><code>${mainPrefix}help</code><i> 查看所有命令</i>`
        ].join("\n"),
        parseMode: "html",
        linkPreview: false
      });
    } catch (e: any) {
      console.error("Help plugin error:", e);
      const errorMsg = e.message?.length > 100 ? e.message.substring(0, 100) + "..." : e.message;
      await msg.edit({
        text: [
          "⚠️ <b>系统错误</b>",
          "",
          "📋 <b>错误详情：</b>",
          `<code>${htmlEscape(errorMsg || "未知系统错误")}</code>`,
          "",
          "🔧 <b>解决方案：</b>",
          "• 稍后重试命令",
          "• 重启 TeleBox 服务",
          "• 检查插件配置是否正确",
          "• 查看控制台获取详细日志",
          "",
          "🆘 <a href='https://github.com/TeleBoxDev/TeleBox/issues'>反馈问题</a>"
        ].join("\n"),
        parseMode: "html"
      });
    }
  }
  
  async cleanup(): Promise<void> {
    // 清理数据库连接
    try {
      const aliasDB = new AliasDB();
      aliasDB.close();
    } catch (e) {
      console.error("[HelpPlugin] Error closing aliasDB:", e);
    }
    console.log("[HelpPlugin] Cleanup completed");
  }
}

export default new HelpPlugin();