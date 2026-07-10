import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "teleproto";
import { getGlobalClient } from "@utils/globalClient";
import axios from "axios";
import * as yaml from "js-yaml";
import * as cheerio from "cheerio";
import dayjs from "dayjs";
import { safeGetReplyMessage } from "@utils/safeGetMessages";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];


// --- 静态配置 ---

// 远程机场配置映射文件 URL
const REMOTE_MAPPINGS_URL = "https://raw.githubusercontent.com/Hyy800/Quantumult-X/refs/heads/Nana/ymys.txt";
let REMOTE_CONFIG_MAPPINGS: Record<string, string> = {};
let REMOTE_MAPPINGS_LOADED_AT = 0;
const REMOTE_MAPPINGS_TTL_MS = 5 * 60 * 1000; // 5 minutes

// 地区规则列表 (用于节点归类识别)
const REGION_RULES: Array<[string, string[]]> = [
  // 亚洲
  ['香港', ['香港', 'hong kong', 'hongkong', 'hk', 'hkg']],
  ['台湾', ['台湾', 'taiwan', 'tw', 'taipei', 'tpe']],
  ['日本', ['日本', 'japan', 'jp', 'tokyo', 'osaka', 'jap']],
  ['新加坡', ['新加坡', 'singapore', 'sg', 'sgp']],
  ['韩国', ['韩国', 'korea', 'kr', 'seoul', 'kor']],
  ['印度', ['印度', 'india', 'in', 'mumbai', 'delhi', 'ind']],
  ['马来西亚', ['马来西亚', 'malaysia', 'my', 'kuala lumpur', 'mys']],
  ['泰国', ['泰国', 'thailand', 'th', 'bangkok', 'tha']],
  ['越南', ['越南', 'vietnam', 'vn', 'hanoi', 'vnm']],
  ['印尼', ['印尼', '印度尼西亚', 'indonesia', 'id', 'jakarta', 'idn']],
  ['菲律宾', ['菲律宾', 'philippines', 'ph', 'manila', 'phl']],
  ['土耳其', ['土耳其', 'turkey', 'tr', 'istanbul', 'ankara', 'tur']],
  // 北美
  ['美国', ['美国', 'united states', 'us', 'usa', 'los angeles', 'san jose', 'silicon valley']],
  ['加拿大', ['加拿大', 'canada', 'ca', 'toronto', 'vancouver']],
  // 欧洲
  ['英国', ['英国', 'united kingdom', 'uk', 'london', 'manchester', 'gbr']],
  ['德国', ['德国', 'germany', 'de', 'frankfurt', 'berlin', 'deu']],
  ['法国', ['法国', 'france', 'fr', 'paris', 'fra']],
  ['荷兰', ['荷兰', 'netherlands', 'nl', 'amsterdam', 'nld']],
  ['瑞士', ['瑞士', 'switzerland', 'ch', 'zurich', 'che']],
  ['意大利', ['意大利', 'italy', 'it', 'milan', 'rome', 'ita']],
  ['西班牙', ['西班牙', 'spain', 'es', 'madrid', 'barcelona', 'esp']],
  ['瑞典', ['瑞典', 'sweden', 'se', 'stockholm', 'swe']],
  ['挪威', ['挪威', 'norway', 'no', 'oslo', 'nor']],
  ['芬兰', ['芬兰', 'finland', 'fi', 'helsinki', 'fin']],
  ['丹麦', ['丹麦', 'denmark', 'dk', 'copenhagen', 'dnk']],
  ['波兰', ['波兰', 'poland', 'pl', 'warsaw', 'pol']],
  ['奥地利', ['奥地利', 'austria', 'at', 'vienna', 'aut']],
  ['比利时', ['比利时', 'belgium', 'be', 'brussels', 'bel']],
  ['爱尔兰', ['爱尔兰', 'ireland', 'ie', 'dublin', 'irl']],
  ['葡萄牙', ['葡萄牙', 'portugal', 'pt', 'lisbon', 'prt']],
  ['希腊', ['希腊', 'greece', 'gr', 'athens', 'grc']],
  ['卢森堡', ['卢森堡', 'luxembourg', 'lu', 'lux']],
  ['乌克兰', ['乌克兰', 'ukraine', 'ua', 'kiev', 'ukr']],
  // 大洋洲
  ['澳大利亚', ['澳大利亚', 'australia', 'au', 'sydney', 'melbourne', 'aus']],
  ['新西兰', ['新西兰', 'new zealand', 'nz', 'auckland', 'nzl']],
  // 南美/中东/非洲/俄罗斯
  ['巴西', ['巴西', 'brazil', 'br', 'sao paulo', 'rio', 'bra']],
  ['阿联酋', ['阿联酋', 'uae', 'united arab emirates', 'ae', 'dubai', 'abu dhabi', 'are']],
  ['以色列', ['以色列', 'israel', 'il', 'tel aviv', 'jerusalem', 'isr']],
  ['南非', ['南非', 'south africa', 'za', 'johannesburg', 'cape town', 'zaf']],
  ['俄罗斯', ['俄罗斯', 'russia', 'ru', 'moscow', 'st.petersburg', 'rus']],
];

// --- 工具函数 ---

// HTML实体转义
function htmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#x27;'
  }[m] || m));
}

const isHttpUrl = (text: string): boolean => /^https?:\/\//i.test(text);
const formatRawUrl = (url: string, isTxtOutput: boolean): string => isTxtOutput ? url : htmlEscape(url);

// Markdown特殊字符转义 (用于TXT输出)
function markdownEscape(text: string): string {
  return text.replace(/([*`>#+\-.!_[\](){}])/g, '\\$1');
}

// 流量字节单位转换
function formatSize(size: number): string {
  const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  if (size < 0) size = 0;
  let level = 0;
  let displaySize = size;
  while (displaySize >= 1024 && level < UNITS.length - 1) {
    displaySize /= 1024;
    level++;
  }
  return `${displaySize.toFixed(2)} ${UNITS[level]}`;
}

// 格式化剩余秒数
function formatTimeRemaining(seconds: number): string {
  seconds = Math.max(0, Math.floor(seconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${days.toString().padStart(2, '0')}天${hours.toString().padStart(2, '0')}小时${minutes.toString().padStart(2, '0')}分${secs.toString().padStart(2, '0')}秒`;
}

// 计算日均使用量
function calculateDailyUsage(totalUsed: number, startTime: number, currentTime: number): string {
  const days = Math.max(1, (currentTime - startTime) / 86400);
  return formatSize(totalUsed / days);
}

// 计算剩余流量的建议日均用量
function calculateRemainingDailyAllowance(remain: number, days: number): string {
  if (days <= 0) return "无法计算";
  return formatSize(remain / days);
}

// 获取流量进度提示 (仅用于详细模式)
function getSpeedEmoji(percent: number): string {
  if (percent < 30) return "🟢 良好";
  if (percent < 70) return "🟡 正常";
  if (percent < 90) return "🟠 偏高";
  return "🔴 警告";
}

// 预计耗尽日期
function estimateDepletionDate(remain: number, dailyUsage: number): string {
  if (dailyUsage <= 0) return "无法估计";
  const days = Math.floor(remain / dailyUsage);
  return dayjs().add(days, 'day').format("YYYY-MM-DD");
}

// 尝试解析节点信息 (节点数, 类型, 地区分布)
async function getNodeInfo(url: string): Promise<{ node_count: number | string, type_count: Record<string, number>, regions: Record<string, number> } | null> {
  try {
    const res = await axios.get(url, { timeout: 10000, responseType: 'text' });
    
    // 1. 尝试解析 YAML (Clash/Surge)
    try {
      const config = yaml.load(res.data);
      if (config && (config as any).proxies) {
        const proxies = (config as any).proxies;
        const typeCount: Record<string, number> = {};
        const regions: Record<string, number> = {};
        let totalNodes = proxies.length;
        let identified = 0;
        for (const proxy of proxies) {
          const type = proxy.type?.toLowerCase();
          typeCount[type] = (typeCount[type] || 0) + 1;
          const nameLow = proxy.name?.toLowerCase() || '';
          for (const [region, keys] of REGION_RULES) {
            if (keys.some(k => nameLow.includes(k.toLowerCase()))) {
              regions[region] = (regions[region] || 0) + 1;
              identified++;
              break;
            }
          }
        }
        if (totalNodes - identified > 0) regions['其他'] = totalNodes - identified;
        return {
          node_count: totalNodes,
          type_count: Object.fromEntries(Object.entries(typeCount).filter(([, v]) => v > 0)),
          regions: Object.fromEntries(Object.entries(regions).filter(([, v]) => v > 0))
        };
      }
    } catch { /* 忽略 YAML 解析错误 */ }
    
    // 2. 尝试解析 Base64 (V2Ray/Shadowsocks 原始链接)
    try {
      const decoded = Buffer.from(res.data, 'base64').toString();
      const typeCount: Record<string, number> = {};
      const regions: Record<string, number> = {};
      let nodeCount = 0;
      let identified = 0;
      const protocols = ['vmess://', 'trojan://', 'ss://', 'ssr://', 'vless://', 'hy2://', 'hysteria://', 'hy://', 'tuic://', 'wireguard://', 'socks5://', 'http://', 'https://', 'shadowtls://', 'naive://'];
      
      decoded.split('\n').forEach((line: string) => {
        if (!line.trim()) return;
        for (const pattern of protocols) {
          if (line.startsWith(pattern)) {
            let t = pattern.replace('://', '');
            typeCount[t] = (typeCount[t] || 0) + 1;
            nodeCount++;
            let lLow = line.toLowerCase();
            for (const [region, keys] of REGION_RULES) {
              if (keys.some(k => lLow.includes(k.toLowerCase()))) {
                regions[region] = (regions[region] || 0) + 1;
                identified++;
                break;
              }
            }
            break;
          }
        }
      });
      if (nodeCount - identified > 0) regions['其他'] = nodeCount - identified;
      return {
        node_count: nodeCount,
        type_count: Object.fromEntries(Object.entries(typeCount).filter(([, v]) => v > 0)),
        regions: Object.fromEntries(Object.entries(regions).filter(([, v]) => v > 0)),
      };
    } catch { /* 忽略 Base64 解析错误 */ }
    return null;
  } catch { return null; }
}

// 判断订阅周期类型 (单次/月付/长期)
function getSubType(expireTs: number): { isLongTerm: boolean; isSingle: boolean; resetInfo: string; daysToReset: number } {
  const now = Math.floor(Date.now() / 1000);
  if (expireTs === 0) return { isLongTerm: false, isSingle: true, resetInfo: "未知或永久", daysToReset: 0 };
  
  const expireTime = new Date(expireTs * 1000);
  const daysToExpire = Math.max(0, Math.floor((expireTs - now) / 86400));
  const isLongTerm = (expireTs - now) > 3 * 365 * 86400; // 超过三年视为长期

  if (daysToExpire < 45 && !isLongTerm) {
    return { isSingle: true, isLongTerm: false, resetInfo: "单次订阅，无重置", daysToReset: daysToExpire };
  }

  // 计算下次重置日 (基于过期日期的日份)
  const resetDay = expireTime.getDate();
  const current = new Date();
  
  let nextReset = new Date(current.getFullYear(), current.getMonth(), resetDay, 0, 0, 0);
  
  if (nextReset.getTime() < Date.now()) {
      nextReset = new Date(current.getFullYear(), current.getMonth() + 1, resetDay, 0, 0, 0);
  }

  const daysToReset = Math.max(1, Math.floor((nextReset.getTime() / 1000 - now) / 86400));
  
  return { isSingle: false, isLongTerm, resetInfo: `每月${resetDay}日`, daysToReset };
}

// 分割Telegram长消息
function splitLongMessage(text: string, maxLength = 4000): string[] {
  if (text.length <= maxLength) return [text];
  const ret: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > maxLength) {
      if (current) ret.push(current);
      current = line;
    } else {
      current += (current ? '<br>' : '') + line;
    }
  }
  if (current) ret.push(current);
  return ret;
}

// 尝试获取机场官网和网站标题
async function getWebsiteInfo(url: string): Promise<{ website: string | null; websiteName: string | null }> {
  try {
    const urlMatch = url.match(/(https?:\/\/)([^/]+)/);
    if (!urlMatch) return { website: null, websiteName: null };
    const baseUrl = urlMatch[1] + urlMatch[2];
    
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' };

    let response;
    try {
      response = await axios.get(baseUrl + '/auth/login', { headers, timeout: 5000, maxRedirects: 5 });
    } catch {
      try {
        response = await axios.get(baseUrl, { headers, timeout: 5000, maxRedirects: 5 });
      } catch {
        return { website: baseUrl, websiteName: "连接失败" };
      }
    }

    if (response.status === 200) {
      const $ = cheerio.load(response.data);
      let title = $('title').text().trim();
      title = title.replace('登录 — ', '').replace(' | 登录', '');
      
      if (title.includes("Cloudflare") || title.includes("Just a moment")) {
        return { website: baseUrl, websiteName: 'Cloudflare防御' };
      } else if (title.includes("Access denied") || title.includes("404 Not Found")) {
        return { website: baseUrl, websiteName: '非机场面板域名' };
      }
      
      return { website: baseUrl, websiteName: title || null };
    }

  } catch (e) {
    // 忽略错误
  }
  return { website: null, websiteName: null };
}

class SubinfoPlugin extends Plugin {

  description =
    `📈 <b>订阅链接多维度查询工具</b>

<b>使用方法：</b>
• <code>${mainPrefix}subinfo [链接]</code> - 详细查询
• <code>${mainPrefix}subinfo txt [链接]</code> - 详细查询，以TXT文件输出
• <code>${mainPrefix}cha [链接]</code> - 简洁查询
• <code>${mainPrefix}cha txt [链接]</code> - 简洁查询，以TXT文件输出
• <b>你也可以使用以上命令回复某条包含订阅链接的消息进行查询</b>

<b>功能特性：</b>
支持批量多链接、流量统计、到期预测、节点分布分析、机场名称及官网识别。`;

  cmdHandlers = {
    subinfo: this.handleSubinfo.bind(this),
    cha: this.handleCha.bind(this),
  };
  
  // 加载远程配置映射（带 5 分钟缓存，避免重复请求）
  private async loadRemoteMappings(): Promise<number> {
    const now = Date.now();
    if (REMOTE_CONFIG_MAPPINGS && Object.keys(REMOTE_CONFIG_MAPPINGS).length > 0
        && now - REMOTE_MAPPINGS_LOADED_AT < REMOTE_MAPPINGS_TTL_MS) {
      return Object.keys(REMOTE_CONFIG_MAPPINGS).length;
    }
    try {
      const response = await axios.get(REMOTE_MAPPINGS_URL, { timeout: 10000 });
      const content = response.data as string;
      const mappings: Record<string, string> = {};
      content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const equalsIndex = trimmed.indexOf('=');
          if (equalsIndex > 0) {
            mappings[trimmed.substring(0, equalsIndex).trim()] = trimmed.substring(equalsIndex + 1).trim();
          }
        }
      });
      REMOTE_CONFIG_MAPPINGS = mappings;
      REMOTE_MAPPINGS_LOADED_AT = Date.now();
      return Object.keys(REMOTE_CONFIG_MAPPINGS).length;
    } catch (error) {
      // 加载失败时返回缓存（即使过期）或 0
      return Object.keys(REMOTE_CONFIG_MAPPINGS).length;
    }
  }

  // 从映射中获取配置名称
  private getConfigNameFromMappings(url: string): string | null {
    for (const [key, name] of Object.entries(REMOTE_CONFIG_MAPPINGS)) {
      if (url.includes(key)) return name;
    }
    return null;
  }

  // 从 Content-Disposition 头获取配置名称
  private getConfigNameFromHeader(contentDisposition: string | null): string | null {
    if (!contentDisposition) return null;

    try {
      const parts = contentDisposition.split(';');
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith('filename*=')) {
          const namePart = trimmed.split("''").pop();
          if (namePart) return decodeURIComponent(namePart);
        } else if (trimmed.startsWith('filename=')) {
          let namePart = trimmed.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
          if (namePart) return decodeURIComponent(Buffer.from(namePart, 'binary').toString('utf-8'));
        }
      }
    } catch {
      // 忽略解析错误
    }
    return null;
  }

  // --- 核心查询逻辑 (Subinfo & Cha 共用) ---
  private async processSubscription(url: string): Promise<{ 
    success: boolean; 
    configName: string; 
    status: string; 
    statusEmoji: string; 
    profileUrl: string | null; 
    used: number; 
    upload: number; 
    download: number; 
    total: number; 
    remain: number; 
    percent: number; 
    expireTs: number; 
    startTs: number; 
    websiteInfo: { website: string | null; websiteName: string | null };
    nodeInfo: { node_count: string | number; type_count: Record<string, number>; regions: Record<string, number> } | null;
    errorMessage: string | null;
  }> {
    const websiteInfo = await getWebsiteInfo(url);
    const result = {
        success: false,
        configName: '未知',
        status: '失败',
        statusEmoji: '❓',
        profileUrl: null as string | null,
        used: 0, upload: 0, download: 0, total: 0, remain: 0, percent: 0,
        expireTs: 0, startTs: 0,
        websiteInfo,
        nodeInfo: null as { node_count: string | number; type_count: Record<string, number>; regions: Record<string, number> } | null,
        errorMessage: null as string | null,
    };

    try {
        let configName: string | null = this.getConfigNameFromMappings(url);
        
        const response = await axios.get(url, { 
            headers: { 'User-Agent': 'FlClash/v0.8.76 clash-verge Platform/android' }, 
            timeout: 15000, 
            maxRedirects: 5, 
            validateStatus: () => true 
        });

        if (response.status !== 200) {
            result.errorMessage = `无法访问(${response.status})`;
            return result;
        }
        
        // 尝试从 Content-Disposition 头获取配置名
        if (!configName) configName = this.getConfigNameFromHeader(response.headers['content-disposition']);
        
        // 使用网站标题作为名称补充
        if (!configName && websiteInfo.websiteName && websiteInfo.websiteName !== "连接失败") configName = websiteInfo.websiteName;
        
        result.configName = configName || '未知';

        const userInfoHeader = response.headers['subscription-userinfo'];
        result.profileUrl = (response.headers['profile-web-page-url'] as string | null) || null;

        if (!userInfoHeader) {
            result.errorMessage = "无流量统计信息";
            return result;
        }
        
        // 解析用户信息
        const userInfoParts: Record<string, string> = {};
        userInfoHeader.split(';').forEach((part: string) => {
            const equalsIndex = part.indexOf('=');
            if (equalsIndex > 0) userInfoParts[part.substring(0, equalsIndex).trim().toLowerCase()] = part.substring(equalsIndex + 1).trim();
        });
        
        const upload = parseInt(userInfoParts.upload || '0');
        const download = parseInt(userInfoParts.download || '0');
        const total = parseInt(userInfoParts.total || '0');
        const expireTs = parseInt(userInfoParts.expire || '0');
        const startTs = parseInt(userInfoParts.starttime || '0');
        
        const used = upload + download;
        const remain = total > used ? total - used : 0;
        const percent = total > 0 ? Math.round((used / total) * 10000) / 100 : 0;
        
        // 状态判断
        let status = "有效";
        let statusEmoji = "✅";
        if (total > 0 && remain <= 0) { status = "耗尽"; statusEmoji = "⚠️"; }
        if (expireTs && Date.now() > expireTs * 1000) { status = "过期"; statusEmoji = "❌"; }

        // 获取节点信息
        try { result.nodeInfo = await getNodeInfo(url); } catch { result.nodeInfo = null; }

        return {
            ...result, success: true, status, statusEmoji, upload, download, total, used, remain, percent, expireTs, startTs
        };

    } catch (err: any) {
        result.errorMessage = err.message || '未知错误';
        return result;
    }
  }

  // --- 详细模式处理器 (.subinfo) ---
  async handleSubinfo(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    await msg.edit({ text: "⏳ 正在准备解析订阅，请稍候..." });
    
    const myText = (msg.text ?? '').trim();
    const parts = myText.split(/\s+/).slice(1);
    
    const isTxtOutput = parts.length > 0 && parts[0].toLowerCase() === 'txt';
    const cleanParts = isTxtOutput ? parts.slice(1) : parts;

    let sourceText = '';
    if (msg.replyToMsgId) {
      try {
        const replyMsg = await safeGetReplyMessage(msg);
        if (replyMsg) sourceText = (replyMsg.text ?? '') + ' ' + ((replyMsg as any).caption ?? '');
      } catch { /* 忽略 */ }
    }
    if (cleanParts.length > 0) sourceText += ' ' + cleanParts.join(' ');
    sourceText = sourceText.trim();
    
    if (!sourceText) {
      await msg.edit({ text: this.description, parseMode: "html" });
      return;
    }
    
    const urlRegex = /https?:\/\/[^\s]+/g;
    const urls = Array.from(new Set((sourceText.match(urlRegex) ?? [])));
    if (!urls.length) {
      await msg.edit({ text: "❌ 未找到有效的订阅链接" });
      return;
    }
    
    const mappingsCount = await this.loadRemoteMappings();
    await msg.edit({ text: `📚 已加载 ${mappingsCount} 条配置映射，正在查询 ${urls.length} 个链接...` });

    let reports: string[] = [];
    let stats = { 有效: 0, 耗尽: 0, 过期: 0, 失败: 0 };
    
    // 格式化函数，根据输出类型选择
    const format: (text: string) => string = isTxtOutput ? markdownEscape : htmlEscape;
    const codeTag = (text: string) => isTxtOutput ? `\`${format(text)}\`` : `<code>${htmlEscape(text)}</code>`;
    const boldTag = (text: string) => isTxtOutput ? `**${format(text)}**` : `<b>${htmlEscape(text)}</b>`;
    const blockquoteTag = (text: string) => isTxtOutput ? `<br>> ${text.trim().replace(/<br>/g, '<br>> ')}<br>` : `<blockquote expandable>${text}</blockquote>`;
    const separator = isTxtOutput ? '<br>' + '='.repeat(40) + '<br>' : '<br><br>' + '='.repeat(30) + '<br><br>';

    for (const url of urls) {
      const result = await this.processSubscription(url);

      if (!result.success && result.errorMessage === "无流量统计信息") {
          let output = `订阅链接: ${codeTag(url)}\n机场名称: ${codeTag(result.configName)}\n**无流量统计信息**`;
          if (result.websiteInfo.website) output += `\n🔗 官网链接: ${formatRawUrl(result.websiteInfo.website, isTxtOutput)}`;
          reports.push(output); stats.失败++; continue;
      }
      
      if (!result.success) {
        let errorMsg = `${boldTag('查询失败:')} ${codeTag(result.errorMessage || '未知错误')}`;
        if (result.websiteInfo.website) errorMsg += `\n🔗 官网链接: ${formatRawUrl(result.websiteInfo.website, isTxtOutput)}`;
        let output = `订阅链接: ${codeTag(url)}\n${errorMsg}`;
        reports.push(output); stats.失败++; continue;
      }
        
      if (result.status === "耗尽") stats.耗尽++;
      else if (result.status === "过期") stats.过期++;
      else if (result.status === "有效") stats.有效++;
      
      const { 
        configName, status, statusEmoji, profileUrl, used, upload, download, total, remain, percent, expireTs, startTs, websiteInfo, nodeInfo
      } = result;

      const { isLongTerm, isSingle, resetInfo, daysToReset } = getSubType(expireTs ?? 0);

      // --- 输出生成 ---
      let seg: string[] = [];

      seg.push(`📄 ${boldTag('机场名称')}: ${codeTag(configName)}`);
      
      const finalProfileUrl = profileUrl || websiteInfo.website;
      if (finalProfileUrl && isHttpUrl(finalProfileUrl)) seg.push(`🔗 ${boldTag('官网链接')}: ${formatRawUrl(finalProfileUrl, isTxtOutput)}`);
      seg.push(`🏷️ ${boldTag('订阅链接')}: ${codeTag(url)}`);
      
      seg.push(`⏱️ ${boldTag('查询时间')}: ${codeTag(dayjs().format('YYYY-MM-DD HH:mm:ss'))}`);
      seg.push(`${statusEmoji} ${boldTag('状态')}: ${boldTag(status)}\n`);
      
      // 流量信息
      seg.push(`📊 ${boldTag('流量信息')}`);
      const blocksFilled = Math.min(20, Math.round(percent / 5));
      const blocksEmpty = Math.max(0, 20 - blocksFilled);
      
      let trafficInfo = `总计: ${formatSize(total)}\n` +
                        `已用: ${formatSize(used)} (↑${formatSize(upload)} ↓${formatSize(download)})\n` +
                        `剩余: ${formatSize(remain)}\n` +
                        `进度: ${'█'.repeat(blocksFilled)}${'░'.repeat(blocksEmpty)} ${percent}% ${getSpeedEmoji(percent)}`;
      seg.push(blockquoteTag(trafficInfo));
      
      // 时间信息
      if (expireTs) {
        seg.push(`⏰ ${boldTag('时间信息')}`);
        let timeInfo = '';
        const leftTime = expireTs * 1000 - Date.now();
        timeInfo += `到期: ${dayjs(expireTs * 1000).format('YYYY-MM-DD HH:mm:ss')}\n`;
        if (leftTime > 0) timeInfo += `剩余: ${formatTimeRemaining(Math.floor(leftTime / 1000))}\n`;
        else timeInfo += `状态: 已过期\n`;

        timeInfo += `周期: ${isLongTerm ? '长期有效' : (isSingle ? '单次订阅' : resetInfo)}\n`;
        
        if (daysToReset > 0 && !isLongTerm) timeInfo += `下次重置/到期: ${formatTimeRemaining(daysToReset * 86400)}\n`;
        if (daysToReset > 0 && remain > 0 && !isLongTerm) timeInfo += `建议日均用量: ${calculateRemainingDailyAllowance(remain, daysToReset)}/天\n`;
        
        if (startTs && Math.floor(Date.now() / 1000) > startTs)
          timeInfo += `历史日均: ${calculateDailyUsage(used, startTs, Math.floor(Date.now() / 1000))}/天\n`;
        
        if (used > 0 && remain > 0) {
          const dayUsageSeconds = Math.max(86400, Math.floor(Date.now() / 1000) - startTs);
          const dayUsageBytes = used / (dayUsageSeconds / 86400);
          timeInfo += `预计耗尽日期: ${estimateDepletionDate(remain, dayUsageBytes)}\n`;
          timeInfo += `上下行比例: ↑${Math.round((upload / used) * 10000) / 100}% ↓${Math.round((download / used) * 10000) / 100}%`;
        }
        seg.push(blockquoteTag(timeInfo.trim()));
      }
      
      // 节点统计
      seg.push(`🌐 ${boldTag('节点信息')}`);
      if (nodeInfo) {
        let nodeStats = `数量: ${nodeInfo.node_count}\n`;
        if (nodeInfo.type_count && Object.keys(nodeInfo.type_count).length)
          nodeStats += `类型: ${Object.entries(nodeInfo.type_count).map(([k, v]) => `${k}:${v}`).join(', ')}\n`;
        
        if (nodeInfo.regions && Object.keys(nodeInfo.regions).length) {
          nodeStats += `地区分布: ${Object.entries(nodeInfo.regions).map(([k, v]) => `${k}:${v}`).join(', ')}\n`;
          if (nodeInfo.node_count && typeof nodeInfo.node_count === 'number') {
            const topRegion = Object.entries(nodeInfo.regions).sort((a, b) => b[1] - a[1])[0];
            if (topRegion) nodeStats += `主要: ${topRegion[0]}(${Math.round(topRegion[1] / (nodeInfo.node_count as number) * 10000) / 100}%)`;
          }
        }
        seg.push(blockquoteTag(nodeStats.trim()));
      } else {
        seg.push(`(未能解析节点列表)`);
      }
      
      reports.push(seg.join('<br>'));
    }

    let resultText = reports.join(separator);
    const statsText = `\n📈 ${boldTag('统计:')} ✅有效:${stats.有效} | ⚠️耗尽:${stats.耗尽} | ❌过期:${stats.过期} | ❓失败:${stats.失败}`;

    if (urls.length > 1) resultText += statsText;

    if (isTxtOutput) {
        const dateStr = dayjs().format('YYYYMMDD_HHmmss');
        const fileName = `subinfo_report_${dateStr}.txt`;
        const fileContent = resultText;
        const fileBuffer = Buffer.from(fileContent, 'utf-8') as Buffer & { name?: string };
        fileBuffer.name = fileName;
        
        try {
            await client.sendFile(msg.chatId!, { file: fileBuffer, caption: `✅ 订阅查询报告 (共 ${urls.length} 个链接)\n${statsText.trim()}` });
            await msg.delete();
        } catch (e) {
              const preview = isTxtOutput
                ? splitLongMessage(resultText, 1024)[0]
                : htmlEscape(splitLongMessage(resultText, 1024)[0]);
              await msg.edit({ text: `❌ 发送TXT文件失败，请检查权限。<br><br>部分内容：<br>${preview}`, parseMode: 'html' });
        }
    } else {
        const messageParts = splitLongMessage(resultText, 4090);
        await msg.edit({ text: messageParts[0], parseMode: "html", linkPreview: false });
        for (let i = 1; i < messageParts.length; i++) {
            await client.sendMessage(msg.chatId!, { message: messageParts[i], parseMode: "html", replyTo: msg.id });
        }
    }
  }

  // --- 简洁模式处理器 (.cha) ---
  async handleCha(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    await msg.edit({ text: "⏳ 正在查询订阅信息..." });
    
    const myText = (msg.text ?? '').trim();
    let parts = myText.split(/\s+/).slice(1);

    const isTxtOutput = parts.length > 0 && parts[0].toLowerCase() === 'txt';
    const cleanParts = isTxtOutput ? parts.slice(1) : parts;
    
    let sourceText = '';
    if (msg.replyToMsgId) {
      try {
        const replyMsg = await safeGetReplyMessage(msg);
        if (replyMsg) sourceText = (replyMsg.text ?? '') + ' ' + ((replyMsg as any).caption ?? '');
      } catch { /* 忽略 */ }
    }
    if (cleanParts.length > 0) sourceText += ' ' + cleanParts.join(' ');
    sourceText = sourceText.trim();


    if (!sourceText) {
       await msg.edit({
        text: "❌ <b>无效的参数</b><br><br>" + 
              "💡 使用方法：<br>" +
              `• <code>${mainPrefix}cha [订阅链接]</code> - 查询订阅链接\n` +
              `• <code>${mainPrefix}cha txt [订阅链接]</code> - **以TXT文件输出**\n` +
              `• 回复包含链接的消息并发送 <code>${mainPrefix}cha</code> 或 <code>${mainPrefix}cha txt</code>`,
        parseMode: "html"
       });
       return;
    }

    const urlRegex = /https?:\/\/[^\s]+/g;
    const urls = Array.from(new Set((sourceText.match(urlRegex) ?? [])));
    if (!urls.length) {
        await msg.edit({ text: "❌ 未找到有效的订阅链接" });
        return;
    }

    const mappingsCount = await this.loadRemoteMappings();
    await msg.edit({ text: `📚 已加载 ${mappingsCount} 条配置映射，正在查询 ${urls.length} 个链接...` });

    let finalOutput = "";

    const format: (text: string) => string = isTxtOutput ? markdownEscape : htmlEscape;
    const codeTag = (text: string) => isTxtOutput ? `\`${format(text)}\`` : `<code>${htmlEscape(text)}</code>`;
    const boldTag = (text: string) => isTxtOutput ? `**${format(text)}**` : `<b>${htmlEscape(text)}</b>`;
    const separator = isTxtOutput ? '<br>' + '-'.repeat(30) + '<br>' : '<br><br>' + '='.repeat(30) + '<br><br>';

    for (const url of urls) {
        const result = await this.processSubscription(url);
        let outputText = '';

        if (!result.success) {
            let errorMsg = result.errorMessage || '连接错误';
            if (errorMsg === "无流量统计信息") {
                 outputText = `${boldTag('订阅链接')}：${codeTag(url)}\n` +
                              `${boldTag('机场名称')}：${codeTag(result.configName)}\n` +
                              `${boldTag('无流量信息')}`;
            } else {
                 outputText = `${boldTag('订阅链接')}：${codeTag(url)}\n` +
                              `${boldTag('查询失败')}: ${format(errorMsg)}`;
            }
        } else {
            const { configName, profileUrl, used, upload, download, total, remain, expireTs } = result;
            
            outputText = `${boldTag('机场名称')}：${codeTag(configName)}\n`;
            
            const finalProfileUrl = profileUrl || result.websiteInfo.website;
            if (finalProfileUrl && isHttpUrl(finalProfileUrl)) outputText += `${boldTag('官网链接')}：${formatRawUrl(finalProfileUrl, isTxtOutput)}\n`;

            outputText += `${boldTag('订阅链接')}：${codeTag(url)}\n` +
                          `\n` +
                          `${boldTag('总流量')}：${codeTag(formatSize(total))}\n` +
                          `${boldTag('已用上行')}：${codeTag(formatSize(upload))}\n` +
                          `${boldTag('已用下行')}：${codeTag(formatSize(download))}\n` +
                          `${boldTag('已用总量')}：${codeTag(formatSize(used))}\n` +
                          `${boldTag('剩余流量')}：${codeTag(formatSize(remain))}\n`;

            if (expireTs) {
                const expireTime = dayjs.unix(expireTs);
                const now = dayjs();
                const dateStr = expireTime.format("YYYY-MM-DD HH:mm:ss");
                
                outputText += `${boldTag('到期时间')}：${codeTag(dateStr)}`;
                
                if (now.isBefore(expireTime)) {
                    const diffSeconds = expireTime.diff(now, 'second');
                    outputText += `\n${boldTag('剩余时间')}：${codeTag(formatTimeRemaining(diffSeconds))}`;
                } else {
                    outputText += ` (已过期)`;
                }
            } else {
                outputText += `${boldTag('到期时间')}：${codeTag('未知或永久')}`;
            }
        }
        
        finalOutput += outputText + separator;
    }

    // 移除末尾多余的分隔符
    if (finalOutput.endsWith(separator)) {
        finalOutput = finalOutput.slice(0, -separator.length);
    }
    
    if (isTxtOutput) {
        const dateStr = dayjs().format('YYYYMMDD_HHmmss');
        const fileName = `cha_report_${dateStr}.txt`;
        const fileContent = finalOutput || "未获取到任何信息";
        const fileBuffer = Buffer.from(fileContent, 'utf-8') as Buffer & { name?: string };
        fileBuffer.name = fileName;
        
        try {
            await client.sendFile(msg.chatId!, { file: fileBuffer, caption: `✅ 简洁订阅查询报告 (共 ${urls.length} 个链接)` });
            await msg.delete(); 
        } catch (e) {
              const preview = isTxtOutput
                ? splitLongMessage(finalOutput, 1024)[0]
                : htmlEscape(splitLongMessage(finalOutput, 1024)[0]);
              await msg.edit({ text: `❌ 发送TXT文件失败，请检查权限。<br><br>部分内容：<br>${preview}`, parseMode: 'html' });
        }
    } else {
        const messageParts = splitLongMessage(finalOutput || "未获取到任何信息", 4090);
        await msg.edit({ text: messageParts[0], parseMode: "html", linkPreview: false });
        for (let i = 1; i < messageParts.length; i++) {
            await client.sendMessage(msg.chatId!, { message: messageParts[i], parseMode: "html", replyTo: msg.id });
        }
    }
  }
}

export default new SubinfoPlugin();
