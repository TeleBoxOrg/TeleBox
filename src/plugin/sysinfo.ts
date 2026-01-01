/**
 * TeleBox 系统信息监控插件
 */

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

class TeleBoxSystemMonitor extends Plugin {
  name = "sysinfo";
  description = "🖥️ 显示详细的系统信息";

  cmdHandlers = {
    sysinfo: this.handleSysInfo.bind(this)
  };

  private activeTimers: NodeJS.Timeout[] = [];

  private async handleSysInfo(msg: Api.Message) {
    try {
      await msg.edit({ text: "正在获取系统信息...", parseMode: "html" });
      const sysInfo = await this.getSystemInfo();
      await msg.edit({ text: sysInfo, parseMode: "html" });
    } catch (error) {
      await msg.edit({
        text: `❌ 获取系统信息失败：<code>${htmlEscape(String(error))}</code>`,
        parseMode: "html"
      });
    }
  }

  private async getSystemInfo(): Promise<string> {
    const startTime = Date.now();
    const hostname = os.hostname();
    const platform = os.platform();
    const arch = os.arch();
    const uptime = os.uptime();
    const totalmem = os.totalmem();
    const freemem = os.freemem();
    const loadavg = os.loadavg();
    const cpus = os.cpus();

    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const uptimeStr = `${days}天 ${hours}小时 ${minutes}分钟`;

    const usedMem = totalmem - freemem;
    const memoryUsage = this.formatByteUsage(usedMem, totalmem);
    const systemDetails = await this.gatherSystemDetails();
    const locale = process.env.LANG || process.env.LC_ALL || "en_US.UTF-8";
    const scanTime = Date.now() - startTime;

    const loadavgStr = platform === "win32" ? "N/A" : loadavg.map((load) => load.toFixed(2)).join(", ");
    const networkInterface = this.getMainInterface();

    return [
      `<b>🖥️ 系统信息</b>`,
      ``,
      `<b>🏷️ 基本信息：</b>`,
      `• 主机名：<code>${htmlEscape(hostname)}</code>`,
      `• 平台：<code>${platform}</code>`,
      `• 架构：<code>${arch}</code>`,
      `• 内核：<code>${htmlEscape(systemDetails.kernelInfo)}</code>`,
      `• 区域：<code>${locale}</code>`,
      ``,
      `<b>💻 资源使用：</b>`,
      `• 内存：<code>${memoryUsage}</code>`,
      `• Swap：<code>${systemDetails.swapInfo}</code>`,
      `• CPU负载：<code>${loadavgStr}</code>`,
      `• 进程数：<code>${systemDetails.processes}</code>`,
      `• 磁盘：<code>${systemDetails.diskInfo}</code>`,
      `• 网络接口：<code>${htmlEscape(networkInterface)}</code>`,
      ``,
      `<b>⏱️ 运行时间：</b>`,
      `• 系统运行：<code>${uptimeStr}</code>`,
      `• 扫描耗时：<code>${scanTime}ms</code>`
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
    let swapInfo = "off";
    let diskInfo = "Unknown";
    let processes = "Unknown";

    try {
      if (platform === "linux") {
        try {
          kernelInfo = execSync("uname -r", { encoding: "utf8" }).trim();
        } catch {
          kernelInfo = "unknown";
        }

        try {
          const swapOutput = execSync("free -h | grep Swap", { encoding: "utf8" }).trim();
          const parts = swapOutput.split(/\s+/);
          if (parts.length >= 4) {
            swapInfo = `${parts[2]} / ${parts[1]} (${parts[3]})`;
          }
        } catch {
          swapInfo = "off";
        }

        try {
          const dfOutput = execSync("df -h / | tail -1", { encoding: "utf8" }).trim();
          const parts = dfOutput.split(/\s+/);
          if (parts.length >= 5) {
            diskInfo = `${parts[2]} / ${parts[1]} (${parts[4]})`;
          }
        } catch {
          diskInfo = "Unknown";
        }

        try {
          const count = execSync("ps aux | wc -l", { encoding: "utf8" }).trim();
          processes = (parseInt(count) - 1).toString();
        } catch {
          processes = "Unknown";
        }
      } else if (platform === "win32") {
        kernelInfo = `Windows NT ${release}`;
        swapInfo = "Unknown";
        diskInfo = "Unknown";
        processes = "Unknown";
      } else if (platform === "darwin") {
        kernelInfo = `Darwin ${release}`;
        swapInfo = "Unknown";
        processes = "Unknown";
        try {
          const dfOutput = execSync("df -h /System/Volumes/Data | tail -1", { encoding: "utf8" }).trim();
          const parts = dfOutput.split(/\s+/);
          if (parts.length >= 5) {
            diskInfo = `${parts[2]} / ${parts[1]} (${parts[4]})`;
          }
        } catch {
          diskInfo = "Unknown";
        }
      }
    } catch (error) {
      console.log("[SysInfoPlugin] 系统信息获取失败:", error);
    }

    return { kernelInfo, swapInfo, diskInfo, processes };
  }

  private getMainInterface(): string {
    try {
      const interfaces = os.networkInterfaces();
      const names = Object.keys(interfaces);
      for (const name of names) {
        if (name.startsWith("enp") || name.startsWith("eth") || name.startsWith("wlan")) return name;
      }
      for (const name of names) {
        if (name !== "lo" && name !== "localhost") return name;
      }
      return "eth0";
    } catch {
      return "eth0";
    }
  }

  private formatByteUsage(usedBytes: number, totalBytes: number): string {
    const formatBytes = (bytes: number): string => {
      if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
      const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
      let value = bytes, unitIndex = 0;
      while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
      }
      return `${value.toFixed(2)} ${units[unitIndex]}`;
    };

    const used = formatBytes(usedBytes);
    const total = formatBytes(totalBytes);
    if (totalBytes <= 0) return "off";
    const percent = Math.round((usedBytes / totalBytes) * 100);
    return `${used} / ${total} (${percent}%)`;
  }
  
  async cleanup(): Promise<void> {
    try {
      for (const timer of this.activeTimers) {
        clearTimeout(timer);
      }
      this.activeTimers = [];
      console.log("[SysInfoPlugin] Cleanup completed");
    } catch (error) {
      console.error("[SysInfoPlugin] Error during cleanup:", error);
    }
  }
}

export default new TeleBoxSystemMonitor();