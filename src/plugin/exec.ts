import { exec } from "child_process";
import { promisify } from "util";
import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";

const execAsync = promisify(exec);

function truncate(text: string, max = 3500) {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n\n…(输出过长，已截断)";
}

async function handleExec(params: { msg: Api.Message; shellCommand: string }) {
  const { msg, shellCommand } = params;

  const start = Date.now();

  await msg.edit({
    text:
      `✅ 已开始执行 shell 命令…\n` +
      `命令：\`${shellCommand}\`\n` +
      `状态：运行中 0s`,
    parseMode: "markdown",
  });

  let stopped = false;

  const timer = setInterval(async () => {
    if (stopped) return;
    const cost = ((Date.now() - start) / 1000).toFixed(0);
    try {
      await msg.edit({
        text:
          `✅ 已开始执行 shell 命令…\n` +
          `命令：\`${shellCommand}\`\n` +
          `状态：运行中 ${cost}s`,
        parseMode: "markdown",
      });
    } catch {}
  }, 2000);

  try {
    const { stdout, stderr } = await execAsync(shellCommand);
    stopped = true;
    clearInterval(timer);

    const costMs = Date.now() - start;

    let text =
      `✅ 执行完成（${(costMs / 1000).toFixed(2)}s）\n` +
      `命令：\`${shellCommand}\`\n\n` +
      `shell 输出：\n${stdout || "(无输出)"}`;

    if (stderr) {
      text += `\n\nshell 错误：\n${stderr}`;
    }

    await msg.edit({
      text: truncate(text),
      parseMode: "markdown",
    });
  } catch (error: any) {
    stopped = true;
    clearInterval(timer);

    const costMs = Date.now() - start;

    await msg.edit({
      text: truncate(
        `❌ 执行失败（${(costMs / 1000).toFixed(2)}s）\n` +
          `命令：\`${shellCommand}\`\n\n` +
          `错误：${String(error)}`
      ),
      parseMode: "markdown",
    });
  }
}

class ExecPlugin extends Plugin {
  description: string = `运行 shell 命令`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    exec: async (msg) => {
      const shellCommand = msg.message.slice(1).replace(/^\S+\s+/, "");
      await handleExec({ msg, shellCommand });
    },
  };
}

export default new ExecPlugin();
