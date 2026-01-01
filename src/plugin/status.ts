import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import * as os from "os";
import * as fs from "fs";
import { execSync } from "child_process";
import { getPrefixes } from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义函数
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" } as any)[m] || m
  );

class Status extends Plugin {
  name = "status";
  description = "📊 显示TeleBox运行状态和资源使用情况";

  cmdHandlers = {
    status: this.handleStatus.bind(this)
  };

  private activeTimers: NodeJS.Timeout[] = [];

  private async handleStatus(msg: Api.Message) {
    try {
      await msg.edit({ text: "正在获取状态信息...", parseMode: "html" });
      const statusInfo = await this.getStatusInfo();
      await msg.edit({ text: statusInfo, parseMode: "html" });
    } catch (error) {
      await msg.edit({
        text: `❌ 获取状态信息失败：<code>${htmlEscape(String(error))}</code>`,
        parseMode: "html"
      });
    }
  }

  private async getStatusInfo(): Promise<string> {
    const startTime = Date.now();
    const hostname = os.hostname();
    const platform = os.platform();
    const uptime = os.uptime();
    const totalmem = os.totalmem();
    const freemem = os.freemem();

    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const uptimeStr = `${days}天 ${hours}小时 ${minutes}分钟`;

    const usedMem = totalmem - freemem;
    const memPercent = Math.round((usedMem / totalmem) * 100);
    
    const processMemUsage = process.memoryUsage();
    const processMemPercent = Math.round((processMemUsage.rss / totalmem) * 1000) / 10;

    const cpuUsage = await this.getCpuUsage();
    const processCpuUsage = await this.getProcessCpuUsage();
    const versions = await this.getVersionInfo();
    const systemDetails = await this.gatherSystemDetails();
    const scanTime = Date.now() - startTime;

    return [
      `📊 <b>TeleBox 运行状态</b>`,
      ``,
      `🏷️ 主机信息：`,
      `• 主机名：<code>${htmlEscape(hostname)}</code>`,
      `• 平台：<code>${platform}</code>`,
      `• 内核：<code>${htmlEscape(systemDetails.kernelInfo)}</code>`,
      ``,
      `🚀 运行环境：`,
      `• Node.js：<code>${versions.nodejs}</code>`,
      `• Telegram库：<code>${versions.telegram}</code>`,
      `• TeleBox：<code>${versions.telebox}</code>`,
      ``,
      `💻 资源使用：`,
      `• CPU：<code>${cpuUsage}%</code> / <code>${processCpuUsage}%</code>`,
      `• 内存：<code>${memPercent}%</code> / <code>${processMemPercent}%</code>`,
      `• Swap：<code>${systemDetails.swapPercent}%</code>`,
      ``,
      `⏱️ 运行时间：<code>${uptimeStr}</code>`,
      `⚡ 扫描耗时：<code>${scanTime}ms</code>`
    ].join("\n");
  }

  private async getCpuUsage(): Promise<string> {
    try {
      const platform = os.platform();
      if (platform === "win32") {
        const result = execSync('wmic cpu get loadpercentage /value', { encoding: 'utf8' });
        const match = result.match(/LoadPercentage=(\d+)/);
        return match ? parseFloat(match[1]).toFixed(2) : "0.00";
      } else {
        const cpus = os.cpus();
        let totalIdle = 0, totalTick = 0;
        cpus.forEach(cpu => {
          for (const type in cpu.times) {
            totalTick += cpu.times[type as keyof typeof cpu.times];
          }
          totalIdle += cpu.times.idle;
        });
        const usage = Math.round((1 - totalIdle / totalTick) * 100 * 100) / 100;
        return usage.toFixed(2);
      }
    } catch {
      return "0.00";
    }
  }

  private async getProcessCpuUsage(): Promise<string> {
    try {
      const startUsage = process.cpuUsage();
      const startTime = Date.now();
      await new Promise(resolve => setTimeout(resolve, 100));
      const endUsage = process.cpuUsage(startUsage);
      const endTime = Date.now();
      const elapsed = (endTime - startTime) / 1000;
      const cpuPercent = (endUsage.user + endUsage.system) / (elapsed * 1000000) * 100;
      return Math.round(cpuPercent * 100) / 100 + "";
    } catch {
      return "0.0";
    }
  }

  private async getVersionInfo(): Promise<{ nodejs: string; telegram: string; telebox: string }> {
    try {
      const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      return {
        nodejs: process.version,
        telegram: packageJson.dependencies?.telegram?.replace('^', '') || 'unknown',
        telebox: packageJson.version || 'unknown'
      };
    } catch {
      return { nodejs: process.version, telegram: 'unknown', telebox: 'unknown' };
    }
  }

  private async gatherSystemDetails(): Promise<any> {
    const platform = os.platform();
    const release = os.release();
    let kernelInfo = release;
    let swapPercent = "0.0";

    try {
      if (platform === "linux") {
        try {
          const kernel = execSync("uname -r", { encoding: "utf8" }).trim();
          kernelInfo = kernel;
        } catch {
          kernelInfo = "unknown";
        }

        try {
          const freeOutput = execSync("free | grep Swap", { encoding: "utf8" }).trim();
          const parts = freeOutput.split(/\s+/);
          if (parts.length >= 3 && parseInt(parts[1]) > 0) {
            const swapUsed = parseInt(parts[2]);
            const swapTotal = parseInt(parts[1]);
            swapPercent = ((swapUsed / swapTotal) * 100).toFixed(1);
          }
        } catch {
          swapPercent = "0.0";
        }
      } else if (platform === "win32") {
        kernelInfo = `Windows NT ${release}`;
        swapPercent = "N/A";
      } else if (platform === "darwin") {
        kernelInfo = `Darwin ${release}`;
        swapPercent = "N/A";
      }
    } catch (error) {
      console.log("[StatusPlugin] 系统详情获取失败:", error);
    }

    return { kernelInfo, swapPercent };
  }
  
  async cleanup(): Promise<void> {
    try {
      for (const timer of this.activeTimers) {
        clearTimeout(timer);
      }
      this.activeTimers = [];
      console.log("[StatusPlugin] Cleanup completed");
    } catch (error) {
      console.error("[StatusPlugin] Error during cleanup:", error);
    }
  }
}

export default new Status();