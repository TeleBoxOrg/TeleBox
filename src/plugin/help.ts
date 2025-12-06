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

// 设置 <code> 标签对的总数安全阈值，超过此阈值将触发格式降级。
const MAX_TOTAL_CODE_TAGS = 98; 

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

/**
 * 安全地格式化命令列表。如果 <code> 标签超出预算，则降级为纯文本。
 * 别名 (alias) 也会占用标签预算。
 */
function formatCommandsSafely(
  commands: string[],
  aliasDB: AliasDB,
  prefix: string = "",
  availableCodeTagBudget: number = MAX_TOTAL_CODE_TAGS
): { text: string, codeTagsUsed: number } {
  let tagsUsed = 0;
  const formatted: string[] = [];
  let degradeMode = false;

  for (const cmd of commands) {
    const alias = aliasDB.getOriginal(cmd);
    const hasAlias = alias?.length > 0;
    
    // 预估所需的 <code> 标签数（命令 + 所有别名）
    const estimatedTagsNeeded = 1 + (hasAlias ? alias.length : 0);
    
    if (tagsUsed + estimatedTagsNeeded > availableCodeTagBudget) {
      degradeMode = true;
    }

    let cmdPart: string;
    
    if (degradeMode) {
      // 降级模式：不使用 <code>
      cmdPart = `${prefix}${cmd}`;
      if (hasAlias) {
        cmdPart += ` (${alias.join(", ")})`;
      }
    } else {
      // 正常模式：使用 <code>，并计入主命令标签
      cmdPart = `<code>${prefix}${cmd}</code>`;
      tagsUsed++;
      
      if (hasAlias) {
        const aliasParts = alias.map((a) => {
          tagsUsed++; // 计入别名标签
          return `<code>${a}</code>`;
        }).join(", ");
        cmdPart += ` (${aliasParts})`;
      }
    }
    formatted.push(cmdPart);
  }

  return {
    text: formatted.join(" • "),
    codeTagsUsed: tagsUsed,
  };
}


/** 格式化基础命令列表（单命令）。 */
function formatBasicCommands(commands: string[], budget: number): { text: string, codeTagsUsed: number } {
  const singleCommands: string[] = [];
  const aliasDB = new AliasDB();

  // 筛选基础命令
  commands
    .sort((a, b) => a.localeCompare(b))
    .forEach((cmd) => {
      const pluginEntry = getPluginEntry(cmd);
      if (pluginEntry && pluginEntry.plugin.cmdHandlers) {
        const cmdHandlerKeys = Object.keys(pluginEntry.plugin.cmdHandlers);
        // 如果是单命令插件
        if (cmdHandlerKeys.length === 1 && cmdHandlerKeys[0] === cmd) {
          singleCommands.push(cmd);
        }
      }
    });

  const { text: formattedCommands, codeTagsUsed } = formatCommandsSafely(
    singleCommands,
    aliasDB,
    "",
    budget
  );

  aliasDB.close();

  if (formattedCommands.length === 0) {
    return { text: "暂无基础命令", codeTagsUsed: 0 };
  }

  return {
    text: `📋 <b>基础命令:</b> ${formattedCommands}`,
    codeTagsUsed: codeTagsUsed,
  };
}

/** 格式化功能模块命令列表（多命令插件）。 */
function formatModuleCommands(commands: string[], budget: number): { text: string, codeTagsUsed: number } {
  const pluginGroups = new Map<string, string[]>();
  const aliasDB = new AliasDB();

  // 分组多命令插件
  commands
    .sort((a, b) => a.localeCompare(b))
    .forEach((cmd) => {
      const pluginEntry = getPluginEntry(cmd);
      if (pluginEntry && pluginEntry.plugin.cmdHandlers) {
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
    return { text: "", codeTagsUsed: 0 };
  }

  const groupLines: string[] = [];
  let totalCodeTagsUsed = 0;

  for (const [mainCommand, subCommands] of pluginGroups) {
    // 剩余预算 = 总预算 - 已经使用的标签数
    const remainingBudget = budget - totalCodeTagsUsed;
    
    // 对子命令进行安全格式化
    const { text: formattedSubs, codeTagsUsed } = formatCommandsSafely(
      subCommands,
      aliasDB,
      "",
      remainingBudget
    );
    
    totalCodeTagsUsed += codeTagsUsed;
    
    // 模块名 (mainCommand) 使用 <b> 标签 (高优先级，不占用 <code> 预算)
    groupLines.push(`<b>${mainCommand}:</b> ${formattedSubs}`);
  }

  aliasDB.close();
  
  return {
    text: `🔧 <b>功能模块:</b><blockquote expandable>${groupLines.join(
      "\n"
    )}\n</blockquote>`,
    codeTagsUsed: totalCodeTagsUsed,
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
        
        // P1: 第一条消息的固定高优先级 <code> 标签: 指令前缀 + 2 个帮助提示
        const P1_FIXED_CODE_TAGS = prefixes.length + 2; 
        
        // P2: 第二条消息的固定高优先级 <code> 标签: 1 个帮助提示
        const P2_FIXED_CODE_TAGS = 1;

        // 分配给低优先级命令列表的 <code> 标签预算
        const basicBudget = Math.max(0, MAX_TOTAL_CODE_TAGS - P1_FIXED_CODE_TAGS);
        const moduleBudget = Math.max(0, MAX_TOTAL_CODE_TAGS - P2_FIXED_CODE_TAGS);


        // 获取命令文本 (使用剩余预算进行格式化，如果超限则降级)
        const { text: basicCommandsText } = formatBasicCommands(commands, basicBudget);
        const { text: moduleCommandsText } = formatModuleCommands(commands, moduleBudget);

        // --- 构造第一条消息 (基础信息 + 基础命令) ---
        const helpTextPart1 = [
          `🚀 <b>TeleBox v${htmlEscape(version)}</b> | ${totalCommands} 个命令`,
          "",
          basicCommandsText, 
          "",
          // P1 高优先级 <code> 标签：指令前缀
          `❕ <b>指令前缀：</b> ${prefixes
            .map((p) => `<code>${htmlEscape(p)}</code>`)
            .join(" • ")}`,
          // P1 高优先级 <code> 标签：帮助提示
          `💡 <code>${mainPrefix}help [命令]</code> 查看详情 | <code>${mainPrefix}tpm search</code> 显示远程插件列表`,
          // 帮助链接 (<a> 标签，始终保留)
          "🔗 <a href='https://github.com/TeleBoxDev/TeleBox'>📦仓库</a> | <a href='https://github.com/TeleBoxDev/TeleBox_Plugins'>🔌插件</a> | <a href='https://t.me/teleboxdevgroup'>👥群组</a> | <a href='https://t.me/teleboxdev'>📣频道</a>",
        ].join("\n");

        await msg.edit({
          text: helpTextPart1,
          parseMode: "html",
          linkPreview: false,
        });

        // --- 构造第二条消息 (功能模块) ---
        if (moduleCommandsText && moduleCommandsText.length > 0) {
          const helpTextPart2 = [
            moduleCommandsText, 
            // P2 高优先级 <code> 标签：功能模块帮助提示
            `💡 使用 <code>${mainPrefix}help [模块名]</code> 查看具体模块的使用方法`,
          ].join("\n");

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
      const { text: cmdsText } = formatCommandsSafely(
        commandsInPlugin,
        aliasDB,
        mainPrefix, 
        1000 
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
      // --- 错误处理部分 ---
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
