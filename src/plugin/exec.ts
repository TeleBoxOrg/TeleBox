import { exec } from "child_process";
import { Plugin, type PluginRuntimeContext } from "@utils/pluginBase";
import { Api } from "teleproto";
import type { GenerationContext } from "@utils/generationContext";
import { tryGetCurrentGenerationContext } from "@utils/runtimeManager";


function truncate(text: string, max = 3500) {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n\n…(输出过长，已截断)";
}

type ExecResult = {
  stdout: string;
  stderr: string;
};

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("Shell command aborted");
}

function runOwnedExec(shellCommand: string, lifecycle: GenerationContext): Promise<ExecResult> {
  return lifecycle.runTask(
    async (signal) =>
      await new Promise<ExecResult>((resolve, reject) => {
        let settled = false;

        const finish = (callback: () => void): void => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          callback();
        };

        const child = lifecycle.trackChildProcess(exec(shellCommand, (error, stdout, stderr) => {
          if (error) {
            finish(() => reject(error));
            return;
          }
          finish(() => resolve({ stdout, stderr }));
        }), {
          label: "exec:shell-command",
        });

        const onAbort = (): void => {
          if (!child.killed && child.exitCode === null) {
            child.kill();
          }
          finish(() => reject(abortError(signal.reason)));
        };

        signal.addEventListener("abort", onAbort, { once: true });
        child.once("error", (error) => finish(() => reject(error)));

        if (signal.aborted) {
          onAbort();
        }
      }),
    { label: "exec:shell-command", kind: "promise" }
  );
}

async function handleExec(params: { msg: Api.Message; shellCommand: string; lifecycle: GenerationContext }) {
  const { msg, shellCommand, lifecycle } = params;

  const start = Date.now();

  await msg.edit({
    text:
      `✅ 已开始执行 shell 命令…\n` +
      `命令：\`${shellCommand}\`\n` +
      `状态：运行中 0s`,
    parseMode: "markdown",
  });

  let stopped = false;

  const timer = lifecycle.setInterval(() => {
    if (stopped) return;
    const cost = ((Date.now() - start) / 1000).toFixed(0);
    void msg.edit({
      text:
        `✅ 已开始执行 shell 命令…\n` +
        `命令：\`${shellCommand}\`\n` +
        `状态：运行中 ${cost}s`,
      parseMode: "markdown",
    }).catch(() => undefined);
  }, 2000, { label: "exec:status-interval" });

  try {
    const { stdout, stderr } = await runOwnedExec(shellCommand, lifecycle);
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
  } catch (error) {
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
  private lifecycle: GenerationContext | null = null;

  setup(context: PluginRuntimeContext): void {
    this.lifecycle = context.lifecycle;
  }

  cleanup(): void {
    this.lifecycle = null;
  }

  // Resolve the lifecycle for the current command invocation. Prefers the
  // setup()-injected context but falls back to the live runtime context.
  // This guards against a race where setup() failed for an earlier plugin
  // in the load order, leaving this plugin's cmdHandlers registered but
  // its `lifecycle` field still null. Since cmdHandlers only fire from the
  // currently-installed root message handler, the active runtime context
  // is always the correct one to use.
  private resolveLifecycle(): GenerationContext {
    if (this.lifecycle && !this.lifecycle.signal.aborted) {
      return this.lifecycle;
    }
    const fallback = tryGetCurrentGenerationContext();
    if (fallback && !fallback.signal.aborted) {
      this.lifecycle = fallback;
      return fallback;
    }
    throw new Error("Exec plugin lifecycle is not initialized");
  }

  description: string = `运行 shell 命令`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    exec: async (msg) => {
      const lifecycle = this.resolveLifecycle();
      const shellCommand = msg.message.slice(1).replace(/^\S+\s+/, "");
      await handleExec({ msg, shellCommand, lifecycle });
    },
  };
}

export default new ExecPlugin();
