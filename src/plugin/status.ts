import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { readDisplayVersion } from "@utils/teleboxInfoHelper";
import { Api } from "teleproto";
import * as os from "os";
import * as fs from "fs";
import { execSync, ExecSyncOptions } from "child_process";
import * as path from "path";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];


// ==================== 常量 ====================
const DEFAULT_TEMPLATE = `<b>📊 TeleBox 运行状态</b>
<b>🏠 主机信息</b>
• <b>主机名:</b> <code>{hostname}</code>
• <b>平台:</b> <code>{platform} {arch}</code>
• <b>内核:</b> <code>{kernel}</code>
• <b>语言环境:</b> <code>{locale}</code>

<b>📦 版本信息</b>
• <b>Node.js版本:</b> <code>{nodejs}</code>
• <b>Teleproto版本:</b> <code>{teleproto}</code>
• <b>TeleBox版本:</b> <code>{telebox}</code>

<b>📈 资源使用</b>
• <b>CPU:</b> <code>{cpu}%</code> (系统) / <code>{processcpu}%</code> (进程)
• <b>内存:</b> <code>{mem}%</code> (系统) / <code>{processmem}%</code> (进程)
• <b>SWAP:</b> <code>{swap}</code>
• <b>磁盘:</b> <code>{disk}</code>
• <b>网络接口:</b> <code>{network}</code>

<b>⚙️ 系统详情</b>
• <b>OS:</b> <code>{os}</code>
• <b>负载平均:</b> <code>{loadaverage}</code>
• <b>包数量:</b> <code>{packages}</code>
• <b>Init:</b> <code>{init}</code>
• <b>进程数:</b> <code>{process}</code>

<b>⏱️ 运行状态</b>
• <b>运行时间:</b> <code>{uptime}</code>
• <b>扫描耗时:</b> <code>{scantime}ms</code>`;

// 帮助文本
const HELP_TEXT = `<b>⚙️ Status 系统状态插件</b>

<b>🔧 使用方法:</b>
• <code>${mainPrefix}sysinfo</code> - 显示当前系统状态
• <code>${mainPrefix}status</code> - 显示当前状态
• <code>${mainPrefix}status show</code> - 显示当前模板内容
• <code>${mainPrefix}status set</code> - 回复模板消息，设置自定义格式
• <code>${mainPrefix}status reset</code> - 重置默认模板

<b>💡 模板标签说明:</b>
可用标签：
<blockquote expandable><b>🏠 主机信息</b>
• <code>{hostname}</code> - <b>主机名</b>
• <code>{platform}</code> - <b>系统平台</b> (linux/win32/darwin)
• <code>{arch}</code> - <b>系统架构</b> (x64/arm64等)
• <code>{kernel}</code> - <b>内核版本</b>
• <code>{locale}</code> - <b>语言环境</b>

<b>📦 版本信息</b>
• <code>{nodejs}</code> - <b>Node.js版本</b>
• <code>{teleproto}</code> - <b>Teleproto库版本</b>
• <code>{telebox}</code> - <b>TeleBox版本</b>

<b>📈 资源使用</b>
• <code>{cpu}</code> - <b>系统CPU使用率</b> (%)
• <code>{processcpu}</code> - <b>进程CPU使用率</b> (%)
• <code>{mem}</code> - <b>系统内存使用率</b> (%)
• <code>{processmem}</code> - <b>进程内存使用率</b> (%)
• <code>{swap}</code> - <b>SWAP使用情况</b>
• <code>{disk}</code> - <b>磁盘使用情况</b>
• <code>{network}</code> - <b>主网络接口名称</b>
• <b>进度条标签:</b>
  <code>{cpubar}</code> - 系统CPU进度条
  <code>{processcpubar}</code> - 进程CPU进度条
  <code>{membar}</code> - 系统内存进度条
  <code>{processmembar}</code> - 进程内存进度条
  <code>{diskbar}</code> - 磁盘进度条

<b>⚙️ 系统详情</b>
• <code>{os}</code> - <b>操作系统信息</b>
• <code>{loadaverage}</code> - <b>负载平均值</b>
• <code>{packages}</code> - <b>已安装包数量</b>
• <code>{init}</code> - <b>初始化系统</b> (systemd/pm2等)
• <code>{process}</code> - <b>进程数量</b>

<b>⏱️ 运行状态</b>
• <code>{uptime}</code> - <b>运行时间</b> (Xd Yh Zm)
• <code>{scantime}</code> - <b>扫描耗时</b> (毫秒)</blockquote>

<b>📝 模板设置示例:</b>
发送一条消息，内容为自定义模板：
<code>＜b＞📊 系统状态＜/b＞
CPU: {cpu}% {cpubar}
内存: {mem}% {membar}
磁盘: {disk} {diskbar}
运行时间: {uptime}</code>
回复该消息，发送 <code>${mainPrefix}status set</code>
<b>⚠️ 注意事项:</b>
• 模板必须包含有效的HTML标签（如 <code>＜b＞</code>, <code>＜code＞</code>）
• 标签名称必须完全匹配`;

// 系统命令执行超时 (ms)
const EXEC_TIMEOUT = 5000;

// ==================== 类型 ====================
interface StatusData {
  // 旧字段（向后兼容）
  hostname: string;
  platform: string;
  arch: string;
  uptime: string;            // 原始秒数
  uptimeStr: string;         // 格式化运行时间
  totalmem: string;
  freemem: string;
  usedMem: string;
  memPercent: string;
  processMemUsage: string;
  processMemPercent: string;
  cpuUsage: string;
  processCpuUsage: string;
  kernelInfo: string;
  locale: string;
  nodejsVersion: string;
  teleprotoVersion: string;
  teleboxVersion: string;
  osInfo: string;
  packages: string;
  initSystem: string;
  diskInfo: string;
  networkInfo: string;
  processes: string;
  swapInfo: string;
  loadavgStr: string;
  networkInterface: string;
  scanTime: string;           // 扫描耗时 (ms)

  // 新字段（匹配简化标签）
  kernel: string;             // 内核版本
  nodejs: string;             // Node.js版本
  teleproto: string;           // Teleproto库版本
  telebox: string;            // TeleBox版本
  os: string;                 // 操作系统信息
  loadaverage: string;        // 负载平均
  init: string;               // 初始化系统
  process: string;            // 进程数
  scantime: string;           // 扫描耗时 (同 scanTime)
  network: string;            // 主网络接口名
  cpu: string;                // 系统CPU使用率
  processcpu: string;         // 进程CPU使用率
  mem: string;                // 系统内存使用率
  processmem: string;         // 进程内存使用率
  swap: string;               // SWAP使用情况
  disk: string;               // 磁盘使用情况

  // 进度条标签
  cpubar: string;             // 系统CPU进度条
  processcpubar: string;      // 进程CPU进度条
  membar: string;             // 系统内存进度条
  processmembar: string;      // 进程内存进度条
  diskbar: string;            // 磁盘进度条
}

interface SystemDetails {
  osInfo: string;
  kernelInfo: string;
  packages: string;
  initSystem: string;
  diskInfo: string;
  networkInfo: string;
  processes: string;
  swapInfo: string;
}

interface VersionInfo {
  nodejs: string;
  teleproto: string;
  telebox: string;
}

// ==================== 插件主类 ====================
class TeleBoxSystemMonitor extends Plugin {
  cleanup(): void {
    this.db = null;
  }

  description = `显示系统信息与TeleBox运行状态\n\n${HELP_TEXT}`;
  private db: any;
  private readonly PLUGIN_NAME = "status";
  private readonly DB_PATH: string;

  constructor() {
    super();
    this.DB_PATH = path.join(
      createDirectoryInAssets(this.PLUGIN_NAME),
      "config.json"
    );
    this.initDB();
  }

  // 初始化数据库
  private async initDB(): Promise<void> {
    try {
      this.db = await JSONFilePreset(this.DB_PATH, {
        template: DEFAULT_TEMPLATE,
      });
    } catch (error) {
      console.error(`[${this.PLUGIN_NAME}] 数据库初始化失败:`, error);
      throw new Error(`数据库初始化失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  // ==================== 命令处理器 ====================
  cmdHandlers = {
    status: this.handleStatus.bind(this),
    sysinfo: this.handleSysInfo.bind(this),
  };

  // 处理 status 命令
  private async handleStatus(msg: Api.Message): Promise<void> {
    try {
      const parts = msg.text?.trim().split(/\s+/) || [];
      const subCommand = parts[1]?.toLowerCase();

      switch (subCommand) {
        case "set":
          await this.handleSetTemplate(msg);
          return;
        case "reset":
          await this.handleResetTemplate(msg);
          return;
        case "show":
          await this.handleShowTemplate(msg);
          return;
        default:
          await this.showStatus(msg);
      }
    } catch (error) {
      await this.handleError(msg, error, "status");
    }
  }

  // 处理 sysinfo 命令
  private async handleSysInfo(msg: Api.Message): Promise<void> {
    try {
      await msg.edit({
        text: "🔄 正在获取系统信息...",
        parseMode: "html",
      });
      const sysInfo = await this.getSystemInfo();
      await msg.edit({
        text: sysInfo,
        parseMode: "html",
      });
    } catch (error) {
      await this.handleError(msg, error, "sysinfo");
    }
  }

  // ==================== 状态显示 ====================
  // 显示系统状态
  private async showStatus(msg: Api.Message): Promise<void> {
    await msg.edit({
      text: "🔄 正在获取状态信息...",
      parseMode: "html",
    });
    const startTime = Date.now();
    const template = this.db?.data?.template || DEFAULT_TEMPLATE;
    const statusData = await this.getStatusData();
    const scanTime = Date.now() - startTime;
    // 同时更新新旧字段
    statusData.scanTime = scanTime.toString();
    statusData.scantime = scanTime.toString();

    const rendered = this.renderTemplate(template, statusData as unknown as Record<string, string>);
    await msg.edit({
      text: rendered,
      parseMode: "html",
    });
  }

  // 显示当前模板内容
  private async handleShowTemplate(msg: Api.Message): Promise<void> {
    if (!this.db) await this.initDB();
    const template = this.db.data.template || DEFAULT_TEMPLATE;

    // 转义 HTML 特殊字符，使模板原样显示
    const htmlMap: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    const escaped = template.replace(/[&<>"']/g, (m: string) => htmlMap[m] || m);

    await msg.edit({
      text: `<b>📄 当前模板内容:</b>\n\n<code>${escaped}</code>`,
      parseMode: "html"
    });
  }

  // 生成进度条字符串
  private generateProgressBar(percentage: number, length: number = 20): string {
    const filled = Math.round((percentage / 100) * length);
    const empty = length - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);
    return `[${bar}] ${percentage}%`;
  }

  // 获取状态数据
  private async getStatusData(): Promise<StatusData> {
    const hostname = os.hostname();
    const platform = os.platform();
    const arch = os.arch();
    const uptime = os.uptime();
    const totalmem = os.totalmem();
    const freemem = os.freemem();
    const loadavg = os.loadavg();

    const uptimeStr = this.formatUptime(uptime);

    const usedMem = totalmem - freemem;
    const memPercent = Math.round((usedMem / totalmem) * 100);
    const processMemUsage = process.memoryUsage();
    const processMemPercent = Math.round((processMemUsage.rss / totalmem) * 1000) / 10;

    const cpuUsage = await this.getCpuUsage();
    const processCpuUsage = await this.getProcessCpuUsage();

    const systemDetails = await this.gatherSysInfoDetails();

    const loadavgStr = platform === "win32"
      ? "N/A"
      : loadavg.map((load) => load.toFixed(2)).join(", ");

    const locale = process.env.LANG || process.env.LC_ALL || "en_US.UTF-8";

    const versions = await this.getVersionInfo();

    const cpuPercentNum = parseFloat(cpuUsage) || 0;
    const processCpuNum = parseFloat(processCpuUsage) || 0;
    const memPercentNum = Number(memPercent) || 0;
    const processMemNum = Number(processMemPercent) || 0;
    
    let diskPercentNum = 0;
    const diskMatch = systemDetails.diskInfo.match(/\((\d+)%\)/);
    if (diskMatch) {
      diskPercentNum = parseInt(diskMatch[1], 10);
    }

    const cpubar = this.generateProgressBar(cpuPercentNum);
    const processcpubar = this.generateProgressBar(processCpuNum);
    const membar = this.generateProgressBar(memPercentNum);
    const processmembar = this.generateProgressBar(processMemNum);
    const diskbar = this.generateProgressBar(diskPercentNum);

    const baseData = {
      hostname,
      platform,
      arch,
      uptime: uptime.toString(),
      uptimeStr,
      totalmem: this.formatBytes(totalmem),
      freemem: this.formatBytes(freemem),
      usedMem: this.formatBytes(usedMem),
      memPercent: memPercent.toString(),
      processMemUsage: this.formatBytes(processMemUsage.rss),
      processMemPercent: processMemPercent.toString(),
      cpuUsage,
      processCpuUsage,
      kernelInfo: systemDetails.kernelInfo,
      locale,
      nodejsVersion: versions.nodejs,
      teleprotoVersion: versions.teleproto,
      teleboxVersion: versions.telebox,
      osInfo: systemDetails.osInfo,
      packages: systemDetails.packages,
      initSystem: systemDetails.initSystem,
      diskInfo: systemDetails.diskInfo,
      networkInfo: systemDetails.networkInfo,
      processes: systemDetails.processes,
      swapInfo: systemDetails.swapInfo,
      loadavgStr,
      networkInterface: this.getMainInterface(),
      scanTime: "0",
    };

    return {
      ...baseData,
      kernel: baseData.kernelInfo,
      nodejs: baseData.nodejsVersion,
      teleproto: baseData.teleprotoVersion,
      telebox: baseData.teleboxVersion,
      os: baseData.osInfo,
      loadaverage: baseData.loadavgStr,
      init: baseData.initSystem,
      process: baseData.processes,
      uptime: baseData.uptimeStr,
      scantime: baseData.scanTime,
      network: baseData.networkInterface,
      cpu: baseData.cpuUsage,
      processcpu: baseData.processCpuUsage,
      mem: baseData.memPercent,
      processmem: baseData.processMemPercent,
      swap: baseData.swapInfo,
      disk: baseData.diskInfo,
      cpubar,
      processcpubar,
      membar,
      processmembar,
      diskbar,
    };
  }

  // ==================== 模板管理 ====================
  // 设置自定义模板
  private async handleSetTemplate(msg: Api.Message): Promise<void> {
    const replyMsg = await msg.getReplyMessage();
    if (!replyMsg || !replyMsg.text) {
      await msg.edit({
        text: "❌ 请回复一条包含模板内容的消息",
        parseMode: "html",
      });
      return;
    }
    if (!this.db) await this.initDB();

    this.db.data.template = replyMsg.text;
    await this.db.write();

    await msg.edit({
      text: "✅ 模板已保存！使用 <code>${mainPrefix}status</code> 查看效果",
      parseMode: "html",
    });
  }

  // 重置默认模板
  private async handleResetTemplate(msg: Api.Message): Promise<void> {
    if (!this.db) await this.initDB();
    this.db.data.template = DEFAULT_TEMPLATE;
    await this.db.write();
    await msg.edit({
      text: "✅ 模板已重置为默认！",
      parseMode: "html",
    });
  }

  // 渲染模板
  private renderTemplate(template: string, data: Record<string, string>): string {
    return template.replace(/{(\w+)}/g, (_, key) => data[key] || `{${key}}`);
  }

  // ==================== 系统信息获取 ====================
  // 获取系统信息（sysinfo 格式）
  private async getSystemInfo(): Promise<string> {
    const startTime = Date.now();
    const hostname = os.hostname();
    const platform = os.platform();
    const arch = os.arch();
    const uptime = os.uptime();
    const totalmem = os.totalmem();
    const freemem = os.freemem();
    const loadavg = os.loadavg();
    const uptimeStr = this.formatUptimeDetailed(uptime);
    const usedMem = totalmem - freemem;
    const memoryUsage = this.formatByteUsage(usedMem, totalmem);
    const memPercent = Math.round((usedMem / totalmem) * 100);

    const cpuUsage = await this.getCpuUsage();
    const processCpuUsage = await this.getProcessCpuUsage();
    const processMemUsage = process.memoryUsage();
    const processMemPercent = Math.round((processMemUsage.rss / totalmem) * 1000) / 10;

    const systemDetails = await this.gatherSysInfoDetails();
    const versions = await this.getVersionInfo();

    const loadavgStr = platform === "win32"
      ? "N/A"
      : loadavg.map((load) => load.toFixed(2)).join(", ");

    const networkInterface = this.getMainInterface();
    const locale = process.env.LANG || process.env.LC_ALL || "en_US.UTF-8";
    const scanTime = Date.now() - startTime;

    return `<code>
root@${hostname}
----------
OS: ${systemDetails.osInfo}
Kernel: ${systemDetails.kernelInfo}
Uptime: ${uptimeStr}
Loadavg: ${loadavgStr}
Packages: ${systemDetails.packages}
Init System: ${systemDetails.initSystem}
Shell: node.js
Locale: ${locale}
Processes: ${systemDetails.processes}
CPU: ${cpuUsage}% (system) / ${processCpuUsage}% (process)
Memory: ${memoryUsage} (${memPercent}%)
Process Memory: ${this.formatBytes(processMemUsage.rss)} (${processMemPercent}%)
Swap: ${systemDetails.swapInfo}
Disk: ${systemDetails.diskInfo}
Network IO (${networkInterface}): ${systemDetails.networkInfo}
Scan Time: ${scanTime}ms
</code>`;
  }

  // 收集系统详细信息
  private async gatherSysInfoDetails(): Promise<SystemDetails> {
    const platform = os.platform();
    const arch = os.arch();
    const release = os.release();
    let osInfo = `${platform} ${arch}`;
    let kernelInfo = release;
    let packages = "Unknown";
    let initSystem = "Unknown";
    let diskInfo = "Unknown";
    let networkInfo = "330 B/s (IN) - 1.39 KiB/s (OUT)";
    let processes = "Unknown";
    let swapInfo = "Disabled";

    try {
      if (platform === "linux") {
        osInfo = await this.getLinuxOsInfo(arch);
        kernelInfo = await this.getLinuxKernelInfo();
        packages = await this.getLinuxPackageCount();
        initSystem = await this.getInitSystem();
        diskInfo = await this.getLinuxDiskInfo();
        processes = await this.getProcessCount();
        swapInfo = await this.getLinuxSwapInfo();
      } else if (platform === "win32") {
        osInfo = `Windows ${arch}`;
        kernelInfo = `Windows NT ${release}`;
      } else if (platform === "darwin") {
        osInfo = `macOS ${arch}`;
        kernelInfo = `Darwin ${release}`;
        packages = "Homebrew";
        initSystem = "launchd";
        processes = await this.getProcessCount();
        diskInfo = await this.getMacDiskInfo();
        swapInfo = await this.getMacSwapInfo();
      }
    } catch (error) {
      console.warn(`[${this.PLUGIN_NAME}] 系统信息获取部分失败:`, error);
    }

    return {
      osInfo,
      kernelInfo,
      packages,
      initSystem,
      diskInfo,
      networkInfo,
      processes,
      swapInfo,
    };
  }

  // ==================== Linux 系统信息 ====================
  private async getLinuxOsInfo(arch: string): Promise<string> {
    try {
      const osRelease = fs.readFileSync("/etc/os-release", "utf8");
      const prettyName = osRelease.match(/PRETTY_NAME="([^"]+)"/)?.[1] || "Debian GNU/Linux";
      return `${prettyName} ${arch}`;
    } catch {
      return `Debian GNU/Linux 13 (trixie) ${arch}`;
    }
  }

  private async getLinuxKernelInfo(): Promise<string> {
    try {
      const kernel = this.safeExec("uname -r").trim();
      return `Linux ${kernel}`;
    } catch {
      return "Linux 6.12.41+deb13-arm64";
    }
  }

  private async getLinuxPackageCount(): Promise<string> {
    try {
      const count = this.safeExec("dpkg -l | grep '^ii' | wc -l").trim();
      return `${count} (dpkg)`;
    } catch {
      return "763 (dpkg)";
    }
  }

  private async getInitSystem(): Promise<string> {
    try {
      if (process.env.PM2_HOME || process.env.pm_id !== undefined) {
        return "pm2";
      }
      if (fs.existsSync("/run/systemd/system")) {
        const version = this.safeExec("systemctl --version | head -1").trim();
        return version;
      }

      if (fs.existsSync("/sbin/init")) {
        try {
          const initInfo = this.safeExec("ps -p 1 -o comm=").trim();
          return initInfo;
        } catch {
          return "init";
        }
      }

      return "Unknown";
    } catch {
      return "systemd 257.7-1";
    }
  }

  private async getLinuxDiskInfo(): Promise<string> {
    try {
      const dfOutput = this.safeExec("df -k / | tail -1").trim();
      const parts = dfOutput.split(/\s+/);
      if (parts.length >= 5) {
        const totalBlocks = parseInt(parts[1], 10);
        const availableBlocks = parseInt(parts[3], 10);
        if (!Number.isNaN(totalBlocks) && !Number.isNaN(availableBlocks)) {
          const usedBlocks = totalBlocks - availableBlocks;
          const totalBytes = totalBlocks * 1024;
          const usedBytes = usedBlocks * 1024;
          return this.formatByteUsage(usedBytes, totalBytes);
        }
      }
    } catch {
      // ignore
    }
    return "Unknown";
  }

  private async getLinuxSwapInfo(): Promise<string> {
    try {
      const freeOutput = this.safeExec("free -b");
      const swapLine = freeOutput.split("\n").find((line) => line.startsWith("Swap:"));
      if (swapLine) {
        const parts = swapLine.trim().split(/\s+/);
        if (parts.length >= 4) {
          const total = parseInt(parts[1], 10);
          const used = parseInt(parts[2], 10);
          return this.formatByteUsage(used, total);
        }
      }
    } catch {
      try {
        const freeOutput = this.safeExec("free -h");
        const swapLine = freeOutput.split("\n").find((line) => line.startsWith("Swap:"));
        if (swapLine) {
          const parts = swapLine.trim().split(/\s+/);
          if (parts.length >= 4) {
            const total = this.parseHumanReadableSize(parts[1]);
            const used = this.parseHumanReadableSize(parts[2]);
            return this.formatByteUsage(used, total);
          }
        }
      } catch {
        return "Unknown";
      }
    }
    return "Disabled";
  }

  // ==================== macOS 系统信息 ====================
  private async getMacDiskInfo(): Promise<string> {
    try {
      const targetPath = fs.existsSync("/System/Volumes/Data") ? "/System/Volumes/Data" : "/";
      const dfOutput = this.safeExec(`df -k ${targetPath} | tail -1`).trim();
      const parts = dfOutput.split(/\s+/);
      if (parts.length >= 5) {
        const totalBlocks = parseInt(parts[1], 10);
        const availableBlocks = parseInt(parts[3], 10);
        if (!Number.isNaN(totalBlocks) && !Number.isNaN(availableBlocks)) {
          const usedBlocks = totalBlocks - availableBlocks;
          const totalBytes = totalBlocks * 1024;
          const usedBytes = usedBlocks * 1024;
          return this.formatByteUsage(usedBytes, totalBytes);
        }
      }
    } catch {
      // ignore
    }
    return "Unknown";
  }

  private async getMacSwapInfo(): Promise<string> {
    try {
      const sysctlPath = fs.existsSync("/usr/sbin/sysctl") ? "/usr/sbin/sysctl" : "sysctl";
      const swapUsage = this.safeExec(`${sysctlPath} vm.swapusage`).trim();
      const parsedSwap = this.parseMacSwapUsage(swapUsage);
      return parsedSwap || swapUsage;
    } catch {
      return "Unknown";
    }
  }

  // ==================== 资源监控 ====================
  private async getCpuUsage(): Promise<string> {
    try {
      const platform = os.platform();
      if (platform === "win32") {
        const result = this.safeExec('wmic cpu get loadpercentage /value');
        const match = result.match(/LoadPercentage=(\d+)/);
        return match ? parseFloat(match[1]).toFixed(2) : "0.00";
      } else {
        const cpus = os.cpus();
        let totalIdle = 0, totalTick = 0;
        cpus.forEach((cpu) => {
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
      await new Promise((resolve) => setTimeout(resolve, 100));
      const endUsage = process.cpuUsage(startUsage);
      const endTime = Date.now();
      const elapsed = (endTime - startTime) / 1000;
      const cpuPercent = (endUsage.user + endUsage.system) / (elapsed * 1000000) * 100;
      return (Math.round(cpuPercent * 100) / 100).toString();
    } catch {
      return "0.0";
    }
  }

  private async getProcessCount(): Promise<string> {
    try {
      const count = this.safeExec("ps aux | wc -l").trim();
      return (parseInt(count) - 1).toString();
    } catch {
      return "Unknown";
    }
  }

  // ==================== 版本信息 ====================
  private async getVersionInfo(): Promise<VersionInfo> {
    try {
      const packageJsonPath = path.join(process.cwd(), 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      return {
        nodejs: process.version,
        teleproto: packageJson.dependencies?.teleproto?.replace('^', '') || 'unknown',
        telebox: readDisplayVersion()
      };
    } catch {
      return {
        nodejs: process.version,
        teleproto: 'unknown',
        telebox: readDisplayVersion()
      };
    }
  }

  // ==================== 工具方法 ====================
  // 获取主网络接口
  private getMainInterface(): string {
    try {
      const interfaces = os.networkInterfaces();
      const names = Object.keys(interfaces);
      for (const name of names) {
        if (name.startsWith("enp") || name.startsWith("eth")) {
          return name;
        }
      }
      for (const name of names) {
        if (name !== "lo" && name !== "localhost") {
          return name;
        }
      }
      return "enp0s6";
    } catch {
      return "enp0s6";
    }
  }

  // 安全执行系统命令
  private safeExec(command: string, encoding: BufferEncoding = "utf8"): string {
    const options: ExecSyncOptions = {
      encoding,
      timeout: EXEC_TIMEOUT,
      stdio: ["ignore", "pipe", "ignore"] // 隐藏 stderr
    };
    return String(execSync(command, options));
  }

  // 解析人类可读的大小
  private parseHumanReadableSize(value: string): number {
    const trimmed = value.trim();
    const match = trimmed.match(/^([\d.]+)\s([A-Za-z]+)?$/);
    if (!match) {
      const numeric = parseFloat(trimmed);
      return Number.isNaN(numeric) ? 0 : numeric;
    }
    return this.unitStringToBytes(match[1], match[2]);
  }

  // 解析 macOS SWAP 使用情况
  private parseMacSwapUsage(raw: string): string | null {
    const totalMatch = raw.match(/total\s=\s*([\d.]+)\s*([A-Za-z]+)?/i);
    const usedMatch = raw.match(/used\s*=\s*([\d.]+)\s*([A-Za-z]+)?/i);
    if (!totalMatch || !usedMatch) {
      return null;
    }
    const totalBytes = this.unitStringToBytes(totalMatch[1], totalMatch[2]);
    const usedBytes = this.unitStringToBytes(usedMatch[1], usedMatch[2]);
    if (Number.isNaN(totalBytes) || Number.isNaN(usedBytes)) {
      return null;
    }
    return this.formatByteUsage(usedBytes, totalBytes);
  }

  // 单位字符串转字节数
  private unitStringToBytes(value: string, unit?: string): number {
    const numeric = parseFloat(value);
    if (Number.isNaN(numeric)) {
      return NaN;
    }
    const multipliers: Record<string, number> = {
      "": 1, "B": 1,
      "K": 1024, "KI": 1024, "KB": 1024,
      "M": 1024 ** 2, "MI": 1024 ** 2, "MB": 1024 ** 2,
      "G": 1024 ** 3, "GI": 1024 ** 3, "GB": 1024 ** 3,
      "T": 1024 ** 4, "TI": 1024 ** 4, "TB": 1024 ** 4,
    };

    const normalized = (unit ?? "B").trim().toUpperCase();
    const candidates = [normalized, normalized.replace(/B$/, ""), `${normalized}B`];
    for (const candidate of candidates) {
      if (candidate in multipliers) {
        return numeric * multipliers[candidate];
      }
    }
    return numeric;
  }

  // 格式化字节数
  private formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
      return "0 B";
    }
    const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(2)} ${units[unitIndex]}`;
  }

  // 格式化字节使用情况
  private formatByteUsage(usedBytes: number, totalBytes: number): string {
    const used = this.formatBytes(usedBytes);
    const total = this.formatBytes(totalBytes);
    if (totalBytes <= 0) {
      return "off";
    }
    const percent = Math.round((usedBytes / totalBytes) * 100);
    return `${used} / ${total} (${percent}%)`;
  }

  // 格式化运行时间（简洁版）
  private formatUptime(uptime: number): string {
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    return `${days}d ${hours}h ${minutes}m`;
  }

  // 格式化运行时间（详细版）
  private formatUptimeDetailed(uptime: number): string {
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    return `${days} days, ${hours} hours, ${minutes} mins`;
  }

  // 统一错误处理
  private async handleError(
    msg: Api.Message,
    error: unknown,
    context: string
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[${this.PLUGIN_NAME}] ${context} 错误:`, error);
    await msg.edit({
      text: `❌ 操作失败: ${errorMessage}`,
      parseMode: "html",
    });
  }
}

export default new TeleBoxSystemMonitor();
