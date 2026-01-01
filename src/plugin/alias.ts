import { Plugin } from "@utils/pluginBase";
import { AliasDB } from "@utils/aliasDB";
import { Api } from "telegram";
import { loadPlugins, getPrefixes, getPluginEntry } from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义函数
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" } as any)[m] || m
  );

async function setAlias(args: string[], msg: Api.Message) {
  const final = args[1];
  const original = args[2];
  const pluginEntry = getPluginEntry(original);
  
  if (!pluginEntry) {
    await msg.edit({ text: `❌ 未找到原始命令 <code>${htmlEscape(original)}</code>，无法设置别名` });
    await msg.deleteWithDelay(5000);
    return;
  }
  
  if (pluginEntry?.original) {
    await msg.edit({ text: "⚠️ 不应为别名命令再次设置别名" });
    await msg.deleteWithDelay(5000);
    return;
  }
  
  const db = new AliasDB();
  db.set(final, original);
  db.close();
  loadPlugins();
  
  await msg.edit({
    text: `✅ 别名设置成功：<code>${htmlEscape(final)}</code> → <code>${htmlEscape(original)}</code>`,
    parseMode: "html"
  });
}

async function delAlias(args: string[], msg: Api.Message) {
  const db = new AliasDB();
  const success = db.del(args[1]);
  db.close();
  
  if (success) {
    await msg.edit({
      text: `✅ 已删除别名：<code>${htmlEscape(args[1])}</code>`,
      parseMode: "html"
    });
    loadPlugins();
  } else {
    await msg.edit({
      text: `❌ 删除失败：别名 <code>${htmlEscape(args[1])}</code> 不存在`,
      parseMode: "html"
    });
  }
}

async function listAlias(msg: Api.Message) {
  const db = new AliasDB();
  const result = db.list();
  db.close();
  
  if (result.length === 0) {
    await msg.edit({ text: "📋 当前没有设置任何别名" });
    return;
  }
  
  const text = result
    .map(({ original, final }) => `<code>${htmlEscape(original)}</code> → <code>${htmlEscape(final)}</code>`)
    .join("\n");
    
  await msg.edit({
    text: `📋 <b>别名列表：</b>\n${text}`,
    parseMode: "html"
  });
}

class AliasPlugin extends Plugin {
  name = "alias";
  description = `🔤 命令别名管理插件

<b>📝 功能描述：</b>
• 为常用命令设置简短别名
• 支持多个别名指向同一命令
• 别名数据持久化存储

<b>🔧 使用方法：</b>
• <code>${mainPrefix}alias set &lt;别名&gt; &lt;原始命令&gt;</code> - 设置别名
• <code>${mainPrefix}alias del &lt;别名&gt;</code> - 删除别名
• <code>${mainPrefix}alias ls</code> - 查看所有别名

<b>💡 示例：</b>
• <code>${mainPrefix}alias set h help</code> - 设置 h 作为 help 的别名
• <code>${mainPrefix}alias set p ping</code> - 设置 p 作为 ping 的别名`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    alias: async (msg) => {
      const [, ...args] = msg.message.split(" ");
      
      if (args.length === 0) {
        await msg.edit({
          text: `❌ 缺少参数\n\n${this.description}`,
          parseMode: "html"
        });
        return;
      }
      
      const cmd = args[0].toLowerCase();
      switch (cmd) {
        case "set":
          if (args.length < 3) {
            await msg.edit({
              text: `❌ 参数不足\n正确格式：<code>${mainPrefix}alias set &lt;别名&gt; &lt;原始命令&gt;</code>`,
              parseMode: "html"
            });
            return;
          }
          await setAlias(args, msg);
          break;
        case "del":
          if (args.length < 2) {
            await msg.edit({
              text: `❌ 缺少要删除的别名\n正确格式：<code>${mainPrefix}alias del &lt;别名&gt;</code>`,
              parseMode: "html"
            });
            return;
          }
          await delAlias(args, msg);
          break;
        case "ls":
        case "list":
          await listAlias(msg);
          break;
        default:
          await msg.edit({
            text: `❌ 未知子命令 <code>${htmlEscape(cmd)}</code>\n\n${this.description}`,
            parseMode: "html"
          });
      }
    }
  };
  
  async cleanup(): Promise<void> {
    // AliasDB 在每次操作后都会关闭，无需额外清理
    console.log("[AliasPlugin] Cleanup completed");
  }
}

export default new AliasPlugin();