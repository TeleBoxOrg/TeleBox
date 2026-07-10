import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInTemp, createDirectoryInAssets } from "@utils/pathHelpers";
import { Api } from "teleproto";
import { CustomFile } from "teleproto/client/uploads.js";
import { JSONFilePreset } from "lowdb/node";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import archiver from "archiver";
import dayjs from "dayjs";
import crypto from "crypto";

// SSH2模块直接导入 - 跳过类型检查
// @ts-ignore
import { Client as SSH2Client } from 'ssh2';

const execAsync = promisify(exec);
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义函数
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// Shell参数转义函数 - 防止命令注入
const shellEscape = (arg: string): string => {
  // 移除危险字符，防止命令注入
  return arg.replace(/[`$!\\]/g, '\\$&')
            .replace(/['"]/g, '\\$&')
            .replace(/[\r\n]/g, '');
};

// 验证路径安全性
function validatePath(pathStr: string): boolean {
  if (!pathStr || typeof pathStr !== "string") return false;
  // 检查危险字符
  const dangerousChars = /[;&|`$(){}[\]<>'"\\]/;
  if (dangerousChars.test(pathStr)) return false;
  // 检查路径遍历
  if (pathStr.includes("../") || pathStr.includes("..\\")) return false;
  return true;
}

// 端口验证函数
const validatePort = (port: string): number | null => {
  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return null;
  }
  return portNum;
};

// 检查端口是否被占用
async function checkPortInUse(port: number): Promise<{ inUse: boolean; processInfo?: string }> {
  try {
    // 使用netstat检查端口占用情况
    const { stdout } = await execAsync(`netstat -tlnp 2>/dev/null | grep ":${port} "`);
    if (stdout.trim()) {
      // 解析进程信息
      const lines = stdout.trim().split('\n');
      const processInfos: string[] = [];
      
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 7) {
          const protocol = parts[0];
          const address = parts[3];
          const processInfo = parts[6];
          
          let processName = '未知进程';
          if (processInfo && processInfo !== '-') {
            const pid = processInfo.split('/')[0];
            if (pid && pid !== '-') {
              try {
                const { stdout: nameOutput } = await execAsync(`ps -p ${pid} -o comm= 2>/dev/null || echo "未知"`);
                processName = nameOutput.trim() || '未知进程';
              } catch {
                processName = '未知进程';
              }
            }
          }
          
          processInfos.push(`${protocol} ${address} (${processName})`);
        }
      }
      
      return {
        inUse: true,
        processInfo: processInfos.join(', ')
      };
    }
    
    return { inUse: false };
  } catch (error) {
    // 如果netstat失败，尝试使用ss命令
    try {
      const { stdout } = await execAsync(`ss -tlnp 2>/dev/null | grep ":${port} "`);
      if (stdout.trim()) {
        return {
          inUse: true,
          processInfo: '端口被占用 (详细信息获取失败)'
        };
      }
      return { inUse: false };
    } catch {
      // 如果两个命令都失败，尝试简单的端口连接测试
      try {
        await execAsync(`timeout 2 bash -c "</dev/tcp/localhost/${port}" 2>/dev/null`);
        return {
          inUse: true,
          processInfo: '端口被占用 (无法获取进程信息)'
        };
      } catch {
        return { inUse: false };
      }
    }
  }
};

// 密码复杂度验证
const validatePassword = (password: string): boolean => {
  return password.length >= 8;
};

// 配置键定义
const CONFIG_KEYS = {
  TARGET_CHAT: "ssh_target_chat",
  SSH_PORT: "ssh_ssh_port",
  PASSWORD_AUTH: "ssh_password_auth",
  PUBKEY_AUTH: "ssh_pubkey_auth"
};

// 默认配置
const DEFAULT_CONFIG: Record<string, string> = {
  [CONFIG_KEYS.TARGET_CHAT]: "me",
  [CONFIG_KEYS.SSH_PORT]: "22",
  [CONFIG_KEYS.PASSWORD_AUTH]: "no",
  [CONFIG_KEYS.PUBKEY_AUTH]: "yes"
};

// 配置管理器
class ConfigManager {
  private static db: any = null;
  private static initialized = false;
  private static initLock = false;  // 添加锁防止并发初始化
  private static configPath: string;

  static cleanup(): void {
    // 引用重置：清空实例级 db / cache / manager 引用，便于 reload 后重新初始化。
    this.db = null;
    this.initialized = false;
    this.initLock = false;
    this.configPath = "";
  }

  private static async init(): Promise<void> {
    if (this.initialized) return;
    
    // 简单的锁机制防止并发初始化
    while (this.initLock) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    if (this.initialized) return;
    this.initLock = true;
    
    try {
      this.configPath = path.join(
        createDirectoryInAssets("sshkey"),
        "sshkey_config.json"
      );
      this.db = await JSONFilePreset<Record<string, any>>(
        this.configPath,
        { ...DEFAULT_CONFIG }
      );
      this.initialized = true;
    } catch (error) {
      console.error("[ssh] 初始化配置失败:", error);
    } finally {
      this.initLock = false;
    }
  }

  static async get(key: string, defaultValue?: string): Promise<string> {
    await this.init();
    if (!this.db) return defaultValue || DEFAULT_CONFIG[key] || "";
    const value = this.db.data[key];
    return value ?? defaultValue ?? DEFAULT_CONFIG[key] ?? "";
  }

  static async set(key: string, value: string): Promise<boolean> {
    await this.init();
    if (!this.db) return false;
    try {
      this.db.data[key] = value;
      await this.db.write();
      return true;
    } catch (error) {
      console.error(`[ssh] 设置配置失败 ${key}:`, error);
      return false;
    }
  }
}

// 帮助文本
// SSH服务重启通用函数
const restartSSHService = async (): Promise<{ success: boolean; command?: string }> => {
  const commands = [
    "systemctl restart sshd",
    "systemctl restart ssh",
    "service sshd restart",
    "service ssh restart",
    "/etc/init.d/ssh restart"
  ];
  
  for (const cmd of commands) {
    try {
      await execAsync(cmd);
      return { success: true, command: cmd };
    } catch {
      continue;
    }
  }
  return { success: false };
};

// SSH配置修改通用函数
const modifySSHConfig = async (
  key: string,
  value: string,
  backup: boolean = true
): Promise<string> => {
  const timestamp = dayjs().format("YYYYMMDD_HHmmss");
  
  if (backup) {
    await execAsync(`cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup.${timestamp}`);
  }
  
  // 使用安全的配置修改方式
  const escapedKey = shellEscape(key);
  const escapedValue = shellEscape(value);
  
  // 修改或添加配置
  await execAsync(`sed -i 's/^#*${escapedKey} .*/${escapedKey} ${escapedValue}/' /etc/ssh/sshd_config`);
  
  // 确保没有重复配置
  await execAsync(`grep -q '^${escapedKey} ${escapedValue}$' /etc/ssh/sshd_config || echo '${escapedKey} ${escapedValue}' >> /etc/ssh/sshd_config`);
  
  // 验证配置文件语法
  await execAsync(`sshd -t`);
  
  return timestamp;
};

const help_text = `🔐 <b>SSH管理插件</b>

<b>密钥管理：</b>
• <code>${mainPrefix}ssh gen add</code> - 生成新密钥并追加到现有密钥
• <code>${mainPrefix}ssh gen replace</code> - 生成新密钥并替换所有旧密钥
• <code>${mainPrefix}ssh keys</code> - 查看当前授权的所有密钥
• <code>${mainPrefix}ssh keys clear</code> - 清空所有授权密钥
• <code>${mainPrefix}ssh keys export</code> - 导出所有密钥到文件

<b>服务器配置：</b>
• <code>${mainPrefix}ssh passwd &lt;新密码&gt;</code> - 修改root密码
• <code>${mainPrefix}ssh port &lt;端口号&gt;</code> - 修改SSH端口
• <code>${mainPrefix}ssh pwauth on/off</code> - 开启/关闭密码登录
• <code>${mainPrefix}ssh keyauth on/off</code> - 开启/关闭密钥登录  
• <code>${mainPrefix}ssh rootlogin on/off/keyonly</code> - 控制root登录方式
• <code>${mainPrefix}ssh enableroot &lt;密码&gt;</code> - 启用root账户直接登录
• <code>${mainPrefix}ssh open &lt;端口&gt;</code> - 开放防火墙端口
• <code>${mainPrefix}ssh close &lt;端口&gt;</code> - 关闭防火墙端口
• <code>${mainPrefix}ssh restart</code> - 重启SSH服务

<b>管理命令：</b>
• <code>${mainPrefix}ssh set @username</code> - 设置发送到指定用户
• <code>${mainPrefix}ssh set me</code> - 重置为默认发送到收藏夹
• <code>${mainPrefix}ssh info</code> - 查看SSH状态和配置

<b>示例：</b>
<code>${mainPrefix}ssh gen replace</code> - 生成新密钥并清空旧密钥
<code>${mainPrefix}ssh keys export</code> - 导出所有密钥到文件`;

class SSHPlugin extends Plugin {
  cleanup(): void {
    ConfigManager.cleanup();
  }

  async setup(): Promise<void> {
    // Re-initialize ConfigManager after cleanup/reload
    await ConfigManager.get(CONFIG_KEYS.TARGET_CHAT);
  }

  description: string = `SSH管理和服务器配置<br><br>${help_text}`;

  cmdHandlers = {
    ssh: async (msg: Api.Message) => {
      await this.handleSSH(msg);
    }
  };

  // 主命令处理器
  private async handleSSH(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
      return;
    }

    // 检查执行权限 - 只能在收藏夹或指定会话执行
    const isPrivate = msg.isPrivate;
    const chatId = msg.chatId?.toString();
    const userId = msg.senderId?.toString();
    const targetChat = await ConfigManager.get(CONFIG_KEYS.TARGET_CHAT);
    
    // 检查是否在允许的位置执行
    let canExecute = false;
    
    if (isPrivate && chatId === userId) {
      // 收藏夹
      canExecute = true;
    } else if (targetChat !== "me" && chatId === targetChat) {
      // 指定的目标会话
      canExecute = true;
    }
    
    if (!canExecute) {
      await msg.edit({
        text: "🔒 <b>权限限制</b><br><br>此SSH管理插件只能在以下位置执行：<br>• 收藏夹<br>• 已设置的目标会话<br><br>💡 当前目标: <code>" + htmlEscape(targetChat === "me" ? "收藏夹" : targetChat) + "</code><br>⚠️ 请在允许的位置使用此插件",
        parseMode: "html"
      });
      return;
    }

    const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
    const parts = lines?.[0]?.split(/\s+/) || [];
    const [, ...args] = parts;
    const sub = (args[0] || "").toLowerCase();

    try {
      if (!sub) {
        // 无参数时显示帮助
        await msg.edit({ text: help_text, parseMode: "html" });
        return;
      }

      if (sub === "help" || sub === "h") {
        await msg.edit({ text: help_text, parseMode: "html" });
        return;
      }

      switch (sub) {
        case "gen":
          // 只支持 gen add 和 gen replace
          const genMode = args[1]?.toLowerCase();
          if (genMode === "replace") {
            await this.generateSSHKeys(msg, client, "replace");
          } else if (genMode === "add") {
            await this.generateSSHKeys(msg, client, "add");
          } else {
            await msg.edit({
              text: `❌ <b>无效的生成模式</b><br><br>用法:<br>• <code>${mainPrefix}ssh gen add</code> - 生成新密钥并追加<br>• <code>${mainPrefix}ssh gen replace</code> - 生成新密钥并替换所有旧密钥`,
              parseMode: "html"
            });
          }
          break;

        case "keys":
          const keysAction = args[1]?.toLowerCase();
          if (keysAction === "clear") {
            await this.clearAuthorizedKeys(msg);
          } else if (keysAction === "export") {
            await this.exportAuthorizedKeys(msg);
          } else {
            await this.listAuthorizedKeys(msg);
          }
          break;

        case "passwd":
        case "password":
          await this.changePassword(msg, args.slice(1));
          break;

        case "port":
          await this.changeSSHPort(msg, args[1]);
          break;

        case "pwauth":
          await this.togglePasswordAuth(msg, args[1]);
          break;

        case "keyauth":
          await this.toggleKeyAuth(msg, args[1]);
          break;

        case "rootlogin":
          await this.toggleRootLogin(msg, args[1]);
          break;

        case "enableroot":
          await this.enableRootAccount(msg, args.slice(1));
          break;

        case "open":
          await this.openPort(msg, args[1]);
          break;

        case "close":
          await this.closePort(msg, args[1]);
          break;

        case "set":
          await this.setTarget(msg, args.slice(1).join(" "));
          break;

        case "info":
          await this.showInfo(msg);
          break;

        case "restart":
          await this.restartSSH(msg);
          break;

        default:
          await msg.edit({
            parseMode: "html"
          });
      }
    } catch (error: any) {
      console.error("[ssh] 执行失败:", error);
      await msg.edit({
        text: `❌ <b>执行失败:</b> ${htmlEscape(error.message || "未知错误")}`,
        parseMode: "html"
      });
    }
  }

  // 生成SSH密钥
  private async generateSSHKeys(msg: Api.Message, client: any, mode: "add" | "replace" = "add"): Promise<void> {
    await msg.edit({ text: "🔄 正在生成SSH密钥对...", parseMode: "html" });

    const timestamp = dayjs().format("YYYYMMDD_HHmmss");
    const workDir = path.join(createDirectoryInTemp("sshkey"), `keys_${timestamp}`);
    const keyName = `ssh_key_${timestamp}`;

    try {
      // 创建工作目录
      fs.mkdirSync(workDir, { recursive: true });

      // 生成RSA密钥对 - 使用验证过的路径
      if (!validatePath(keyName)) {
        throw new Error("密钥名称包含非法字符");
      }
      const keyPath = path.join(workDir, keyName);
      const escapedPath = shellEscape(keyPath);
      const escapedComment = shellEscape(`generated_${timestamp}`);
      
      await execAsync(`ssh-keygen -t rsa -b 4096 -f ${escapedPath} -N "" -C ${escapedComment}`);

      // 读取密钥文件
      const privateKey = fs.readFileSync(keyPath, "utf-8");
      const publicKey = fs.readFileSync(`${keyPath}.pub`, "utf-8").trim();

      // 验证公钥格式
      const keyParts = publicKey.split(/\s+/);
      if (keyParts.length < 2 || !keyParts[0].startsWith('ssh-')) {
        throw new Error("生成的公钥格式无效");
      }

      // 尝试转换为PPK格式
      let ppkKey = "";
      try {
        // 首先检查 puttygen 是否可用
        try {
          await execAsync('puttygen --version');
        } catch {
          // puttygen 不可用，尝试安装 putty-tools
          console.log("[ssh] puttygen 未找到，正在安装 putty-tools...");
          try {
            await execAsync('apt-get update && apt-get install -y putty-tools');
          } catch {
            throw new Error("无法安装 putty-tools");
          }
        }
        
        // 转换为PPK格式
        await execAsync(`puttygen ${escapedPath} -o ${escapedPath}.ppk`);
        ppkKey = fs.readFileSync(`${keyPath}.ppk`, "utf-8");
        console.log("[ssh] PPK格式密钥生成成功");
      } catch (error: any) {
        console.log(`[ssh] PPK转换失败: ${error.message}，跳过PPK格式`);
      }

      // 获取服务器信息
      const hostname = (await execAsync("hostname")).stdout.trim();
      const ipAddress = (await execAsync("curl -s ifconfig.me || echo '未知'")).stdout.trim();
      const sshPort = await ConfigManager.get(CONFIG_KEYS.SSH_PORT, "22");

      // 创建信息文件
      const infoText = `SSH密钥信息<br>==================<br>生成时间: ${dayjs().format("YYYY-MM-DD HH:mm:ss")}<br>服务器: ${hostname}<br>IP地址: ${ipAddress}<br>SSH端口: ${sshPort}<br><br>文件说明<br>==================<br>- ${keyName}: RSA私钥 (OpenSSH格式)<br>- ${keyName}.pub: RSA公钥<br>${ppkKey ? `- ${keyName}.ppk: RSA私钥 (PuTTY格式)\n` : ""}<br>使用方法<br>==================<br>1. 保存私钥文件到本地<br>2. 设置私钥文件权限: chmod 600 ${keyName}<br>3. 使用SSH连接:<br>   ssh -i ${keyName} root@${ipAddress} -p ${sshPort}<br>${ppkKey ? `\n使用PuTTY/WinSCP:\n   使用 ${keyName}.ppk 文件作为私钥\n` : ""}<br>公钥内容<br>==================<br>${publicKey}`;

      fs.writeFileSync(path.join(workDir, "key_info.txt"), infoText);

      // 创建压缩包
      const archivePath = path.join(workDir, "ssh_keys_package.zip");
      await this.createArchive(workDir, archivePath, [
        keyName,
        `${keyName}.pub`,
        ppkKey ? `${keyName}.ppk` : null,
        "key_info.txt"
      ].filter(Boolean) as string[]);

      // 检查是否为首次生成密钥
      const isFirstTime = !fs.existsSync("/root/.ssh/authorized_keys") || 
                          fs.readFileSync("/root/.ssh/authorized_keys", "utf-8").trim() === "";
      
      // 更新authorized_keys - 改进的方式并设置正确权限
      await execAsync(`mkdir -p /root/.ssh`);
      
      if (isFirstTime) {
        await msg.edit({ text: "🔄 首次生成密钥，正在设置SSH环境...", parseMode: "html" });
        
        // 首次设置，确保所有权限正确
        await execAsync(`chmod 700 /root/.ssh`);
        
        // 创建authorized_keys文件并设置权限
        fs.writeFileSync("/root/.ssh/authorized_keys", publicKey + "\n");
        await execAsync(`chmod 600 /root/.ssh/authorized_keys`);
        
        // 设置SSH配置目录的所有者
        await execAsync(`chown -R root:root /root/.ssh`);
        
      } else if (mode === "replace") {
        // 替换模式：备份旧密钥后替换
        const backupTimestamp = dayjs().format("YYYYMMDD_HHmmss");
        try {
          await execAsync(`cp /root/.ssh/authorized_keys /root/.ssh/authorized_keys.backup.${backupTimestamp} 2>/dev/null || true`);
        } catch {}
        
        await msg.edit({ text: "🔄 正在替换密钥...", parseMode: "html" });
        // 直接写入公钥，确保格式正确
        fs.writeFileSync("/root/.ssh/authorized_keys", publicKey + "\n");
        
      } else {
        // 追加模式：检查密钥是否已存在
        let existingKeys = "";
        try {
          existingKeys = fs.readFileSync("/root/.ssh/authorized_keys", "utf-8");
        } catch {}
        
        // 检查密钥是否已存在（通过比较公钥数据部分）
        const newKeyData = keyParts[1];
        if (existingKeys.includes(newKeyData)) {
          await msg.edit({ text: "⚠️ 密钥已存在，跳过添加...", parseMode: "html" });
        } else {
          // 追加新密钥
          fs.appendFileSync("/root/.ssh/authorized_keys", publicKey + "\n");
        }
      }
      
      // 确保权限始终正确
      await execAsync(`chmod 700 /root/.ssh`);
      await execAsync(`chmod 600 /root/.ssh/authorized_keys`);
      
      // 如果是首次生成，还需要确保SSH服务配置
      if (isFirstTime) {
        await msg.edit({ text: "🔄 首次设置，正在优化SSH配置...", parseMode: "html" });
        
        // 确保SSH服务允许密钥认证
        try {
          await modifySSHConfig("PubkeyAuthentication", "yes", false);
          await modifySSHConfig("AuthorizedKeysFile", "/root/.ssh/authorized_keys", false);
        } catch (configError) {
          console.log("[ssh] SSH配置优化失败，但密钥已正确设置:", configError);
        }
      }

      // 获取目标会话
      const targetChat = await ConfigManager.get(CONFIG_KEYS.TARGET_CHAT);
      let peer: any;

      if (targetChat === "me") {
        peer = "me";
      } else {
        try {
          peer = await client.getEntity(targetChat);
        } catch {
          peer = "me";
          await msg.reply({ 
            message: `⚠️ 无法找到指定会话 ${targetChat}，已发送到收藏夹`,
            parseMode: "html"
          });
        }
      }

      // 发送文件
      await client.sendFile(peer, {
        file: new CustomFile(
          "ssh_keys_package.zip",
          fs.statSync(archivePath).size,
          "",
          fs.readFileSync(archivePath)
        ),
        caption: `🔐 <b>SSH密钥包</b> - ${hostname} - ${timestamp}<br><br><b>包含文件：</b><br>• RSA私钥 (OpenSSH格式)<br>• RSA公钥<br>${ppkKey ? "• RSA私钥 (PPK格式)<br>" : ""}• 使用说明<br><br>⚠️ <b>请妥善保管私钥文件</b>`,
        parseMode: "html"
      });

      const modeText = mode === "replace" ? "已替换所有旧密钥" : "已追加到现有密钥";
      
      // 验证密钥是否正确添加
      let keyCount = 0;
      try {
        const keysContent = fs.readFileSync("/root/.ssh/authorized_keys", "utf-8");
        keyCount = keysContent.trim().split('\n').filter(line => line.trim() && !line.startsWith('#')).length;
      } catch {}

      // 生成状态消息
      let setupMessage = "";
      if (isFirstTime) {
        setupMessage = "<br><br>🎉 <b>首次SSH设置完成:</b><br>• SSH目录权限: 700 (drwx------)<br>• 密钥文件权限: 600 (-rw-------)<br>• SSH配置已优化";
      }
      
      await msg.edit({
        text: `✅ <b>SSH密钥生成成功</b><br><br>📁 密钥包已发送到: ${targetChat === "me" ? "收藏夹" : htmlEscape(targetChat)}<br>🔑 公钥${modeText}<br>📊 当前共有 ${keyCount} 个授权密钥<br><br><b>服务器信息：</b><br>🖥️ 主机: ${htmlEscape(hostname)}<br>🌐 IP: ${htmlEscape(ipAddress)}<br>🔌 端口: ${htmlEscape(sshPort)}<br><br><b>连接命令：</b><br><code>ssh -i ${htmlEscape(keyName)} root@${htmlEscape(ipAddress)} -p ${htmlEscape(sshPort)}</code>${setupMessage}<br><br>💡 <b>提示：</b><br>• 请下载并保存私钥文件<br>• 本地设置权限: <code>chmod 600 ${htmlEscape(keyName)}</code><br>• 使用 <code>${htmlEscape(mainPrefix)}ssh keys</code> 查看所有密钥`,
        parseMode: "html"
      });

      // 清理临时文件
      fs.rmSync(workDir, { recursive: true, force: true });

    } catch (error: any) {
      // 清理临时文件
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
      throw error;
    }
  }

  // 查看授权密钥列表
  private async listAuthorizedKeys(msg: Api.Message): Promise<void> {
    await msg.edit({ text: "🔄 正在查看授权密钥...", parseMode: "html" });

    try {
      const authorizedKeysPath = "/root/.ssh/authorized_keys";
      
      // 检查文件是否存在
      try {
        await execAsync(`test -f ${authorizedKeysPath}`);
      } catch {
        await msg.edit({
          text: "❌ <b>未找到授权密钥文件</b><br><br>文件路径: <code>/root/.ssh/authorized_keys</code><br>状态: 不存在",
          parseMode: "html"
        });
        return;
      }

      // 读取并解析密钥
      const { stdout } = await execAsync(`cat ${authorizedKeysPath}`);
      const lines = stdout.trim().split('\n').filter(line => line.trim() && !line.startsWith('#'));
      
      if (lines.length === 0) {
        await msg.edit({
          text: "📋 <b>授权密钥列表</b><br><br>当前没有任何授权密钥",
          parseMode: "html"
        });
        return;
      }

      let keyList = "📋 <b>授权密钥列表</b><br><br>";
      keyList += `📊 <b>总计:</b> ${lines.length} 个密钥<br><br>`;
      
      lines.forEach((line, index) => {
        const trimmedLine = line.trim();
        let keyType = '未知类型';
        let keyData = '';
        let comment = '无备注';
        
        // SSH密钥格式: <type> <base64-key> [comment]
        // 支持的类型: ssh-rsa, ssh-dss, ecdsa-sha2-nistp256, ssh-ed25519等
        const sshKeyTypes = ['ssh-rsa', 'ssh-dss', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-ed25519'];
        
        // 尝试解析标准格式
        const parts = trimmedLine.split(/\s+/);
        
        if (parts.length >= 2) {
          // 检查第一部分是否是有效的密钥类型
          if (sshKeyTypes.includes(parts[0])) {
            keyType = parts[0];
            keyData = parts[1];
            comment = parts.slice(2).join(' ') || '无备注';
          } else {
            // 可能是格式错误的密钥，尝试识别
            // 如果第一部分看起来像base64编码
            if (/^[A-Za-z0-9+/=]+$/.test(parts[0]) && parts[0].length > 50) {
              keyType = '⚠️ 格式错误';
              keyData = parts[0];
              comment = parts.slice(1).join(' ') || '无备注';
            } else {
              // 完全无法识别的格式
              keyType = '❌ 无效格式';
              keyData = trimmedLine.substring(0, 50);
              comment = '解析失败';
            }
          }
        } else if (parts.length === 1) {
          // 只有一个部分，可能是裸密钥
          keyType = '⚠️ 缺少类型';
          keyData = parts[0];
          comment = '无备注';
        }
        
        // 生成密钥预览
        let keyPreview = '无效密钥';
        if (keyData && keyData.length > 20) {
          keyPreview = `${keyData.substring(0, 20)}...${keyData.substring(keyData.length - 10)}`;
        }
        
        keyList += `🔑 <b>密钥 ${index + 1}:</b><br>`;
        keyList += `   类型: <code>${htmlEscape(keyType)}</code><br>`;
        keyList += `   备注: <code>${htmlEscape(comment)}</code><br>`;
        keyList += `   预览: <code>${htmlEscape(keyPreview)}</code><br>`;
        
        // 如果密钥格式有问题，添加警告
        if (keyType.includes('⚠️') || keyType.includes('❌')) {
          keyList += `   <i>⚠️ 此密钥可能无法正常使用</i><br>`;
        }
        
        keyList += `<br>`;
      });
      
      keyList += `💡 <b>提示:</b><br>`;
      keyList += `• 使用 <code>${mainPrefix}ssh keys clear</code> 清空所有密钥<br>`;
      keyList += `• 使用 <code>${mainPrefix}ssh gen replace</code> 重新生成并替换所有密钥`;

      await msg.edit({
        text: keyList,
        parseMode: "html"
      });
      
    } catch (error: any) {
      throw new Error(`查看授权密钥失败: ${error.message}`);
    }
  }

  // 清空授权密钥
  private async clearAuthorizedKeys(msg: Api.Message): Promise<void> {
    await msg.edit({ text: "⚠️ 正在清空所有授权密钥...", parseMode: "html" });

    try {
      const authorizedKeysPath = "/root/.ssh/authorized_keys";
      
      // 备份现有密钥
      const timestamp = dayjs().format("YYYYMMDD_HHmmss");
      try {
        await execAsync(`cp ${authorizedKeysPath} ${authorizedKeysPath}.backup.${timestamp}`);
      } catch {
        // 文件不存在时忽略备份错误
      }
      
      // 清空密钥文件
      await execAsync(`mkdir -p /root/.ssh && chmod 700 /root/.ssh`);
      await execAsync(`> ${authorizedKeysPath}`);
      await execAsync(`chmod 600 ${authorizedKeysPath}`);

      await msg.edit({
        text: `✅ <b>授权密钥已清空</b><br><br>🗂️ 备份文件: <code>${authorizedKeysPath}.backup.${timestamp}</code><br><br>⚠️ <b>警告:</b> 所有SSH密钥登录已失效，请确保有其他方式访问服务器`,
        parseMode: "html"
      });
      
    } catch (error: any) {
      throw new Error(`清空授权密钥失败: ${error.message}`);
    }
  }

  // 导出授权密钥
  private async exportAuthorizedKeys(msg: Api.Message): Promise<void> {
    await msg.edit({ text: "🔄 正在导出授权密钥...", parseMode: "html" });

    try {
      const authorizedKeysPath = "/root/.ssh/authorized_keys";
      
      // 检查文件是否存在
      try {
        await execAsync(`test -f ${authorizedKeysPath}`);
      } catch {
        await msg.edit({
          text: "❌ <b>未找到授权密钥文件</b><br><br>文件路径: <code>/root/.ssh/authorized_keys</code><br>状态: 不存在",
          parseMode: "html"
        });
        return;
      }

      // 读取密钥内容
      const { stdout } = await execAsync(`cat ${authorizedKeysPath}`);
      const keysContent = stdout.trim();
      
      if (!keysContent) {
        await msg.edit({
          text: "📋 <b>授权密钥为空</b><br><br>当前没有任何授权密钥可导出",
          parseMode: "html"
        });
        return;
      }

      const lines = keysContent.split('\n').filter(line => line.trim() && !line.startsWith('#'));
      
      // 获取服务器信息
      const hostname = (await execAsync("hostname")).stdout.trim();
      const timestamp = dayjs().format("YYYYMMDD_HHmmss");
      
      // 创建导出文件
      const workDir = path.join(createDirectoryInTemp("ssh_export"), `keys_${timestamp}`);
      fs.mkdirSync(workDir, { recursive: true });
      
      // 生成导出内容
      const exportContent = `# SSH授权密钥导出文件
# 导出时间: ${dayjs().format("YYYY-MM-DD HH:mm:ss")}
# 服务器: ${hostname}
# 密钥数量: ${lines.length}
# 文件路径: /root/.ssh/authorized_keys
#
# 使用方法:
# 1. 将此文件内容追加到目标服务器的 ~/.ssh/authorized_keys 文件
# 2. 确保文件权限正确: chmod 600 ~/.ssh/authorized_keys
# 3. 确保目录权限正确: chmod 700 ~/.ssh
#
# 注意: 请妥善保管此文件，它包含可以访问服务器的公钥信息
#

${keysContent}`;

      const exportPath = path.join(workDir, "authorized_keys_export.txt");
      fs.writeFileSync(exportPath, exportContent);

      // 同时创建纯密钥文件（无注释）
      const pureKeysPath = path.join(workDir, "authorized_keys");
      fs.writeFileSync(pureKeysPath, keysContent);

      // 创建压缩包
      const archivePath = path.join(workDir, "ssh_keys_export.zip");
      await this.createArchive(workDir, archivePath, [
        "authorized_keys_export.txt",
        "authorized_keys"
      ]);

      // 获取目标会话并发送文件
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({
          text: `✅ <b>密钥导出完成</b><br><br>📊 密钥数量: ${lines.length}<br>📁 文件已生成，但无法发送<br><br>请检查客户端连接`,
          parseMode: "html"
        });
        return;
      }

      const targetChat = await ConfigManager.get(CONFIG_KEYS.TARGET_CHAT);
      let peer: any;

      if (targetChat === "me") {
        peer = "me";
      } else {
        try {
          peer = await client.getEntity(targetChat);
        } catch {
          peer = "me";
        }
      }

      // 发送导出文件
      await client.sendFile(peer, {
        file: new CustomFile(
          "ssh_keys_export.zip",
          fs.statSync(archivePath).size,
          "",
          fs.readFileSync(archivePath)
        ),
        caption: `📦 <b>SSH密钥导出包</b><br><br>🖥️ 服务器: ${hostname}<br>📊 密钥数量: ${lines.length}<br>📅 导出时间: ${dayjs().format("YYYY-MM-DD HH:mm:ss")}<br><br>📁 <b>包含文件:</b><br>• authorized_keys_export.txt (带注释说明)<br>• authorized_keys (纯密钥文件)<br><br>⚠️ <b>安全提示:</b> 请妥善保管密钥文件`,
        parseMode: "html"
      });

      await msg.edit({
        text: `✅ <b>密钥导出成功</b><br><br>📊 导出密钥数量: ${lines.length}<br>📁 文件已发送到: ${targetChat === "me" ? "收藏夹" : htmlEscape(targetChat)}<br><br>💡 <b>文件说明:</b><br>• 带注释的完整导出文件<br>• 纯净的authorized_keys文件<br>• 可直接用于其他服务器配置`,
        parseMode: "html"
      });

      // 清理临时文件
      fs.rmSync(workDir, { recursive: true, force: true });

    } catch (error: any) {
      throw new Error(`导出授权密钥失败: ${error.message}`);
    }
  }

  // 修改root密码
  private async changePassword(msg: Api.Message, args: string[]): Promise<void> {
    const newPassword = args.join(" ").trim();
    
    if (!newPassword) {
      await msg.edit({
        text: `❌ <b>请提供新密码</b><br><br>示例: <code>${mainPrefix}ssh passwd 新密码123</code>`,
        parseMode: "html"
      });
      return;
    }

    // 验证密码复杂度
    if (!validatePassword(newPassword)) {
      await msg.edit({
        text: `❌ <b>密码不符合要求</b><br><br>密码长度至少8位`,
        parseMode: "html"
      });
      return;
    }

    await msg.edit({ text: "🔄 正在修改root密码...", parseMode: "html" });

    try {
      // 使用转义的密码防止命令注入
      const escapedPassword = shellEscape(newPassword);
      await execAsync(`echo "root:${escapedPassword}" | chpasswd`);

      // 不显示明文密码
      await msg.edit({
        text: `✅ <b>root密码修改成功</b><br><br>⚠️ 请妥善保管新密码`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`修改密码失败: ${error.message}`);
    }
  }

  // 修改SSH端口
  private async changeSSHPort(msg: Api.Message, portStr: string): Promise<void> {
    const port = validatePort(portStr);
    
    if (!port) {
      await msg.edit({
        text: `❌ <b>无效的端口号</b><br><br>端口范围: 1-65535<br>示例: <code>${mainPrefix}ssh port 2222</code>`,
        parseMode: "html"
      });
      return;
    }

    await msg.edit({ text: `🔄 正在检查端口 ${port} 是否可用...`, parseMode: "html" });

    try {
      // 获取当前SSH端口，用于后续关闭旧端口防火墙
      const currentPort = await ConfigManager.get(CONFIG_KEYS.SSH_PORT, "22");
      
      // 检查端口冲突（跳过当前SSH端口检查）
      if (String(port) !== currentPort) {
        const portCheck = await checkPortInUse(port);
        if (portCheck.inUse) {
          await msg.edit({
            text: `❌ <b>端口冲突检测失败</b><br><br>端口 <code>${port}</code> 已被占用<br>进程信息: <code>${htmlEscape(portCheck.processInfo || '未知')}</code><br><br>💡 <b>建议:</b><br>• 选择其他端口号<br>• 停止占用该端口的服务<br>• 使用 <code>netstat -tlnp | grep :${port}</code> 查看详情`,
            parseMode: "html"
          });
          return;
        }
      }
      
      await msg.edit({ text: `🔄 端口 ${port} 可用，正在修改SSH配置...`, parseMode: "html" });
      
      // 使用通用函数修改SSH配置
      const timestamp = await modifySSHConfig("Port", String(port));
      
      await msg.edit({ text: `🔄 SSH配置已更新，正在开放防火墙端口 ${port}...`, parseMode: "html" });
      
      // 自动开放新端口的防火墙
      try {
        await execAsync(`iptables -I INPUT -p tcp --dport ${port} -j ACCEPT`);
        await execAsync(`iptables -I INPUT -p udp --dport ${port} -j ACCEPT`);
        
        // 尝试保存iptables规则
        try {
          await execAsync(`iptables-save > /etc/iptables/rules.v4`);
        } catch {
          try {
            await execAsync(`service iptables save`);
          } catch {
            console.log("[ssh] 无法持久化iptables规则");
          }
        }
      } catch (firewallError: any) {
        console.warn("[ssh] 防火墙端口开放失败:", firewallError.message);
      }
      
      await msg.edit({ text: `🔄 防火墙已配置，正在重启SSH服务...`, parseMode: "html" });
      
      // 重启SSH服务使配置生效
      const restartResult = await restartSSHService();
      if (!restartResult.success) {
        throw new Error("无法重启SSH服务");
      }
      
      // 保存配置到插件数据库
      await ConfigManager.set(CONFIG_KEYS.SSH_PORT, String(port));

      // 提供关闭旧端口的提示
      let oldPortWarning = "";
      if (currentPort !== "22" && currentPort !== String(port)) {
        oldPortWarning = `<br><br>💡 <b>提示:</b> 旧端口 ${htmlEscape(currentPort)} 的防火墙规则仍然开放<br>如需关闭请执行: <code>${mainPrefix}ssh close ${htmlEscape(currentPort)}</code>`;
      }

      await msg.edit({
        text: `✅ <b>SSH端口修改成功</b><br><br>🔧 新端口: <code>${port}</code><br>🛡️ 防火墙: 已自动开放 TCP/UDP ${port}<br>📄 备份文件: /etc/ssh/sshd_config.backup.${htmlEscape(timestamp)}${oldPortWarning}<br><br>⚠️ <b>重要:</b> 请用新端口测试连接后再断开当前会话`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`修改SSH端口失败: ${error.message}`);
    }
  }

  // 开关密码登录
  private async togglePasswordAuth(msg: Api.Message, mode: string): Promise<void> {
    const enable = mode === "on" || mode === "enable" || mode === "yes";
    const disable = mode === "off" || mode === "disable" || mode === "no";
    
    if (!enable && !disable) {
      await msg.edit({
        text: `❌ <b>无效的参数</b><br><br>使用: <code>${mainPrefix}ssh pwauth on/off</code>`,
        parseMode: "html"
      });
      return;
    }

    const action = enable ? "开启" : "关闭";
    await msg.edit({ text: `🔄 正在${action}密码登录...`, parseMode: "html" });

    try {
      const authValue = enable ? "yes" : "no";
      
      // 使用通用函数修改SSH配置
      const timestamp = await modifySSHConfig("PasswordAuthentication", authValue);
      
      // 同时设置相关安全选项
      await modifySSHConfig("ChallengeResponseAuthentication", "no", false);
      await modifySSHConfig("UsePAM", enable ? "yes" : "no", false);
      
      // 重启SSH服务使配置生效
      const restartResult = await restartSSHService();
      if (!restartResult.success) {
        throw new Error("无法重启SSH服务");
      }
      
      // 保存配置到插件数据库
      await ConfigManager.set(CONFIG_KEYS.PASSWORD_AUTH, authValue);

      await msg.edit({
        text: `✅ <b>密码登录已${action}</b><br><br>当前状态: ${enable ? "✅ 已开启" : "❌ 已关闭"}<br>备份文件: /etc/ssh/sshd_config.backup.${timestamp}`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`${action}密码登录失败: ${error.message}`);
    }
  }

  // 开关密钥登录
  private async toggleKeyAuth(msg: Api.Message, mode: string): Promise<void> {
    const enable = mode === "on" || mode === "enable" || mode === "yes";
    const disable = mode === "off" || mode === "disable" || mode === "no";
    
    if (!enable && !disable) {
      await msg.edit({
        text: `❌ <b>无效的参数</b><br><br>使用: <code>${mainPrefix}ssh keyauth on/off</code>`,
        parseMode: "html"
      });
      return;
    }

    const action = enable ? "开启" : "关闭";
    await msg.edit({ text: `🔄 正在${action}密钥登录...`, parseMode: "html" });

    try {
      const authValue = enable ? "yes" : "no";
      
      // 使用通用函数修改SSH配置
      const timestamp = await modifySSHConfig("PubkeyAuthentication", authValue);
      
      // 同时设置相关安全选项
      if (enable) {
        // 开启密钥登录时确保相关设置正确
        await modifySSHConfig("AuthorizedKeysFile", "/root/.ssh/authorized_keys", false);
      }
      
      // 重启SSH服务使配置生效
      const restartResult = await restartSSHService();
      if (!restartResult.success) {
        throw new Error("无法重启SSH服务");
      }
      
      // 保存配置到插件数据库
      await ConfigManager.set(CONFIG_KEYS.PUBKEY_AUTH, authValue);

      let warningText = "";
      if (!enable) {
        warningText = "<br><br>⚠️ <b>警告</b>: 关闭密钥登录可能会造成无法使用SSH密钥连接";
      }

      await msg.edit({
        text: `✅ <b>密钥登录已${action}</b><br><br>当前状态: ${enable ? "✅ 已开启" : "❌ 已关闭"}<br>备份文件: /etc/ssh/sshd_config.backup.${timestamp}${warningText}`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`${action}密钥登录失败: ${error.message}`);
    }
  }

  // 开关Root登录
  private async toggleRootLogin(msg: Api.Message, mode: string): Promise<void> {
    const enable = mode === "on" || mode === "enable" || mode === "yes";
    const disable = mode === "off" || mode === "disable" || mode === "no";
    const keyOnly = mode === "keyonly" || mode === "key-only" || mode === "keys";
    
    if (!enable && !disable && !keyOnly) {
      await msg.edit({
        text: `❌ <b>无效的参数</b><br><br>用法:<br>• <code>${mainPrefix}ssh rootlogin on</code> - 允许所有root登录方式<br>• <code>${mainPrefix}ssh rootlogin off</code> - 完全禁止root登录<br>• <code>${mainPrefix}ssh rootlogin keyonly</code> - 仅允许密钥登录root`,
        parseMode: "html"
      });
      return;
    }

    let action: string;
    let authValue: string;
    
    if (enable) {
      action = "开启所有Root登录方式";
      authValue = "yes";
    } else if (keyOnly) {
      action = "设置Root仅密钥登录";
      authValue = "prohibit-password";
    } else {
      action = "完全禁止Root登录";
      authValue = "no";
    }

    await msg.edit({ text: `🔄 正在${action}...`, parseMode: "html" });

    try {
      // 检查当前是否有其他登录方式
      if (disable) {
        // 完全禁用root登录前检查是否有其他用户
        try {
          const { stdout: users } = await execAsync(`getent passwd | awk -F: '$3 >= 1000 && $3 != 65534 { print $1 }' | head -5`);
          const userList = users.trim().split('\n').filter(u => u.trim());
          
          if (userList.length === 0) {
            await msg.edit({
              text: `❌ <b>检测到没有普通用户账户</b><br><br>完全禁用root登录可能导致系统无法访问。<br><br><b>建议:</b><br>• 使用 <code>${mainPrefix}ssh rootlogin keyonly</code> 仅允许密钥登录<br>• 或先手动创建普通用户账户再禁用root<br><br>如需继续强制禁用，请再次执行命令。`,
              parseMode: "html"
            });
            return;
          }
        } catch {
          // 检查失败时给出警告
          await msg.edit({
            text: `⚠️ <b>无法检测用户账户</b><br><br>建议使用 <code>${mainPrefix}ssh rootlogin keyonly</code> 而不是完全禁用<br><br>如需继续禁用root登录:<br><code>${mainPrefix}ssh rootlogin off</code>`,
            parseMode: "html"
          });
          return;
        }
      }
      
      // 使用通用函数修改SSH配置
      const timestamp = await modifySSHConfig("PermitRootLogin", authValue);
      
      // 重启SSH服务使配置生效
      const restartResult = await restartSSHService();
      if (!restartResult.success) {
        throw new Error("无法重启SSH服务");
      }
      
      let statusText: string;
      let securityTip: string;
      
      if (enable) {
        statusText = "✅ 允许所有登录方式";
        securityTip = "⚠️ <b>安全提示:</b> 已开启所有root登录方式，建议使用强密码";
      } else if (keyOnly) {
        statusText = "🔐 仅允许密钥登录";
        securityTip = "🛡️ <b>安全提示:</b> Root密码登录已禁用，仅允许SSH密钥登录";
      } else {
        statusText = "❌ 完全禁止登录";
        securityTip = "🛡️ <b>安全提示:</b> Root登录已完全禁用，请确保有其他用户账户可用";
      }
      
      await msg.edit({
        text: `✅ <b>Root登录配置已更新</b><br><br>状态: ${statusText}<br>配置值: <code>PermitRootLogin ${authValue}</code><br>备份文件: /etc/ssh/sshd_config.backup.${timestamp}<br><br>${securityTip}`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`配置Root登录失败: ${error.message}`);
    }
  }

  // 启用root账户直接登录
  private async enableRootAccount(msg: Api.Message, args: string[]): Promise<void> {
    const password = args.join(" ").trim();
    
    if (!password) {
      await msg.edit({
        text: `❌ <b>请提供root密码</b><br><br>示例: <code>${mainPrefix}ssh enableroot 新密码123</code><br><br>⚠️ <b>说明:</b> 此命令会启用root账户并设置密码，允许直接SSH登录root`,
        parseMode: "html"
      });
      return;
    }

    if (!validatePassword(password)) {
      await msg.edit({
        text: "❌ <b>密码不符合要求</b><br><br>• 密码长度至少8位<br>• 建议包含数字、字母、特殊字符",
        parseMode: "html"
      });
      return;
    }

    await msg.edit({ text: "🔄 正在启用root账户直接登录...", parseMode: "html" });

    try {
      // 1. 解锁root账户
      await execAsync(`sudo passwd -u root`);
      
      // 2. 设置root密码
      const escapedPassword = shellEscape(password);
      await execAsync(`echo 'root:${escapedPassword}' | sudo chpasswd`);
      
      // 3. 确保SSH允许root登录
      const currentConfig = await modifySSHConfig("PermitRootLogin", "yes");
      
      // 4. 确保密码登录开启
      await modifySSHConfig("PasswordAuthentication", "yes", false);
      
      // 5. 重启SSH服务
      const restartResult = await restartSSHService();
      if (!restartResult.success) {
        throw new Error("无法重启SSH服务");
      }
      
      await msg.edit({
        text: `✅ <b>Root账户已启用</b><br><br>🔑 Root密码: <code>${htmlEscape(password)}</code><br>🔓 账户状态: 已解锁<br>🚪 SSH登录: 已允许<br>📄 备份文件: /etc/ssh/sshd_config.backup.${currentConfig}<br><br>✨ <b>现在可以直接用root登录SSH了！</b><br><br>⚠️ <b>安全提示:</b><br>• 建议设置复杂密码<br>• 考虑配置SSH密钥登录<br>• 可用 <code>${mainPrefix}ssh rootlogin keyonly</code> 提升安全性`,
        parseMode: "html"
      });
      
    } catch (error: any) {
      throw new Error(`启用root账户失败: ${error.message}`);
    }
  }



  // 重启SSH服务
  private async restartSSH(msg: Api.Message): Promise<void> {
    await msg.edit({ text: "🔄 正在重启SSH服务...", parseMode: "html" });

    try {
      // 使用通用函数重启SSH服务
      const restartResult = await restartSSHService();
      
      if (!restartResult.success) {
        throw new Error("无法重启SSH服务，请检查系统类型");
      }

      // 验证SSH服务状态
      let sshStatus = "未知";
      try {
        await execAsync("systemctl is-active --quiet sshd || systemctl is-active --quiet ssh");
        sshStatus = "✅ 运行中";
      } catch {
        try {
          await execAsync("pgrep sshd");
          sshStatus = "✅ 运行中";
        } catch {
          sshStatus = "❌ 未运行";
        }
      }

      await msg.edit({
        text: `✅ <b>SSH服务重启成功</b><br><br>重启命令: <code>${htmlEscape(restartResult.command || "未知")}</code><br>服务状态: ${sshStatus}<br><br>💡 建议重启后验证SSH连接`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`重启SSH服务失败: ${error.message}`);
    }
  }

  // 开放防火墙端口
  private async openPort(msg: Api.Message, portStr: string): Promise<void> {
    const port = validatePort(portStr);
    
    if (!port) {
      await msg.edit({
        text: `❌ <b>无效的端口号</b><br><br>端口范围: 1-65535<br>示例: <code>${mainPrefix}ssh open 80</code>`,
        parseMode: "html"
      });
      return;
    }

    await msg.edit({ text: `🔄 正在开放端口 ${port}...`, parseMode: "html" });

    try {
      // 使用iptables开放端口
      await execAsync(`iptables -I INPUT -p tcp --dport ${port} -j ACCEPT`);
      await execAsync(`iptables -I INPUT -p udp --dport ${port} -j ACCEPT`);
      
      // 尝试保存iptables规则
      try {
        await execAsync(`iptables-save > /etc/iptables/rules.v4`);
      } catch {
        // 某些系统可能没有这个目录
        try {
          await execAsync(`service iptables save`);
        } catch {
          console.log("[sshkey] 无法持久化iptables规则");
        }
      }

      await msg.edit({
        text: `✅ <b>端口 ${port} 已开放</b><br><br>协议: TCP/UDP<br><br>💡 提示: 规则已添加到iptables，重启后可能需要重新设置`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`开放端口失败: ${error.message}`);
    }
  }

  // 关闭防火墙端口
  private async closePort(msg: Api.Message, portStr: string): Promise<void> {
    const port = validatePort(portStr);
    
    if (!port) {
      await msg.edit({
        text: `❌ <b>无效的端口号</b><br><br>端口范围: 1-65535<br>示例: <code>${mainPrefix}ssh close 80</code>`,
        parseMode: "html"
      });
      return;
    }

    await msg.edit({ text: `🔄 正在关闭端口 ${port}...`, parseMode: "html" });

    try {
      // 使用iptables关闭端口
      await execAsync(`iptables -D INPUT -p tcp --dport ${port} -j ACCEPT 2>/dev/null || true`);
      await execAsync(`iptables -D INPUT -p udp --dport ${port} -j ACCEPT 2>/dev/null || true`);
      
      // 添加拒绝规则
      await execAsync(`iptables -A INPUT -p tcp --dport ${port} -j DROP`);
      await execAsync(`iptables -A INPUT -p udp --dport ${port} -j DROP`);
      
      // 尝试保存iptables规则
      try {
        await execAsync(`iptables-save > /etc/iptables/rules.v4`);
      } catch {
        try {
          await execAsync(`service iptables save`);
        } catch {
          console.log("[sshkey] 无法持久化iptables规则");
        }
      }

      await msg.edit({
        text: `✅ <b>端口 ${port} 已关闭</b><br><br>协议: TCP/UDP<br><br>💡 提示: 规则已添加到iptables，重启后可能需要重新设置`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`关闭端口失败: ${error.message}`);
    }
  }

  // 设置接收目标
  private async setTarget(msg: Api.Message, target: string): Promise<void> {
    if (!target) {
      await msg.edit({
        text: `❌ <b>请提供目标</b><br><br>示例:<br><code>${mainPrefix}ssh set me</code> - 重置为默认发送到收藏夹<br><code>${mainPrefix}ssh set @username</code> - 设置发送到指定用户<br><code>${mainPrefix}ssh set -1001234567890</code> - 设置发送到指定群组/频道`,
        parseMode: "html"
      });
      return;
    }

      await msg.edit({ text: `🔄 正在设置接收目标为: ${htmlEscape(target)}...`, parseMode: "html" });

    try {
      // 验证目标是否有效
      if (target !== "me") {
        const client = await getGlobalClient();
        if (client) {
          try {
            await client.getEntity(target);
          } catch {
            await msg.edit({
              text: `⚠️ <b>无法验证目标有效性</b><br><br>目标 <code>${htmlEscape(target)}</code> 可能无效，但配置已保存。<br><br>发送时如果失败将自动使用收藏夹。`,
              parseMode: "html"
            });
            await ConfigManager.set(CONFIG_KEYS.TARGET_CHAT, target);
            return;
          }
        }
      }

      // 保存配置
      await ConfigManager.set(CONFIG_KEYS.TARGET_CHAT, target);

      await msg.edit({
        text: `✅ <b>接收目标已设置</b><br><br>目标: <code>${htmlEscape(target)}</code><br><br>${target === "me" ? "密钥将发送到收藏夹" : "密钥将发送到指定会话"}`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`设置目标失败: ${error.message}`);
    }
  }

  // 显示配置信息
  private async showInfo(msg: Api.Message): Promise<void> {
    await msg.edit({ text: "🔄 正在获取SSH状态信息...", parseMode: "html" });

    try {
      // 获取插件配置
      const targetChat = await ConfigManager.get(CONFIG_KEYS.TARGET_CHAT);
      const sshPort = await ConfigManager.get(CONFIG_KEYS.SSH_PORT);
      const passwordAuth = await ConfigManager.get(CONFIG_KEYS.PASSWORD_AUTH);
      const pubkeyAuth = await ConfigManager.get(CONFIG_KEYS.PUBKEY_AUTH);

      // 获取当前SSH服务状态
      let sshStatus = "未知";
      try {
        await execAsync("systemctl is-active --quiet sshd || systemctl is-active --quiet ssh");
        sshStatus = "✅ 运行中";
      } catch {
        try {
          await execAsync("pgrep sshd");
          sshStatus = "✅ 运行中";
        } catch {
          sshStatus = "❌ 未运行";
        }
      }

      // 从sshd_config读取实际配置
      let actualPasswordAuth = "未知";
      let rootLogin = "未知";
      let actualPubkeyAuth = "未知";
      let actualPort = "未知";
      
      try {
        const configContent = (await execAsync("cat /etc/ssh/sshd_config")).stdout;
        
        // 检查密码认证
        const passwordAuthMatch = configContent.match(/^\s*PasswordAuthentication\s+(yes|no)/mi);
        actualPasswordAuth = passwordAuthMatch ? 
          (passwordAuthMatch[1].toLowerCase() === "yes" ? "✅ 已开启" : "❌ 已关闭") : "🟡 默认(通常开启)";
        
        // 检查Root登录
        const rootLoginMatch = configContent.match(/^\s*PermitRootLogin\s+(yes|no|prohibit-password|forced-commands-only)/mi);
        if (rootLoginMatch) {
          const value = rootLoginMatch[1].toLowerCase();
          switch (value) {
            case "yes":
              rootLogin = "✅ 允许(全权限)";
              break;
            case "no":
              rootLogin = "❌ 禁止";
              break;
            case "prohibit-password":
              rootLogin = "🔑 仅密钥";
              break;
            case "forced-commands-only":
              rootLogin = "⚠️ 仅命令";
              break;
          }
        } else {
          rootLogin = "🟡 默认(通常允许)";
        }
        
        // 检查密钥认证
        const pubkeyAuthMatch = configContent.match(/^\s*PubkeyAuthentication\s+(yes|no)/mi);
        actualPubkeyAuth = pubkeyAuthMatch ? 
          (pubkeyAuthMatch[1].toLowerCase() === "yes" ? "✅ 已开启" : "❌ 已关闭") : "🟡 默认(通常开启)";
        
        // 检查端口
        const portMatch = configContent.match(/^\s*Port\s+(\d+)/mi);
        actualPort = portMatch ? portMatch[1] : "22(默认)";
        
      } catch (error) {
        console.log("[ssh] 无法读取sshd_config:", error);
      }

      // 检查authorized_keys文件
      let keyCount = 0;
      try {
        const keysContent = (await execAsync("wc -l /root/.ssh/authorized_keys 2>/dev/null || echo '0'")).stdout;
        keyCount = parseInt(keysContent.trim()) || 0;
      } catch {
        keyCount = 0;
      }

      // 获取防火墙规则数量
      let iptablesInfo = "";
      try {
        const result = await execAsync("iptables -L INPUT -n | wc -l");
        const ruleCount = parseInt(result.stdout.trim()) - 2; // 减去标题行
        iptablesInfo = `<br>防火墙规则: ${ruleCount > 0 ? ruleCount + " 条" : "无限制"}`;
      } catch {
        iptablesInfo = "";
      }


      // 获取系统信息
      let systemInfo = "";
      try {
        const hostname = (await execAsync("hostname")).stdout.trim();
        const uptime = (await execAsync("uptime -p 2>/dev/null || echo '未知'")).stdout.trim();
        systemInfo = `<br><br><b>系统信息：</b><br>主机名: <code>${htmlEscape(hostname)}</code><br>运行时间: ${htmlEscape(uptime)}`;
      } catch {
        systemInfo = "";
      }

      await msg.edit({
        text: `📊 <b>SSH状态信息</b><br><br><b>SSH服务状态：</b><br>服务状态: ${sshStatus}<br>端口: <code>${htmlEscape(actualPort)}</code><br><br><b>认证配置：</b><br>密码登录: ${actualPasswordAuth}<br>Root登录: ${rootLogin}<br>密钥登录: ${actualPubkeyAuth}<br>已授权密钥: ${keyCount} 个${iptablesInfo}<br><br><b>插件配置：</b><br>接收目标: <code>${htmlEscape(targetChat)}</code><br>${targetChat === "me" ? "(发送到收藏夹)" : "(发送到指定会话)"}<br><br><b>相关文件：</b><br>• SSH配置: /etc/ssh/sshd_config<br>• 授权密钥: /root/.ssh/authorized_keys${systemInfo}`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`获取SSH状态信息失败: ${error.message}`);
    }
  }

  // 创建压缩包
  private async createArchive(sourceDir: string, outputPath: string, files: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', {
        zlib: { level: 9 } // 最高压缩级别
      });

      output.on('close', () => {
        console.log(`[ssh] 压缩包创建成功: ${archive.pointer()} bytes`);
        resolve();
      });

      output.on('error', (err) => {
        archive.destroy();
        reject(err);
      });

      archive.on('error', (err) => {
        output.destroy();
        reject(err);
      });

      archive.pipe(output);

      // 添加文件到压缩包
      for (const file of files) {
        const filePath = path.join(sourceDir, file);
        if (fs.existsSync(filePath)) {
          archive.file(filePath, { name: file });
        }
      }

      archive.finalize();
    });
  }

}

export default new SSHPlugin();
