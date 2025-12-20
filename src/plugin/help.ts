import {
  listCommands,
  getPluginEntry,
  getPrefixes,
} from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import fs from "fs";
import path from "path";
import { Api } from "telegram";
import { AliasDB } from "@utils/aliasDB";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 添加 EntityManager 辅助类来管理 entities 配额
class EntityManager {
  private count = 0;
  private readonly LIMIT = 95; // 预留余量
  
  // 检查添加指定数量的 tags 是否会超出限制
  canAdd(tagCount: number): boolean {
    return this.count + tagCount <= this.LIMIT;
  }
  
  // 记录已添加的 tags 数量
  add(tagCount: number) {
    this.count += tagCount;
  }
  
  getCount(): number {
    return this.count;
  }
}

/** HTML 转义。 */
function htmlEscape(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 读取 package.json 中的版本号。 */
function readVersion(): string {
  try {
    const packagePath = path.join(process.cwd(), "package.json");
    const packageJson = fs.readFileSync(packagePath, "utf-8");
    const packageData = JSON.parse(packageJson);
    return packageData.version || "未知版本";
  } catch (error) {
    console.error("Failed to read version:", error);
    return "未知版本";
  }
}

/** 安全地格式化命令列表。如果 <code> 标签超出预算，则降级为纯文本。 */
function formatCommandsSafely(
  commands: string[],
  aliasDB: AliasDB,
  prefix: string = "",
  entityMgr: EntityManager
): { text: string } {
  const formatted: string[] = [];
  
  for (const cmd of commands) {
    const alias = aliasDB.getOriginal(cmd);
    const hasAlias = alias?.length > 0;
    
    // 预估所需的 <code> 标签数（命令 + 所有别名）
    // 每个 code 标签 = 2 entities（开始+结束）
    const estimatedTagCount = 2 * (1 + (hasAlias ? alias.length : 0));
    
    let cmdPart: string;
    
    if (entityMgr.canAdd(estimatedTagCount)) {
      // 正常模式：使用 <code>
      cmdPart = `<code>${prefix}${htmlEscape(cmd)}</code>`;
      entityMgr.add(2); // 主命令
      
      if (hasAlias) {
        const aliasParts = alias.map((a) => {
          entityMgr.add(2); // 每个别名
          return `<code>${htmlEscape(a)}</code>`;
        }).join(", ");
        cmdPart += ` (${aliasParts})`;
      }
    } else {
      // 降级模式：不使用 <code>
      cmdPart = `${prefix}${cmd}`;
      if (hasAlias) {
        cmdPart += ` (${alias.join(", ")})`;
      }
    }
    formatted.push(cmdPart);
  }

  return {
    text: formatted.join(" • "),
  };
}

/** 格式化基础命令列表（单命令）。 */
function formatBasicCommands(commands: string[], entityMgr: EntityManager): { text: string } {
  const singleCommands: string[] = [];
  const aliasDB = new AliasDB();

  // 筛选基础命令
  commands
    .sort((a, b) => a.localeCompare(b))
    .forEach((cmd) => {
      const pluginEntry = getPluginEntry(cmd);
      if (pluginEntry?.plugin?.cmdHandlers) {
        const cmdHandlerKeys = Object.keys(pluginEntry.plugin.cmdHandlers);
        // 如果是单命令插件
        if (cmdHandlerKeys.length === 1 && cmdHandlerKeys[0] === cmd) {
          singleCommands.push(cmd);
        }
      }
    });

  const { text: formattedCommands } = formatCommandsSafely(
    singleCommands,
    aliasDB,
    "",
    entityMgr
  );

  aliasDB.close();

  if (formattedCommands.length === 0) {
    return { text: "暂无基础命令" };
  }

  return {
    text: `📋 <b>基础命令:</b> ${formattedCommands}`,
  };
}

/** 格式化功能模块命令列表（多命令插件）。 */
function formatModuleCommands(commands: string[], entityMgr: EntityManager): { text: string } {
  const pluginGroups = new Map<string, string[]>();
  const aliasDB = new AliasDB();

  // 分组多命令插件
  commands
    .sort((a, b) => a.localeCompare(b))
    .forEach((cmd) => {
      const pluginEntry = getPluginEntry(cmd);
      if (pluginEntry?.plugin?.cmdHandlers) {
        const cmdHandlerKeys = Object.keys(pluginEntry.plugin.cmdHandlers).sort();
        if (cmdHandlerKeys.length > 1) {
          const mainCommand = cmdHandlerKeys[0];
          if (!pluginGroups.has(mainCommand)) {
            pluginGroups.set(mainCommand, cmdHandlerKeys);
          }
        }
      }
    });

  if (pluginGroups.size === 0) {
    aliasDB.close();
    return { text: "" };
  }

  const groupLines: string[] = [];
  
  for (const [mainCommand, subCommands] of pluginGroups) {
    const { text: formattedSubs } = formatCommandsSafely(
      subCommands,
      aliasDB,
      "",
      entityMgr
    );
    
    // 模块名 (mainCommand) 使用 <b> 标签 (高优先级)
    groupLines.push(`<b>${htmlEscape(mainCommand)}:</b> ${formattedSubs}`);
  }

  aliasDB.close();
  
  return {
    text: `🔧 <b>功能模块:</b><blockquote expandable>${groupLines.join("\n")}\n</blockquote>`,
  };
}

class HelpPlugin extends Plugin {
  description: string = "查看帮助信息和可用命令列表";
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    help: this.handleHelp,
    h: this.handleHelp,
  };

  private async handleHelp(msg: Api.Message): Promise<void> {
    try {
      const args = msg.text.split(" ").slice(1);

      if (args.length === 0) {
        const commands = listCommands();
        const version = readVersion();
        const totalCommands = commands.length;
        
        // 第一条消息使用独立的 EntityManager
        const entityMgr1 = new EntityManager();
        const messageParts1: string[] = [];
        
        // 标题（版本和命令数）
        messageParts1.push(`🚀 <b>TeleBox v${htmlEscape(version)}</b> | ${totalCommands} 个命令`);
        entityMgr1.add(2); // <b>
        
        // 基础命令
        const { text: basicCommandsText } = formatBasicCommands(commands, entityMgr1);
        messageParts1.push("", basicCommandsText);
        
        // 添加空行，然后指令前缀
        const prefixText = `❕ <b>指令前缀：</b> ${prefixes.map((p) => `<code>${htmlEscape(p)}</code>`).join(" • ")}`;
        messageParts1.push("", prefixText);
        entityMgr1.add(2); // <b>
        entityMgr1.add(prefixes.length * 2); // 每个 prefix 的 code 标签
        
        // 帮助提示（不换行）
        const helpTip = `💡 <code>${mainPrefix}help [命令]</code> 查看详情 | <code>${mainPrefix}tpm search</code> 显示远程插件列表`;
        messageParts1.push(helpTip);
        entityMgr1.add(4); // 2 个 code 标签
        
        // 帮助链接（不换行）
        const helpLinks = "🔗 <a href='https://github.com/TeleBoxDev/TeleBox'>📦仓库</a> | <a href='https://github.com/TeleBoxDev/TeleBox_Plugins'>🔌插件</a> | <a href='https://t.me/teleboxdevgroup'>👥群组</a> | <a href='https://t.me/teleboxdev'>📣频道</a>";
        messageParts1.push(helpLinks);
        entityMgr1.add(8); // 4 个 a 标签
        
        const helpTextPart1 = messageParts1.join("\n");

        await msg.edit({
          text: helpTextPart1,
          parseMode: "html",
          linkPreview: false,
        });

        // 第二条消息使用全新的 EntityManager
        const entityMgr2 = new EntityManager();
        const { text: moduleCommandsText } = formatModuleCommands(commands, entityMgr2);
        
        if (moduleCommandsText && moduleCommandsText.length > 0) {
          const messageParts2: string[] = [];
          messageParts2.push(moduleCommandsText);
          
          // 功能模块帮助提示（前面只添加一个换行）
          const moduleHelpTip = `💡 使用 <code>${mainPrefix}help [模块名]</code> 查看具体模块的使用方法`;
          messageParts2.push(moduleHelpTip);
          entityMgr2.add(2); // <b>
          entityMgr2.add(2); // code 标签
          
          const helpTextPart2 = messageParts2.join("");

          await msg.reply({
            message: helpTextPart2,
            parseMode: "html",
            linkPreview: false,
          });
        }

        return;
      }

      // --- 显示特定命令的帮助 (单命令详情) ---
      const command = args[0].toLowerCase();
      const pluginEntry = getPluginEntry(command);

      if (!pluginEntry?.plugin) {
        await msg.edit({
          text: `❌ 未找到命令 <code>${htmlEscape(
            command
          )}</code>\n\n💡 使用 <code>${mainPrefix}help</code> 查看所有命令`,
          parseMode: "html",
        });
        return;
      }

      const plugin = pluginEntry.plugin;
      const commandsInPlugin = Object.keys(plugin.cmdHandlers).sort();

      const aliasDB = new AliasDB();
      // 单个插件详情无需预算限制
      const entityMgrDetail = new EntityManager();
      entityMgrDetail.add(4096); // 设置一个很大的值，相当于无限制
      
      const { text: cmdsText } = formatCommandsSafely(
        commandsInPlugin,
        aliasDB,
        mainPrefix,
        entityMgrDetail
      );
      aliasDB.close();

      let description: string | void;

      if (!plugin.description) {
        description = "暂无描述信息";
      } else if (typeof plugin.description === "string") {
        description = plugin.description;
      } else {
        try {
          description =
            (await plugin.description({ plugin: pluginEntry })) ||
            "暂无描述信息";
        } catch (e: any) {
          console.error("Error getting plugin description:", e);
          description = `生成描述信息出错: ${e?.message || "未知错误"}`;
        }
      }

      let cronTasksInfo = "";
      if (plugin.cronTasks && Object.keys(plugin.cronTasks).length > 0) {
        const cronTasks = Object.entries(plugin.cronTasks)
          .map(([key, task]) => {
            return `• <code><b>${htmlEscape(key)}:</b></code> ${
              task.description
            } <code>(${htmlEscape(task.cron)})</code>`;
          })
          .join("\n");
        cronTasksInfo = `\n📅 <b>定时任务:</b>\n${cronTasks}\n`;
      }

      const commandHelpText = [
        `🔧 <b>${htmlEscape(command.toUpperCase())}</b>`,
        "",
        `📝 <b>功能描述:</b>`,
        `${description || "暂无描述信息"}`,
        "",
        `🏷️ <b>命令:</b>`,
        `${cmdsText}`,
        "",
        `⚡ <b>使用方法:</b>`,
        `<code>${mainPrefix}${command} [参数]</code>`,
        cronTasksInfo,
        `💡 <i>提示: 使用</i> <code>${mainPrefix}help</code> <i>查看所有命令</i>`,
      ].join("\n");

      await msg.edit({
        text: commandHelpText,
        parseMode: "html",
        linkPreview: false,
      });
    } catch (error: any) {
      console.error("Help plugin error:", error);
      const errorMsg =
        error.message?.length > 100
          ? error.message.substring(0, 100) + "..."
          : error.message;
      await msg.edit({
        text: [
          "⚠️ <b>系统错误</b>",
          "",
          "📋 <b>错误详情:</b>",
          `<code>${htmlEscape(errorMsg || "未知系统错误")}</code>`,
          "",
          "🔧 <b>解决方案:</b>",
          "• 稍后重试命令",
          "• 重启 TeleBox 服务",
          "• 检查系统日志",
          "",
          "🆘 <a href='https://github.com/TeleBoxDev/TeleBox/issues'>反馈问题</a>",
        ].join("\n"),
        parseMode: "html",
      });
    }
  }
}

const helpPlugin = new HelpPlugin();

export default helpPlugin;
