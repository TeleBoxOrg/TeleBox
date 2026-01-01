import { exec } from "child_process";
import { promisify } from "util";
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";

const execAsync = promisify(exec);

const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" } as any)[m] || m
  );

async function handleExec(params: { msg: Api.Message; shellCommand: string }) {
  const { msg, shellCommand } = params;
  try {
    const { stdout, stderr } = await execAsync(shellCommand);
    let text = `<b>🖥️ Shell 执行结果：</b>\n\n`;
    if (stdout) text += `<b>输出：</b>\n<pre><code class="language-shell">${htmlEscape(stdout)}</code></pre>\n\n`;
    if (stderr) text += `<b>错误：</b>\n<pre><code class="language-shell">${htmlEscape(stderr)}</code></pre>`;
    
    await msg.edit({ text, parseMode: "html" });
  } catch (error: any) {
    await msg.edit({
      text: `❌ 执行失败：<code>${htmlEscape(error.message || String(error))}</code>`,
      parseMode: "html"
    });
  }
}

class ExecPlugin extends Plugin {
  name = "exec";
  description = `🖥️ 执行 Shell 命令

<b>📝 功能描述：</b>
• 在服务器上执行 Shell 命令
• 返回命令的标准输出和错误输出
• 支持所有系统命令

<b>🔧 使用方法：</b>
• <code>${getPrefixes()[0]}exec &lt;命令&gt;</code> - 执行 Shell 命令

<b>⚠️ 安全警告：</b>
• 仅授权可信用户使用
• 避免执行危险命令（rm、dd等）
• 生产环境慎用`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    exec: async (msg) => {
      const shellCommand = msg.message.slice(1).replace(/^\S+\s+/, "");
      if (!shellCommand.trim()) {
        await msg.edit({ text: "❌ 未提供要执行的命令", parseMode: "html" });
        return;
      }
      await handleExec({ msg, shellCommand });
    }
  };
  
  async cleanup(): Promise<void> {
    // exec 不创建长期资源，无需清理
    console.log("[ExecPlugin] Cleanup completed");
  }
}

export default new ExecPlugin();