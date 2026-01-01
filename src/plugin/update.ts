import { Plugin } from "@utils/pluginBase";
import { exec } from "child_process";
import { promisify } from "util";
import { loadPlugins, getPrefixes } from "@utils/pluginManager";
import { Api } from "telegram";

const execAsync = promisify(exec);

const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" } as any)[m] || m
  );

/**
 * 自动更新项目：拉取 Git 更新 + 安装依赖
 */
async function updateProject(force = false, msg: Api.Message) {
  const prefixes = getPrefixes();
  const mainPrefix = prefixes[0];
  
  await msg.edit({ text: "🚀 正在更新项目...", parseMode: "html" });
  console.clear();
  console.log("🚀 开始更新项目...\n");

  try {
    await execAsync("git fetch --all");
    await msg.edit({ text: "🔄 正在拉取最新代码...", parseMode: "html" });

    if (force) {
      console.log("⚠️ 强制回滚到 origin/main...");
      await execAsync("git reset --hard origin/main");
      await msg.edit({ text: "🔄 强制更新中...", parseMode: "html" });
    }

    await execAsync("git pull");
    await msg.edit({ text: "🔄 正在合并最新代码...", parseMode: "html" });

    console.log("\n📦 安装依赖...");
    await msg.edit({ text: "📦 正在安装依赖...", parseMode: "html" });
    await execAsync("npm install");

    console.log("\n✅ 更新完成。");
    await msg.edit({ text: "✅ 更新完成！", parseMode: "html" });
    
    await loadPlugins(); // 重新加载插件
    console.log("🔄 插件已重新加载。");
    await msg.edit({ 
      text: `✅ 更新完成！\n🔄 插件已重新加载。\n\n使用 ${mainPrefix}help 查看所有命令。`,
      parseMode: "html" 
    });
  } catch (error: any) {
    console.error("❌ 更新失败:", error);
    
    const errorMessage = error.message || String(error);
    const stderr = error.stderr || "";
    const cmd = error.cmd || "";
    
    await msg.edit({
      text: [
        `❌ <b>更新失败</b>`,
        ``,
        `<b>执行的命令：</b>`,
        `<code>${htmlEscape(cmd)}</code>`,
        ``,
        `<b>错误信息：</b>`,
        `<pre><code>${htmlEscape(errorMessage)}</code></pre>`,
        ``,
        `<b>详细输出：</b>`,
        `<pre><code>${htmlEscape(stderr.slice(-500))}</code></pre>`,
        ``,
        `🔧 <b>解决方案：</b>`,
        `• 检查Git状态：<code>git status</code>`,
        `• 解决冲突后重新更新`,
        `• 或使用强制更新：<code>${mainPrefix}update -f</code>（会丢弃本地改动）`
      ].join("\n"),
      parseMode: "html"
    });
  }
}

class UpdatePlugin extends Plugin {
  name = "update";
  
  description = (() => {
    const prefixes = getPrefixes();
    const mainPrefix = prefixes[0];
    
    return `🔄 <b>更新 TeleBox 项目</b>
    
<b>📝 功能描述：</b>
• 从 Git 仓库拉取最新代码
• 自动安装 npm 依赖
• 自动重载所有插件
• 支持强制更新（覆盖本地修改）

<b>🔧 使用方法：</b>
• <code>${mainPrefix}update</code> - 常规更新
• <code>${mainPrefix}update -f</code> - 强制更新（丢弃本地改动）

<b>💡 示例：</b>
• <code>${mainPrefix}update</code> - 正常更新项目
• <code>${mainPrefix}update -f</code> - 强制更新并丢弃本地修改

<b>⚠️ 注意事项：</b>
• 更新前建议备份重要配置
• 强制更新会覆盖所有本地修改
• 更新失败请检查 Git 状态和冲突`;
  })();

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    update: async (msg: Api.Message) => {
      const text = msg.text || "";
      const args = text.trim().split(/\s+/).slice(1); // 使用 msg.text
      const force = args.includes("--force") || args.includes("-f");
      await updateProject(force, msg);
    }
  };
  
  async cleanup(): Promise<void> {
    console.log("[UpdatePlugin] Cleanup completed");
  }
}

export default new UpdatePlugin();