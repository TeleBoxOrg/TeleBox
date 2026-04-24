import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { exec } from "child_process";
import { promisify } from "util";
import { loadPlugins } from "@utils/pluginManager";
import { Api } from "teleproto";
import { npm_install_project_dependencies } from "@utils/npm_install";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const execAsync = promisify(exec);

async function getRemotes(): Promise<string[]> {
  try {
    const { stdout } = await execAsync("git remote");
    return stdout.trim().split("\n").filter((r) => r.trim());
  } catch {
    return [];
  }
}

async function getBranches(): Promise<string[]> {
  try {
    const { stdout } = await execAsync("git branch -r");
    const branches = stdout
      .trim()
      .split("\n")
      .map((b) => b.trim().replace(/^\*/, "").trim())
      .filter((b) => b && !b.includes("->"));
    return branches;
  } catch {
    return [];
  }
}

async function findMainBranch(): Promise<{ remote: string; branch: string } | null> {
  const branches = await getBranches();
  const allRemotes = await getRemotes();
  const mainBranchNames = ["main", "master"];

  const remotes = allRemotes.includes("origin")
    ? ["origin", ...allRemotes.filter((r) => r !== "origin")]
    : allRemotes;

  for (const branchName of mainBranchNames) {
    for (const remote of remotes) {
      const fullBranch = `${remote}/${branchName}`;
      if (branches.includes(fullBranch)) {
        return { remote, branch: branchName };
      }
      if (branches.includes(branchName)) {
        return { remote, branch: branchName };
      }
    }
  }

  return null;
}

async function update(force = false, msg: Api.Message) {
  await msg.edit({ text: "🚀 正在更新项目..." });
  console.clear();
  console.log("🚀 开始更新项目...\n");

  try {
    const branchInfo = await findMainBranch();
    if (!branchInfo) {
      throw new Error("未找到可用的远程分支 (main/master)。请确保已配置 git remote。");
    }

    const { remote, branch } = branchInfo;
    const fullBranch = `${remote}/${branch}`;

    await execAsync("git fetch --all");
    await msg.edit({ text: "🔄 正在拉取最新代码..." });

    if (force) {
      console.log(`⚠️ 强制回滚到 ${fullBranch}...`);
      await execAsync(`git reset --hard ${fullBranch}`);
      await msg.edit({ text: "🔄 强制更新中..." });
    }

    await execAsync(`git pull ${remote} ${branch} --no-rebase`);
    await msg.edit({ text: "🔄 正在合并最新代码..." });

    console.log("\n📦 安装依赖...");
    await msg.edit({ text: "📦 正在安装依赖..." });
    npm_install_project_dependencies();

    console.log("\n✅ 更新完成。");
    await msg.edit({ text: "✅ 更新完成！" });
    await loadPlugins(); // 重新加载插件
    console.log("🔄 插件已重新加载。");
    await msg.edit({ text: "🔄 插件已重新加载。" });
  } catch (error: any) {
    console.error("❌ 更新失败:", error);
    await msg.edit({
      text:
        `❌ 更新失败\n失败命令行：${error.cmd}\n失败原因：${error.stderr}\n\n` +
        "如果是 Git 冲突，请手动解决后再更新，或使用 .update -f 强制更新（会丢弃本地改动）",
    });
  }
}

class UpdatePlugin extends Plugin {
  cleanup(): void {}

  description: string = `更新项目：拉取最新代码并安装依赖\n<code>${mainPrefix}update -f/-force</code> 强制更新`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    update: async (msg) => {
      const args = msg.message.slice(1).split(" ").slice(1);
      const force = args.includes("--force") || args.includes("-f");
      await update(force, msg);
    },
  };
}

export default new UpdatePlugin();
