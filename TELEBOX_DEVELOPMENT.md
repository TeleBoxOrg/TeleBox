# TeleBox 开发规范

## 目录

<details>
<summary><b>📁 核心架构</b></summary>

- [项目结构](#项目结构)
- [核心模块](#核心模块)
  - [程序入口 (index.ts)](#程序入口-indexts)
  - [工具模块 (utils/)](#工具模块-utils)
  - [系统插件 (plugin/)](#系统插件-plugin)
  - [Hook系统 (hook/)](#hook系统-hook)
- [目录组织](#目录组织)
  - [源码目录结构](#源码目录结构)
  - [插件目录结构](#插件目录结构)
  - [资源目录结构](#资源目录结构)
- [模块依赖关系](#模块依赖关系)
- [版本信息](#版本信息)
</details>

<details>
<summary><b>💡 生命周期管理</b></summary>

- [插件生命周期钩子](#插件生命周期钩子)
- [cleanup() 方法详解](#cleanup-方法详解)
- [资源清理最佳实践](#资源清理最佳实践)
  - [事件处理器清理](#1-事件处理器清理)
  - [定时器管理](#2-定时器管理)
  - [数据库管理](#3-数据库管理)
</details>

<details>
<summary><b>⚠️ 内存泄漏预防</b></summary>

- [常见泄漏点](#常见泄漏点)
- [内存监控工具](#内存监控工具)
- [泄漏检测技巧](#泄漏检测技巧)
- [内存泄漏排查指南](#内存泄漏排查指南)
  - [识别泄漏症状](#1-识别泄漏症状)
  - [使用诊断工具](#2-使用诊断工具)
  - [常见修复模式](#3-常见修复模式)
- [总结与最佳实践](#-总结与最佳实践)
</details>

<details>
<summary><b>🔌 插件系统</b></summary>

- [插件基类](#插件基类)
- [插件基类增强](#插件基类增强)
- [插件加载机制](#插件加载机制)
- [插件触发方式](#插件触发方式)
  - [⚠️ 安全边界声明](#-安全边界声明)
  - [命令处理器 (cmdHandlers)](#1-命令处理器-cmdhandlers)
  - [消息监听器 (listenMessageHandler)](#2-消息监听器-listenmessagehandler)
  - [事件处理器 (eventHandlers)](#3-事件处理器-eventhandlers)
  - [定时任务 (cronTasks)](#4-定时任务-crontasks)
- [事件处理器管理](#事件处理器管理)
- [定时任务管理](#定时任务管理)
</details>

<details>
<summary><b>🎨 指令架构设计</b></summary>

- [术语定义](#术语定义)
  - [指令 (Command)](#1-指令-command)
  - [子指令 (Subcommand)](#2-子指令-subcommand)
  - [别名 (Alias)](#3-别名-alias)
- [指令架构模式](#指令架构模式)
  - [主从指令模式（99%场景）](#模式一主从指令模式推荐99场景)
  - [独立指令模式（1%场景）](#模式二独立指令模式特殊场景1)
- [选择指南](#选择指南)
- [帮助系统设计](#帮助系统设计)
- [推荐的帮助文案格式](#推荐的帮助文案格式)
- [参数解析模式](#参数解析模式)
- [错误处理规范](#错误处理规范)
</details>

<details>
<summary><b>📋 开发规范</b></summary>

- [命名规范](#命名规范)
  - [文件命名](#文件命名)
  - [变量命名](#变量命名)
  - [命令命名](#命令命名)
- [代码风格](#代码风格)
  - [TypeScript规范](#typescript规范)
  - [异步处理](#异步处理)
- [错误处理](#错误处理)
  - [错误捕获](#错误捕获)
  - [错误分类](#错误分类)
- [日志规范](#日志规范)
  - [日志级别](#日志级别)
  - [日志格式](#日志格式)
- [注释规范](#注释规范)
  - [文件头注释](#文件头注释)
  - [函数注释](#函数注释)
  - [行内注释](#行内注释)
- [内存安全编码规范](#内存安全编码规范)
- [性能与并发](#性能与并发)
  - [性能优化](#性能优化)
  - [并发处理](#并发处理)
- [缓存策略](#缓存策略)
</details>

<details>
<summary><b>⚙️ 环境配置</b></summary>

- [必需配置文件](#必需配置文件)
  - [config.json - Telegram API配置](#configjson---telegram-api配置)
  - [.env - 环境变量配置](#env---环境变量配置)
  - [package.json - 项目配置](#packagejson---项目配置)
- [进程管理配置](#进程管理配置)
  - [ecosystem.config.js - PM2配置](#ecosystemconfigjs---pm2配置)
- [环境变量详解](#环境变量详解)
  - [命令前缀配置](#命令前缀配置)
  - [插件行为配置](#插件行为配置)
  - [开发模式配置](#开发模式配置)
- [配置文件示例](#配置文件示例)
</details>

<details>
<summary><b>📦 核心工具模块</b></summary>

- [插件管理器](#插件管理器)
- [全局客户端](#全局客户端)
- [数据库工具](#数据库工具)
- [实体处理工具](#实体处理工具)
- [路径管理](#路径管理)
- [群组管理](#群组管理)
- [系统功能](#系统功能)
</details>

<details>
<summary><b>🔍 核心API签名</b></summary>

- [消息限制](#消息限制)
- [Message API](#message-api)
- [Client API](#client-api)
- [Database API](#database-api)
</details>

<details>
<summary><b>📝 插件开发框架</b></summary>

- [常用工具函数](#常用工具函数)
- [开发指南](#开发指南)
  - [快速开始](#快速开始)
  - [核心API](#核心api)
  - [快速参考](#-快速参考)
- [插件开发模板](#-插件开发模板)
  - [标准插件开发模板](#-标准插件开发模板)
  - [配置管理框架](#-配置管理框架)
  - [消息处理模式](#-消息处理模式)
  - [错误处理框架](#-错误处理框架)
  - [Telegram 消息格式规范](#-telegram-消息格式规范)
</details>

<details>
<summary><b>🚀 完整插件示例</b></summary>

- [简单命令插件](#简单命令插件)
- [数据库插件](#数据库插件)
- [监听器插件](#监听器插件)
- [定时任务插件](#定时任务插件)
- [带资源清理的插件](#带资源清理的插件)
- [定时任务插件示例](#定时任务插件示例)
- [数据库插件示例](#数据库插件示例)
</details>

<details>
<summary><b>🔧 系统插件说明</b></summary>

- [基础功能插件](#基础功能插件)
  - [help - 帮助系统](#help---帮助系统)
  - [alias - 命令别名](#alias---命令别名)
  - [sudo - 权限管理](#sudo---权限管理)
  - [debug - 调试工具](#debug---调试工具)
  - [sure - 确认操作](#sure---确认操作)
- [系统管理插件](#系统管理插件)
  - [sysinfo - 系统信息](#sysinfo---系统信息)
  - [update - 更新管理](#update---更新管理)
  - [bf - 备份管理](#bf---备份管理)
  - [tpm - TeleBox插件包管理器](#tpm---telebox插件包管理器)
- [开发工具插件](#开发工具插件)
  - [exec - 命令执行](#exec---命令执行)
  - [reload - 热重载](#reload---热重载)
  - [sendLog - 日志发送](#sendlog---日志发送)
- [实用工具插件](#实用工具插件)
  - [ping - 网络测试](#ping---网络测试)
  - [prefix - 前缀管理](#prefix---前缀管理)
  - [re - 消息复读](#re---消息复读)
</details>

<details>
<summary><b>🎯 用户插件示例</b></summary>

- [群组管理类](#群组管理类)
  - [aban - 自动封禁管理](#aban---自动封禁管理)
  - [clean_member - 成员清理](#clean_member---成员清理)
  - [pmcaptcha - 私聊验证码](#pmcaptcha---私聊验证码)
- [搜索与信息类](#搜索与信息类)
  - [search - 通用搜索](#search---通用搜索)
  - [ddg - DuckDuckGo搜索](#ddg---duckduckgo搜索)
  - [soutu - 搜图](#soutu---搜图)
  - [rate - 汇率查询](#rate---汇率查询)
- [下载与媒体类](#下载与媒体类)
  - [yt-dlp - 视频下载](#yt-dlp---视频下载)
  - [getstickers - 贴纸获取](#getstickers---贴纸获取)
  - [gif - GIF处理](#gif---gif处理)
  - [eatgif - 表情包生成](#eatgif---表情包生成)
  - [audio_to_voice - 音频转语音](#audio_to_voice---音频转语音)
- [开发工具类](#开发工具类)
  - [git_PR - GitHub PR管理](#git_pr---github-pr管理)
  - [his - 历史记录](#his---历史记录)
- [娱乐游戏类](#娱乐游戏类)
  - [lottery - 抽奖系统](#lottery---抽奖系统)
  - [crazy4 - 疯狂四子棋](#crazy4---疯狂四子棋)
- [实用转换类](#实用转换类)
  - [convert - 格式转换](#convert---格式转换)
  - [encode - 编解码](#encode---编解码)
  - [qr - 二维码](#qr---二维码)
- [贴纸管理类](#贴纸管理类)
  - [sticker - 贴纸管理](#sticker---贴纸管理)
  - [pic_to_sticker - 图片转贴纸](#pic_to_sticker---图片转贴纸)
  - [sticker_to_pic - 贴纸转图片](#sticker_to_pic---贴纸转图片)
  - [copy_sticker_set - 复制贴纸包](#copy_sticker_set---复制贴纸包)
- [媒体处理类](#媒体处理类)
  - [image_monitor - 图片监控](#image_monitor---图片监控)
  - [music - 音乐搜索下载](#music---音乐搜索下载)
  - [music_bot - 音乐Bot集成](#music_bot---音乐bot集成)
- [网络工具类](#网络工具类)
  - [speedtest - 网速测试](#speedtest---网速测试)
  - [speedlink - 速度链接](#speedlink---速度链接)
  - [ip - IP查询](#ip---ip查询)
  - [whois - 域名查询](#whois---域名查询)
  - [dig - DNS查询](#dig---dns查询)
  - [warp - Cloudflare WARP管理](#warp---cloudflare-warp管理)
  - [ssh - SSH远程管理](#ssh---ssh远程管理)
- [高级功能类](#高级功能类)
  - [shift - 任务调度系统](#shift---任务调度系统)
  - [sub - 订阅管理](#sub---订阅管理)
  - [gt - Google翻译](#gt---google翻译)
  - [ids - ID查询](#ids---id查询)
- [AI与自动化类](#ai与自动化类)
  - [ai - AI助手](#ai---ai助手)
  - [aitc - AI文本分类](#aitc---ai文本分类)
  - [acron - 高级定时任务](#acron---高级定时任务)
  - [autochangename - 自动改名](#autochangename---自动改名)
  - [autodel - 自动删除](#autodel---自动删除)
  - [autodelcmd - 自动删除命令](#autodelcmd---自动删除命令)
</details>

<details>
<summary><b>⚠️ 重要注意事项</b></summary>

- [代码细节说明](#代码细节说明)
- [开发最佳实践](#开发最佳实践)
</details>

## 📁 核心架构

### 项目结构

```
telebox/
├── src/                    # 源代码目录
│   ├── index.ts           # 程序入口
│   ├── utils/             # 核心工具模块 (17个文件)
│   ├── plugin/            # 系统插件 (15个文件)
│   └── hook/              # Hook系统
├── plugins/               # 用户插件目录
├── assets/                # 资源文件目录
├── temp/                  # 临时文件目录
├── logs/                  # 日志目录
├── node_modules/          # NPM依赖包
├── config.json            # Telegram API配置
├── .env                   # 环境变量配置
├── package.json          # 项目配置
├── tsconfig.json         # TypeScript配置
└── ecosystem.config.js   # PM2进程管理配置
```

### 核心模块

#### 程序入口 (index.ts)

```typescript
import "dotenv/config";
import { login } from "@utils/loginManager";
import { loadPlugins } from "@utils/pluginManager";
import { patchMsgEdit } from "hook/listen";
import "./hook/patches/telegram.patch";

// patchMsgEdit(); // Hook功能（当前已注释）

async function run() {
  await login();          // 登录Telegram
  await loadPlugins();    // 加载插件
}

run();
```

**职责**：
- 加载环境变量
- 初始化Telegram客户端
- 加载插件系统
- 应用Hook补丁

#### 工具模块 (utils/)

17个核心工具文件：

| 文件名 | 功能说明 |
|--------|----------|
| `pluginBase.ts` | 插件基类定义 |
| `pluginManager.ts` | 插件管理器，负责加载和路由 |
| `globalClient.ts` | 全局Telegram客户端实例 |
| `loginManager.ts` | 登录管理器 |
| `apiConfig.ts` | API配置管理 |
| `pathHelpers.ts` | 路径辅助工具 |
| `entityHelpers.ts` | Telegram实体处理工具 |
| `aliasDB.ts` | 命令别名数据库 |
| `sudoDB.ts` | 管理员权限数据库 |
| `sureDB.ts` | 确认操作数据库 |
| `sendLogDB.ts` | 发送日志数据库 |
| `banUtils.ts` | 封禁管理工具 |
| `cronManager.ts` | 定时任务管理器 |
| `conversation.ts` | 对话管理器 |
| `tlRevive.ts` | Telegram实体序列化工具 |
| `npm_install.ts` | NPM包安装工具 |
| `teleboxInfoHelper.ts` | 系统信息助手 |

#### 系统插件 (plugin/)

15个内置插件：

| 插件名 | 功能说明 |
|--------|----------|
| `alias.ts` | 命令别名管理 |
| `bf.ts` | 备份功能 |
| `debug.ts` | 调试工具 |
| `exec.ts` | 命令执行 |
| `help.ts` | 帮助系统 |
| `ping.ts` | 网络测试 |
| `prefix.ts` | 前缀管理 |
| `re.ts` | 消息复读 |
| `reload.ts` | 热重载 |
| `sendLog.ts` | 日志发送 |
| `sudo.ts` | 权限管理 |
| `sure.ts` | 确认操作 |
| `sysinfo.ts` | 系统信息 |
| `tpm.ts` | 插件包管理器 |
| `update.ts` | 更新管理 |

#### Hook系统 (hook/)

- `listen.ts` - 消息监听器和编辑补丁（为sudo用户提供特殊消息处理）
- `patches/` - Telegram API补丁
- `types/` - 类型定义

**特殊功能**：
- 为sudo管理员用户提供消息编辑重定向功能
- 可通过 `patchMsgEdit()` 启用（默认注释）

### 目录组织

#### 源码目录结构

```
src/
├── index.ts              # 程序入口
├── utils/                # 工具模块
│   ├── pluginBase.ts
│   ├── pluginManager.ts
│   └── ...
├── plugin/               # 系统插件
│   ├── help.ts
│   ├── alias.ts
│   └── ...
└── hook/                 # Hook系统
    ├── listen.ts
    ├── patches/
    └── types/
```

#### 插件目录结构

```
plugins/
├── example.ts           # 用户插件
├── another.ts
└── .gitkeep
```

**规范**：
- 文件命名：`snake_case.ts`
- 导出方式：`export default new PluginClass()`
- 加载顺序：用户插件 > 系统插件

#### 资源目录结构

```
assets/
├── plugin_name/         # 插件专用目录
│   ├── data.json       # lowdb JSON数据库
│   ├── config.json     # 配置文件
│   └── media/          # 媒体文件
└── .gitkeep

temp/
├── backup/             # 备份文件
├── convert/            # 转换文件
├── download/           # 下载文件
└── upload/             # 上传文件

logs/
├── out.log            # 标准输出
├── error.log          # 错误日志
└── plugin.log         # 插件日志
```

### 模块依赖关系

```
index.ts
  ├── loginManager → 登录Telegram
  ├── pluginManager → 加载插件
  │     ├── pluginBase → 插件基类
  │     ├── plugins/* → 用户插件
  │     └── src/plugin/* → 系统插件
  └── hook/listen → 消息监听
        └── patches → API补丁

utils/* (工具模块)
  ├── globalClient → Telegram客户端
  ├── *DB.ts → 数据库操作
  ├── cronManager → 定时任务
  └── conversation → 对话管理
```

### 版本信息

- **当前版本**: 0.2.6
- **Node.js要求**: >= 14.x
- **TypeScript版本**: ^5.9.2
- **Telegram库版本**: ^2.26.22
- **协议**: LGPL-2.1-only

## 💡 生命周期管理

### 插件生命周期钩子

新版本TeleBox 引入了完整的插件生命周期管理，以解决内存泄漏问题。每个插件现在支持以下生命周期钩子：

```typescript
abstract class Plugin {
  // 基本属性保持不变...
  
  /**
   * 插件销毁前调用 - 必须实现
   * 用于清理所有资源，防止内存泄漏
   */
  abstract cleanup(): Promise<void> | void;
  
  /**
   * 插件加载后调用（可选）
   * 用于初始化资源
   */
  async onLoad?(): Promise<void> | void;
  
  /**
   * 插件暂停时调用（可选）
   * 用于临时暂停资源（如定时器）
   */
  async onPause?(): Promise<void> | void;
  
  /**
   * 插件恢复时调用（可选）
   * 用于恢复暂停的资源
   */
  async onResume?(): Promise<void> | void;
}
```

### cleanup() 方法详解

`cleanup()` 方法是解决内存泄漏的核心。每次插件被重载或系统关闭时，TeleBox 会自动调用此方法。开发者必须在此方法中清理所有外部资源：

```typescript
class MyPlugin extends Plugin {
  private timers: NodeJS.Timeout[] = [];
  private dbConnection: any = null;
  private eventListeners: Array<{ event: string, handler: Function }> = [];
  
  async cleanup(): Promise<void> {
    console.log(`[MyPlugin] Starting cleanup...`);
    
    // 1. 清理定时器
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers = [];
    
    // 2. 关闭数据库连接
    if (this.dbConnection) {
      await this.dbConnection.close();
      this.dbConnection = null;
    }
    
    // 3. 移除事件监听器
    const client = await getGlobalClient();
    this.eventListeners.forEach(({ event, handler }) => {
      client.removeListener(event, handler);
    });
    this.eventListeners = [];
    
    // 4. 清理 cron 任务
    Object.keys(this.cronTasks || {}).forEach(taskName => {
      cronManager.del(taskName);
    });
    
    // 5. 显式释放大对象引用
    this.largeDataCache = null;
    
    console.log(`[MyPlugin] Cleanup completed successfully`);
  }
}
```

### 资源清理最佳实践

#### 1. 事件处理器清理

```typescript
// ❌ 错误：无法移除匿名函数
this.eventListeners.push(
  client.addEventHandler(async (event) => {
    // 处理逻辑
  }, new NewMessage())
);

// ✅ 正确：保存引用以便清理
const handler = async (event: NewMessageEvent) => {
  // 处理逻辑
};
this.eventListeners.push({ 
  event: new NewMessage(), 
  handler 
});
client.addEventHandler(handler, new NewMessage());
```

#### 2. 定时器管理

```typescript
class TimerPlugin extends Plugin {
  private activeTimers = new Map<string, NodeJS.Timeout>();
  
  startTimer(id: string, delay: number) {
    const timer = setTimeout(() => {
      this.activeTimers.delete(id);
      // 处理逻辑
    }, delay);
    
    this.activeTimers.set(id, timer);
  }
  
  async cleanup() {
    // 清理所有定时器
    for (const [id, timer] of this.activeTimers) {
      clearTimeout(timer);
      console.log(`[TimerPlugin] Cleared timer ${id}`);
    }
    this.activeTimers.clear();
  }
}
```

#### 3. 数据库管理

```typescript
class DatabasePlugin extends Plugin {
  private db: any = null;
  
  async initDB() {
    if (!this.db) {
      const dbPath = path.join(createDirectoryInAssets(this.constructor.name), 'data.json');
      this.db = await JSONFilePreset(dbPath, {  [] });
      console.log(`[DatabasePlugin] Database initialized`);
    }
  }
  
  async cleanup() {
    // 显式关闭文件句柄
    if (this.db?.write) {
      await this.db.write();
    }
    this.db = null;
    
    console.log(`[DatabasePlugin] Database connection closed`);
  }
}
```

## ⚠️ 内存泄漏预防

### 常见泄漏点

1. **未移除的事件监听器** - 最常见原因
2. **未清理的定时器/间隔** - setTimeout/setInterval
3. **闭包引用** - 内部函数引用外部变量
4. **全局变量** - 未清理的缓存和大对象
5. **数据库连接** - 未关闭的文件句柄
6. **未停止的Cron任务** - 在重载时继续运行

### 内存监控工具

新版本TeleBox 内置内存监控工具，可通过 `.mem` 命令查看：

```typescript
// 内存监控工具
class MemoryMonitor {
  static snapshot(): NodeJS.MemoryUsage {
    return process.memoryUsage();
  }
  
  static formatMemory(usage: NodeJS.MemoryUsage): string {
    const format = (bytes: number) => (bytes / 1024 / 1024).toFixed(2) + 'MB';
    return `Heap Used: ${format(usage.heapUsed)}\n` +
           `Heap Total: ${format(usage.heapTotal)}\n` +
           `RSS: ${format(usage.rss)}\n` +
           `External: ${format(usage.external)}`;
  }
  
  static diff(before: NodeJS.MemoryUsage, after: NodeJS.MemoryUsage) {
    const diff = {
      heapUsed: after.heapUsed - before.heapUsed,
      heapTotal: after.heapTotal - before.heapTotal,
      rss: after.rss - before.rss
    };
    
    console.log(`[MemoryMonitor] Memory diff:`, {
      heapUsed: (diff.heapUsed / 1024 / 1024).toFixed(2) + 'MB',
      heapTotal: (diff.heapTotal / 1024 / 1024).toFixed(2) + 'MB',
      rss: (diff.rss / 1024 / 1024).toFixed(2) + 'MB'
    });
    
    return diff;
  }
  
  static async triggerGC(): Promise<void> {
    if (typeof global.gc === 'function') {
      console.log('[MemoryMonitor] Triggering garbage collection');
      global.gc();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
```

### 泄漏检测技巧

1. **定期内存快照**：

```typescript
const before = MemoryMonitor.snapshot();
// 执行操作
const after = MemoryMonitor.snapshot();
MemoryMonitor.diff(before, after);
```

2. **重载测试**：

```bash
# 连续重载5次，观察内存增长
for i in {1..5}; do echo ".reload"; sleep 2; done
```

3. **内存增长阈值**：

```typescript
const MAX_MEMORY_GROWTH = 5 * 1024 * 1024; // 5MB
if (heapUsedDiff > MAX_MEMORY_GROWTH) {
  console.warn(`[MemoryLeak] Potential leak detected in ${plugin.name}`);
  // 发送警告给管理员
}
```

### 内存泄漏排查指南

#### 1. 识别泄漏症状
- 重载插件后内存持续增长
- 系统响应变慢
- 垃圾回收后内存未明显下降
- 通过 `.mem` 命令观察内存使用情况

#### 2. 使用诊断工具

```typescript
// 添加到插件中
async debugMemory(msg: Api.Message) {
  const before = MemoryMonitor.snapshot();
  
  // 执行可能导致泄漏的操作
  await this.suspectOperation();
  
  const after = MemoryMonitor.snapshot();
  const diff = MemoryMonitor.diff(before, after);
  
  await msg.edit({
    text: `🔍 <b>内存诊断</b>\n\n` +
          `_HEAP USED: ${(diff.heapUsed / 1024 / 1024).toFixed(2)}MB_\n` +
          `_HEAP TOTAL: ${(diff.heapTotal / 1024 / 1024).toFixed(2)}MB_`,
    parseMode: "html"
  });
}
```

#### 3. 常见修复模式

##### 问题：匿名事件处理器

```typescript
// 问题代码
client.addEventHandler(async (event) => {
  // 处理逻辑
}, new NewMessage());

// 修复方案
const handler = async (event: NewMessageEvent) => {
  // 处理逻辑
};
this.registeredHandler = handler; // 保存引用
client.addEventHandler(handler, new NewMessage());

// 在 cleanup() 中
client.removeEventHandler(this.registeredHandler, new NewMessage());
```

##### 问题：未清理的定时器

```typescript
// 问题代码
setInterval(() => {
  // 定期任务
}, 1000);

// 修复方案
this.cleanupTasks = [];
this.cleanupTasks.push(setInterval(() => {
  // 定期任务
}, 1000));

// 在 cleanup() 中
this.cleanupTasks.forEach(task => clearInterval(task));
this.cleanupTasks = [];
```

##### 问题：大对象缓存

```typescript
// 问题代码
this.cache = new Map(); // 无限增长

// 修复方案
this.cache = new Map();
this.MAX_CACHE_SIZE = 100;

addToCache(key, value) {
  if (this.cache.size >= this.MAX_CACHE_SIZE) {
    const oldestKey = this.cache.keys().next().value;
    this.cache.delete(oldestKey);
  }
  this.cache.set(key, value);
}

// 在 cleanup() 中
this.cache.clear();
```

### ✅ 总结与最佳实践

1. **强制实现 `cleanup()`**：所有插件必须实现 cleanup() 方法
2. **资源跟踪**：使用数组或Map跟踪创建的所有资源
3. **弱引用优先**：对不需要强引用的对象使用 WeakMap/WeakSet
4. **限制缓存**：设置缓存大小上限，定期清理
5. **错误容忍**：cleanup() 中使用 try-catch，确保部分失败不影响整体
6. **内存监控**：定期使用 `.mem` 命令监控内存使用
7. **重载测试**：开发时多次重载插件，观察内存变化
8. **文档注释**：在插件代码中详细注释资源清理逻辑

通过遵循这些规范和实践，新版本TeleBox 插件开发者可以创建内存安全的插件，避免在重载和长期运行中出现内存泄漏问题。系统级的生命周期管理和资源跟踪机制为开发者提供了强大的基础支持。

> **重要提示**：从新版本TeleBox 开始，未实现 `cleanup()` 方法的插件将无法通过验证，系统会拒绝加载此类插件。这是确保整个插件生态系统内存安全的关键措施。

## 🔌 插件系统

### 插件基类

**实际实现** (`src/utils/pluginBase.ts`)：

```typescript
type CronTask = {
  cron: string;
  description: string;
  handler: (client: TelegramClient) => Promise<void>;
};

abstract class Plugin {
  name?: string;
  ignoreEdited?: boolean = cmdIgnoreEdited;  // 默认从环境变量读取
  
  abstract description:
    | string
    | ((...args: any[]) => string | void)
    | ((...args: any[]) => Promise<string | void>);
  
  abstract cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  >;
  
  listenMessageHandlerIgnoreEdited?: boolean = true;  // 默认忽略编辑消息
  listenMessageHandler?: (
    msg: Api.Message,
    options?: { isEdited?: boolean }
  ) => Promise<void>;
  
  eventHandlers?: Array<{
    event?: any;
    handler: (event: any) => Promise<void>;
  }>;
  
  cronTasks?: Record<string, CronTask>;
}

// 插件验证函数
function isValidPlugin(obj: any): obj is Plugin {
  if (!obj) return false;
  
  // 验证 description
  const desc = obj.description;
  const isValidDescription = typeof desc === "string" || typeof desc === "function";
  if (!isValidDescription) return false;
  
  // 验证 cmdHandlers
  if (typeof obj.cmdHandlers !== "object" || obj.cmdHandlers === null) {
    return false;
  }
  
  // 验证其他可选字段...
  return true;
}
```

**字段说明**：
- `name` - 插件名称，不填则自动使用文件名
- `ignoreEdited` - 命令是否忽略编辑消息，默认从 `TB_CMD_IGNORE_EDITED` 环境变量读取
- `description` - 插件描述，可以是字符串或函数
- `cmdHandlers` - 命令处理器，必须实现
- `listenMessageHandler` - 消息监听器，可选
- `eventHandlers` - 事件处理器，可选
- `cronTasks` - 定时任务，可选

### 插件基类增强

更新后的插件基类包含内存管理钩子：

```typescript
import { Api, TelegramClient } from "telegram";

type CronTask = {
  cron: string;
  description: string;
  handler: (client: TelegramClient) => Promise<void>;
};

const cmdIgnoreEdited = !!JSON.parse(
  process.env.TB_CMD_IGNORE_EDITED || "true"
);
console.log(
  `[CMD_IGNORE_EDITED] 命令监听忽略编辑的消息: ${cmdIgnoreEdited} (可使用环境变量 TB_CMD_IGNORE_EDITED 覆盖)`
);

abstract class Plugin {
  // 基本属性
  name?: string;
  ignoreEdited?: boolean = cmdIgnoreEdited;
  
  // 描述和命令处理器
  abstract description:
    | string
    | ((...args: any[]) => string | void)
    | ((...args: any[]) => Promise<string | void>);
  
  abstract cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  >;
  
  // 消息监听
  listenMessageHandlerIgnoreEdited?: boolean = true;
  listenMessageHandler?: (
    msg: Api.Message,
    options?: { isEdited?: boolean }
  ) => Promise<void>;
  
  // 事件处理器
  eventHandlers?: Array<{
    event?: any;
    handler: (event: any) => Promise<void>;
    id?: string; // 唯一标识，用于清理
  }>;
  
  // 定时任务
  cronTasks?: Record<string, CronTask>;
  
  /**
   * 插件销毁前调用 - 必须实现
   * 用于清理所有资源，防止内存泄漏
   */
  abstract cleanup(): Promise<void> | void;
  
  /**
   * 插件加载后调用（可选）
   * 用于初始化资源
   */
  async onLoad?(): Promise<void> | void;
  
  /**
   * 插件暂停时调用（可选）
   * 用于临时暂停资源（如定时器）
   */
  async onPause?(): Promise<void> | void;
  
  /**
   * 插件恢复时调用（可选）
   * 用于恢复暂停的资源
   */
  async onResume?(): Promise<void> | void;
}

// 运行时校验函数（增强版）
function isValidPlugin(obj: any): obj is Plugin {
  if (!obj) return false;
  
  // 验证基本属性...
  
  // 新增：验证 cleanup 方法
  if (typeof obj.cleanup !== 'function') {
    console.error('[PluginValidation] Plugin missing required cleanup() method');
    return false;
  }
  
  return true;
}

export { Plugin, isValidPlugin };
```

### 插件加载机制

**加载流程** (`src/utils/pluginManager.ts`)：

```typescript
const USER_PLUGIN_PATH = path.join(process.cwd(), "plugins");
const DEFAUTL_PLUGIN_PATH = path.join(process.cwd(), "src", "plugin");  // 注意：实际代码中是DEFAUTL而非DEFAULT

// 1. 先加载用户插件
await setPlugins(USER_PLUGIN_PATH);

// 2. 再加载系统插件
await setPlugins(DEFAUTL_PLUGIN_PATH);
```

**加载规则**：
1. 扫描目录下所有 `.ts` 文件
2. 使用动态 `require` 加载模块
3. 检查是否为有效的 `Plugin` 实例
4. 注册命令到全局命令表
5. 处理命令别名

**优先级**：
- 用户插件先加载，可以覆盖系统插件
- 同名命令：后加载覆盖先加载
- 监听器和事件处理器：全部执行，不互斥

### 插件触发方式

#### ⚠️ 安全边界声明

**重要：为防止Telegram风控和滥用，必须明确各种触发器的边界**

1. **命令处理器边界**
   - ✅ 只能通过指定前缀触发（`.` `。` `$` 等）
   - ✅ 必须明确命令开头，不能随意匹配
   - ❌ 禁止监控所有消息内容

2. **消息监听器限制**
   - ⚠️ 禁止无目的监控全部聊天
   - ✅ 必须有明确的业务需求和过滤条件
   - ✅ 需要处理的消息类型必须明确限定
   - ❌ 避免触发Telegram风控机制

3. **事件处理器规范**
   - ✅ 只处理必要的特定事件
   - ❌ 不得滥用事件监听

4. **定时任务约束**
   - ✅ 控制执行频率，避免过度请求
   - ❌ 不得在所有会话中随意发送消息

#### 1. 命令处理器 (cmdHandlers)

**触发条件**：
- 仅当消息以配置的前缀开头时触发
- 默认前缀：`.` `。` `$`
- 开发环境前缀：`!` `！`
- 通过 `TB_PREFIX` 环境变量自定义

**示例**：

```typescript
cmdHandlers = {
  help: async (msg: Api.Message) => {
    // 只在用户输入 .help 时触发
    await msg.reply({ message: "帮助信息" });
  }
};
```

#### 2. 消息监听器 (listenMessageHandler)

**触发条件**：
- 监听**所有消息**，不管是否有命令前缀
- 可用于实现自动回复、内容过滤、统计等功能
- 通过 `listenMessageHandlerIgnoreEdited` 控制是否忽略编辑消息

**示例**：

```typescript
listenMessageHandler = async (msg: Api.Message, options?: { isEdited?: boolean }) => {
  // 监听所有消息，必须有明确过滤条件
  if (msg.photo) {
    // 只处理图片消息
    await handleImage(msg);
  }
};
```

**注意**：
- 这是 `image_monitor` 插件"不用触发指令就触发"的原因
- 必须有明确的过滤逻辑，不能对所有消息都处理

#### 3. 事件处理器 (eventHandlers)

**触发条件**：
- 监听特定的 Telegram 事件
- 如新成员加入、消息删除等

**示例**：

```typescript
eventHandlers = [
  {
    event: new NewMessage({}),
    handler: async (event) => {
      // 处理新消息事件
    }
  }
];
```

#### 4. 定时任务 (cronTasks)

**触发条件**：
- 按 cron 表达式定期执行
- 用于定时清理、备份等任务

**示例**：

```typescript
cronTasks = {
  backup: {
    cron: "0 0 * * *",  // 每天凌晨执行
    description: "每日备份",
    handler: async (client) => {
      // 执行备份任务
    }
  }
};
```

### 事件处理器管理

新版本TeleBox 现在提供专门的事件处理器注册和清理机制：

```typescript
// utils/eventManager.ts
class EventManager {
  private static handlers = new Map<string, Array<{
    handler: Function;
    event: any;
    pluginName: string;
    cleanup?: Function;
  }>>();
  
  static register(pluginName: string, handler: Function, event: any, options?: {
    cleanup?: Function;
  }): string {
    const handlerId = `${pluginName}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    
    const client = getGlobalClientSync();
    client?.addEventHandler(handler, event);
    
    if (!this.handlers.has(pluginName)) {
      this.handlers.set(pluginName, []);
    }
    
    this.handlers.get(pluginName)!.push({
      handler,
      event,
      pluginName,
      cleanup: options?.cleanup
    });
    
    return handlerId;
  }
  
  static async cleanupPlugin(pluginName: string): Promise<number> {
    const handlers = this.handlers.get(pluginName) || [];
    const client = getGlobalClientSync();
    
    let removedCount = 0;
    
    for (const { handler, event, cleanup } of handlers) {
      try {
        // 1. 移除事件监听
        client?.removeEventHandler(handler, event);
        
        // 2. 调用自定义清理函数
        if (cleanup) {
          await cleanup();
        }
        
        removedCount++;
      } catch (error) {
        console.error(`[EventManager] Error cleaning up handler for ${pluginName}:`, error);
      }
    }
    
    this.handlers.delete(pluginName);
    return removedCount;
  }
  
  static async cleanupAll(): Promise<number> {
    let totalRemoved = 0;
    
    for (const pluginName of this.handlers.keys()) {
      totalRemoved += await this.cleanupPlugin(pluginName);
    }
    
    console.log(`[EventManager] Total ${totalRemoved} event handlers removed`);
    return totalRemoved;
  }
}

export { EventManager };
```

### 定时任务管理

Cron 任务管理器也进行了增强，支持按插件清理：

```typescript
// utils/cronManager.ts (增强版)
class CronManager {
  private tasks = new Map<string, CronTask & { pluginName?: string }>();
  
  set(name: string, cron: string, handler: () => void | Promise<void>, options?: {
    pluginName?: string;
    description?: string;
  }): void {
    // 验证和创建任务...
    
    this.tasks.set(name, {
      ...task,
      pluginName: options?.pluginName
    });
  }
  
  del(name: string): boolean {
    const task = this.tasks.get(name);
    if (!task) return false;
    
    task.job.stop();
    this.tasks.delete(name);
    return true;
  }
  
  // 新增：按插件名称清理任务
  delByPlugin(pluginName: string): number {
    let removedCount = 0;
    const toRemove = [];
    
    for (const [name, task] of this.tasks) {
      if (task.pluginName === pluginName) {
        toRemove.push(name);
      }
    }
    
    for (const name of toRemove) {
      if (this.del(name)) {
        removedCount++;
      }
    }
    
    return removedCount;
  }
  
  clear(): void {
    // 清理所有任务
    for (const task of this.tasks.values()) {
      task.job.stop();
    }
    this.tasks.clear();
  }
  
  // 新增：获取任务统计
  getStats() {
    return {
      total: this.tasks.size,
      byPlugin: Array.from(this.tasks.values()).reduce((acc, task) => {
        if (task.pluginName) {
          acc[task.pluginName] = (acc[task.pluginName] || 0) + 1;
        }
        return acc;
      }, {} as Record<string, number>)
    };
  }
}
```

## 🎨 指令架构设计

### 术语定义

#### 1. 指令 (Command)
在 `cmdHandlers` 中注册的顶级键，用户可以直接调用。

```typescript
cmdHandlers = {
  kick: handleKick,    // "kick" 是一个指令
  music: handleMusic   // "music" 是一个指令
}
```

#### 2. 子指令 (Subcommand)
指令内部通过参数解析处理的功能分支，不能独立调用。

```typescript
// .music search 歌名  <- "search" 是 music 指令的子指令
// .music cookie set   <- "cookie" 是 music 指令的子指令
```

#### 3. 别名 (Alias)
同一功能的不同调用方式，通常是简写形式。

```typescript
// 指令级别别名
cmdHandlers = {
  speedtest: handleSpeed,  // 主指令
  st: handleSpeed,        // 别名
}

// 子指令级别别名
case 'search':
case 's':  // "s" 是 "search" 的别名
  await this.handleSearch();
  break;
```

### 指令架构模式

#### 模式一：主从指令模式（推荐，99%场景）
**适用场景：** 功能相关，共享配置或状态，需要统一管理

```typescript
class MusicPlugin extends Plugin {
  cmdHandlers = {
    music: async (msg) => {
      const parts = msg.text?.split(/\s+/) || [];
      const [, sub, ...args] = parts;
      
      switch(sub?.toLowerCase()) {
        case 'search':
        case 's':  // 别名
          await this.handleSearch(args.join(' '));
          break;
        case 'cookie':
          await this.handleCookie(args);
          break;
        default:
          // 默认行为：help/h/无参 => 帮助；否则直达搜索
          if (!sub || sub.toLowerCase() === 'help' || sub.toLowerCase() === 'h') {
            await this.showHelp(msg);
          } else {
            await this.handleSearch(msg.text?.split(/\s+/).slice(1).join(' '));
          }
      }
    }
  }
}
// 用户使用：.music search 歌名、.music cookie set、.music help
```

**实际案例（SSH插件）：**

```typescript
class SSHPlugin extends Plugin {
  cmdHandlers = {
    ssh: async (msg: Api.Message) => {
      const parts = msg.text?.split(/\s+/) || [];
      const cmd = (parts[1] || "help").toLowerCase();
      
      switch(cmd) {
        case "list":
        case "ls":
          await this.listServers(msg);
          break;
        case "add":
          await this.addServer(msg);
          break;
        case "exec":
          await this.executeCommand(msg);
          break;
        default:
          await msg.edit({ text: help_text, parseMode: "html" });
      }
    }
  }
}
```

**特点：**
- 单一主指令入口
- 内部路由处理子功能
- 支持子指令别名
- 便于功能扩展和配置管理
- 统一的错误处理

#### 模式二：独立指令模式（特殊场景，1%）  
**适用场景：** 功能完全独立，需要提供便捷的短指令

```typescript
class SpeedTestPlugin extends Plugin {
  cmdHandlers = {
    speedtest: handleSpeedTest,  // 完整指令
    st: handleSpeedTest,         // 短别名
  }
}
// 用户使用：.speedtest 或 .st
```

**实际案例（Aban插件）：**

```typescript
class AbanPlugin extends Plugin {
  cmdHandlers = {
    // 帮助命令
    aban: async (msg) => {
      await MessageManager.smartEdit(msg, HELP_TEXT);
    },
    
    // 基础管理命令 - 每个都是独立指令
    kick: async (msg) => {
      await CommandHandlers.handleBasicCommand(client, msg, 'kick');
    },
    ban: async (msg) => {
      await CommandHandlers.handleBasicCommand(client, msg, 'ban');
    },
    unban: async (msg) => {
      await CommandHandlers.handleBasicCommand(client, msg, 'unban');
    },
    mute: async (msg) => {
      await CommandHandlers.handleBasicCommand(client, msg, 'mute');
    },
    unmute: async (msg) => {
      await CommandHandlers.handleBasicCommand(client, msg, 'unmute');
    },
    
    // 批量管理命令
    sb: async (msg) => {
      await CommandHandlers.handleSuperBan(client, msg);
    },
    unsb: async (msg) => {
      await CommandHandlers.handleSuperUnban(client, msg);
    }
  }
}
// 用户使用：.kick @user、.ban @user、.mute @user 等
```

**特点：**
- 每个指令都是独立的处理函数
- 支持指令级别的别名
- 适合单一功能插件
- 用户可使用短指令快速访问

### 选择指南

**默认选择：主从指令模式（99%）**
- ✅ 多个相关功能
- ✅ 需要子命令（如 add、remove、list）
- ✅ 共享配置或状态
- ✅ 功能可能扩展

**何时使用独立指令模式（1%）：**
- 单一独立功能
- 需要极简的快捷指令
- 功能不会扩展
- 与其他功能无关联

### 帮助系统设计

 **所有插件必须：**
 1. 定义 `help_text` 常量
 2. 在 `description` 中引用帮助文本
 3. 支持 help 子指令或无参数时显示帮助
 4. help 触发规范：必须同时支持 `help` 与 `h` 子指令触发帮助；实现需遵循在 `description` 中引用 `help_text` 的方式，并在无参数、`help` 或 `h` 时统一返回帮助文本

### 推荐的帮助文案格式

为保持插件帮助信息的一致性和可读性，推荐使用以下包含 Emoji 和 HTML 标签的格式。这有助于用户快速理解插件功能和用法。

**格式模板:**

```typescript
const help_text = `⚙️ <b>[插件名]</b>

<b>📝 功能描述:</b>
• [功能1说明]
• [功能2说明]

<b>🔧 使用方法:</b>
• <code>[命令1]</code> - [说明]
• <code>[命令2]</code> - [说明]

<b>💡 示例:</b>
• <code>[示例命令]</code> - [说明]

<b>📊 数据来源:</b> (可选)
• [来源说明]
`;
```

**关键点:**
- **标题**: 使用 Emoji 和 `<b>` 标签，如 `⚙️ <b>插件名</b>`。
- **段落标题**: 使用 Emoji 和 `<b>` 标签，如 `📝 <b>功能描述:</b>`。
- **命令**: 使用 `<code>` 标签包裹。
- **结构清晰**: 分为功能描述、使用方法、示例等板块，便于查阅。

**完整示例:**

```typescript
class StandardPlugin extends Plugin {
  // 定义帮助文本常量
  private readonly PLUGIN_NAME = "standard_plugin";
  
  private readonly HELP_TEXT = `📝 <b>${this.PLUGIN_NAME}</b>
  
<b>命令格式：</b>
<code>.cmd [子命令] [参数]</code>

<b>可用命令：</b>
• <code>.cmd start</code> - 启动功能
• <code>.cmd stop</code> - 停止功能
• <code>.cmd status</code> - 查看状态
• <code>.cmd help</code> - 显示帮助`;

  // 描述中引用帮助文本
  description = `标准插件示例\n\n${this.HELP_TEXT}`;

  cmdHandlers = {
    cmd: async (msg: Api.Message) => {
      const args = msg.text?.split(/\s+/) || [];
      const subCommand = args[1]?.toLowerCase();

      try {
        // 子命令路由
        switch (subCommand) {
          case "start":
            await this.handleStart(msg);
            break;
          case "stop":
            await this.handleStop(msg);
            break;
          case "status":
            await this.handleStatus(msg);
            break;
          default:
            await this.handleDefault(msg, subCommand);
        }
      } catch (error: any) {
        await sendError(msg, error, this.PLUGIN_NAME);
      }
    }
  };

  // 默认处理
  private async handleDefault(msg: Api.Message, sub: string | undefined) {
    if (!sub || sub === "help" || sub === "h") {
      await msg.edit({ text: this.HELP_TEXT, parseMode: "html" });
    } else {
      await msg.edit({ 
        text: `❌ <b>未知子命令:</b> ${sub}\n\n${this.HELP_TEXT}`, 
        parseMode: "html" 
      });
    }
  }

  private async handleStart(msg: Api.Message) {
    await msg.edit({ text: "✅ 已启动", parseMode: "html" });
  }

  private async handleStop(msg: Api.Message) {
    await msg.edit({ text: "⏹️ 已停止", parseMode: "html" });
  }

  private async handleStatus(msg: Api.Message) {
    await msg.edit({ text: "📊 运行中", parseMode: "html" });
  }
}

export default new StandardPlugin();
```

### 参数解析模式

#### 单行命令解析

```typescript
const parts = msg.text?.split(/\s+/) || [];
const [cmd, sub, ...args] = parts;
// .music search hello world -> ["music", "search", "hello", "world"]
```

#### 多行命令解析（复杂参数）

```typescript
const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
const parts = lines[0]?.split(/\s+/) || [];
const [cmd, sub] = parts;
const param1 = lines[1]; // 第二行作为参数1
const param2 = lines[2]; // 第三行作为参数2
// 适用于需要多行输入的场景，如SSH配置、长文本等
```

### 错误处理规范

```typescript
cmdHandlers = {
  cmd: async (msg) => {
    try {
      // 参数验证
      if (!args.length) {
        await msg.edit({ 
          text: "❌ 请提供必要参数", 
          parseMode: "html" 
        });
        return;
      }
      
      // 业务逻辑
      await this.doSomething();
      
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] 错误:`, error);
      await msg.edit({ 
        text: `❌ 错误: ${htmlEscape(error.message)}`,
        parseMode: "html" 
      });
    }
  }
}
```

## 📋 开发规范

### 命名规范

#### 文件命名
- **插件文件**: `snake_case.ts` (如 `image_monitor.ts`)
- **工具模块**: `camelCase.ts` (如 `pluginBase.ts`)
- **类型定义**: `PascalCase.d.ts` (如 `TelegramTypes.d.ts`)

⚠️ **禁止**插件文件使用单字母 (如 `a.ts`, `x.ts` 等)

#### 变量命名

```typescript
// 常量：全大写下划线分隔
const MAX_RETRY_TIMES = 3;
const API_BASE_URL = "https://api.telegram.org";

// 变量：小驼峰
let messageCount = 0;
const userName = "Alice";

// 函数：小驼峰，动词开头
function sendMessage() {}
async function fetchUserData() {}

// 类：大驼峰
class MessageHandler {}
interface PluginConfig {}
```

#### 命令命名
- 使用小写字母
- 简短易记
- 避免特殊字符
- 示例：`help`, `start`, `config`

⚠️ **插件指令的主指令必须是插件文件名**，其余别名可以在帮助文档中声明，但主指令必须与文件名一致

### 代码风格

#### TypeScript规范

```typescript
// 使用严格模式
"use strict";

// 显式类型声明
const count: number = 0;
const name: string = "TeleBox";

// 使用接口定义对象结构
interface Config {
  enabled: boolean;
  timeout: number;
}

// 使用枚举定义常量集合
enum LogLevel {
  DEBUG = "debug",
  INFO = "info",
  ERROR = "error"
}
```

#### 异步处理

```typescript
// 优先使用 async/await
async function processMessage(msg: Api.Message): Promise<void> {
  try {
    const result = await someAsyncOperation();
    await msg.edit({ text: result });
  } catch (error) {
    await handleError(error, msg);
  }
}

// 避免回调地狱
// ❌ 错误示例
getData((data) => {
  processData(data, (result) => {
    saveResult(result, () => {});
  });
});

// ✅ 正确示例
const data = await getData();
const result = await processData(data);
await saveResult(result);
```

### 错误处理

#### 错误捕获

```typescript
// 全局错误处理
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // 记录日志并优雅退出
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
```

#### 错误分类

```typescript
class PluginError extends Error {
  constructor(
    public type: string,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = 'PluginError';
  }
}

// 使用自定义错误
throw new PluginError('INVALID_INPUT', '参数无效', { param: value });
```

### 日志规范

#### 日志级别

```typescript
// DEBUG: 详细调试信息
console.debug('[Plugin] Processing message:', msgId);

// INFO: 一般信息
console.info('[Plugin] Plugin loaded successfully');

// WARN: 警告信息
console.warn('[Plugin] API rate limit approaching');

// ERROR: 错误信息
console.error('[Plugin] Failed to process:', error);
```

#### 日志格式

```typescript
// 统一格式：[时间] [级别] [模块] 消息
const log = (level: string, module: string, message: string) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] [${module}] ${message}`);
};
```

### 注释规范

#### 文件头注释

```typescript
/**
 * @file 插件名称
 * @description 插件功能描述
 * @author 作者
 * @version 1.0.0
 * @date 2024-01-01
 */
```

#### 函数注释

```typescript
/**
 * 发送消息到指定对话
 * @param peer - 目标对话ID或实体
 * @param text - 消息文本
 * @param options - 可选参数
 * @returns 发送的消息对象
 * @throws {Error} 当发送失败时抛出错误
 */
async function sendMessage(
  peer: any,
  text: string,
  options?: SendOptions
): Promise<Api.Message> {
  // 实现代码
}
```

#### 行内注释

```typescript
// 检查用户权限
if (!await checkPermission(userId)) {
  return; // 无权限则退出
}

// TODO: 添加缓存机制提高性能
// FIXME: 修复特殊字符处理问题
// NOTE: 这里使用了新的API
```

### 内存安全编码规范

1. **必须实现 cleanup()**：
   - 所有插件必须实现 `cleanup()` 方法
   - 必须清理所有外部资源
   - 必须移除所有事件监听器
   - 必须清除所有定时器

2. **资源跟踪**：
   - 使用数组或Map跟踪创建的资源
   - 为每个资源分配唯一ID
   - 在 cleanup() 中遍历清理

3. **错误处理**：
   - cleanup() 方法必须包含 try-catch
   - 即使部分清理失败，也要继续清理其他资源
   - 记录清理错误，但不抛出异常

```typescript
async cleanup(): Promise<void> {
  try {
    // 清理资源1
  } catch (error) {
    console.error(`[Plugin] Error cleaning resource1:`, error);
  }
  
  try {
    // 清理资源2
  } catch (error) {
    console.error(`[Plugin] Error cleaning resource2:`, error);
  }
}
```

4. **避免全局状态**：

```typescript
// ❌ 避免
const globalCache = new Map();

// ✅ 推荐
class Plugin {
  private cache = new Map();
  cleanup() {
    this.cache.clear();
  }
}
```

5. **限制缓存大小**：

```typescript
class CachePlugin extends Plugin {
  private cache = new Map<string, any>();
  private MAX_CACHE_SIZE = 100;
  
  addToCache(key: string, value: any) {
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      // 移除最旧的项
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, value);
  }
  
  async cleanup() {
    this.cache.clear();
  }
}
```

### 性能与并发

#### 性能优化

```typescript
// 批量操作
async function batchProcess(items: any[]) {
  const batchSize = 10;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(item => processItem(item)));
  }
}

// 内存监控
function monitorMemory() {
  const usage = process.memoryUsage();
  console.log(`
    Heap Used: ${(usage.heapUsed / 1024 / 1024).toFixed(2)} MB
    Heap Total: ${(usage.heapTotal / 1024 / 1024).toFixed(2)} MB
  `);
  
  // 触发垃圾回收（需要 --expose-gc 标志）
  if (global.gc && usage.heapUsed > 100 * 1024 * 1024) {
    global.gc();
  }
}
```

#### 并发处理

1. **并发控制**

```typescript
class ConcurrencyManager {
  private running = 0;
  private queue: (() => Promise<any>)[] = [];
  
  constructor(private maxConcurrent: number = 5) {}
  
  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= this.maxConcurrent) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.processQueue();
    }
  }
  
  private processQueue() {
    if (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const fn = this.queue.shift();
      if (fn) this.run(fn);
    }
  }
}
```

2. **任务队列**

```typescript
class TaskQueue {
  private tasks: Array<() => Promise<any>> = [];
  private processing = false;
  
  add(task: () => Promise<any>) {
    this.tasks.push(task);
    this.process();
  }
  
  private async process() {
    if (this.processing) return;
    this.processing = true;
    
    while (this.tasks.length > 0) {
      const task = this.tasks.shift();
      if (task) {
        try {
          await task();
        } catch (error) {
          console.error('Task failed:', error);
        }
      }
    }
    
    this.processing = false;
  }
}
```

### 缓存策略

1. **LRU缓存**

```typescript
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  
  constructor(private maxSize: number) {}
  
  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // 移到最后（最近使用）
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }
  
  set(key: K, value: V) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // 删除最旧的（第一个）
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
}
```

2. **分层缓存**

```typescript
class TieredCache {
  private l1Cache = new Map(); // 内存缓存
  private l2Cache: Database;   // 数据库缓存
  
  async get(key: string): Promise<any> {
    // 先查L1
    let value = this.l1Cache.get(key);
    if (value) return value;
    
    // 再查L2
    value = await this.l2Cache.get(key);
    if (value) {
      this.l1Cache.set(key, value); // 提升到L1
    }
    return value;
  }
  
  async set(key: string, value: any) {
    this.l1Cache.set(key, value);
    await this.l2Cache.set(key, value);
  }
}
```

## ⚙️ 环境配置

### 必需配置文件

#### config.json - Telegram API配置

**作用**：存储Telegram API凭证和会话信息

```json
{
  "api_id": 17759529,
  "api_hash": "cf832d11ca514db19e4b85a96eb707b2",
  "session": "session_string_here",
  "proxy": {                // 可选：代理配置
    "ip": "127.0.0.1",
    "port": 7877,
    "socksType": 5
  }
}
```

**字段说明**：
- `api_id` - Telegram API ID，从 https://my.telegram.org 获取
- `api_hash` - Telegram API Hash
- `session` - 会话字符串，首次登录后自动生成

#### .env - 环境变量配置

**作用**：配置TeleBox运行参数

```bash
# 命令前缀（空格分隔多个前缀）
TB_PREFIX=". 。"

# Sudo命令前缀（可选）
TB_SUDO_PREFIX="# $"

# 全局设置命令是否忽略编辑的消息
TB_CMD_IGNORE_EDITED=false

# 设置哪些插件的监听不忽略编辑的消息（空格分隔）
TB_LISTENER_HANDLE_EDITED="sudo sure"
```

#### package.json - 项目配置

**作用**：定义项目依赖和脚本命令

```json
{
  "name": "telebox",
  "version": "0.2.6",
  "scripts": {
    "start": "tsx -r tsconfig-paths/register ./src/index.ts",
    "tpm": "tsx -r tsconfig-paths/register ./src/plugin/tpm.ts",
    "dev": "NODE_ENV=development tsx -r tsconfig-paths/register ./src/index.ts"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/TeleBoxDev/TeleBox.git"
  },
  "license": "LGPL-2.1-only",
  "dependencies": {
    "telegram": "^2.26.22",
    "dotenv": "^17.2.2",
    "cron": "^4.3.3",
    "axios": "^1.11.0",
    "sharp": "^0.34.3",
    "lowdb": "^7.0.1",
    "lodash": "^4.17.21",
    "dayjs": "^1.11.18",
    "cheerio": "^1.1.2",
    "better-sqlite3": "^12.2.0",
    "opencc-js": "^1.0.5",
    "modern-gif": "^2.0.4",
    "archiver": "^7.0.1",
    "ssh2": "^1.15.0",
    "@vitalets/google-translate-api": "^9.2.1"
    // 完整依赖列表见package.json
  }
}
```

### 进程管理配置

#### ecosystem.config.js - PM2配置

**作用**：使用PM2进行进程管理和自动重启

```javascript
module.exports = {
  apps: [
    {
      name: "telebox",
      script: "npm",
      args: "start",
      cwd: __dirname,
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      merge_logs: true,
      time: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 4000,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
}
```

**配置说明**：
- `name` - 进程名称
- `script` - 启动脚本（使用npm start）
- `error_file` / `out_file` - 日志文件路径
- `autorestart` - 自动重启
- `max_restarts` - 最大重启次数
- `restart_delay` - 重启延迟时间

### 环境变量详解

#### 命令前缀配置

```bash
# 生产环境命令前缀
TB_PREFIX=". 。"

# Sudo命令前缀（管理员专用）
TB_SUDO_PREFIX="# $"
```

**说明**：
- 支持多个前缀，用空格分隔
- 常用前缀：`.` `。` `$` `!` `#`
- Sudo前缀用于需要管理员权限的命令

#### 插件行为配置

```bash
# 全局设置命令是否忽略编辑的消息
TB_CMD_IGNORE_EDITED=false

# 设置哪些插件的监听不忽略编辑的消息
TB_LISTENER_HANDLE_EDITED="sudo sure"
```

**说明**：
- `TB_CMD_IGNORE_EDITED` - 控制命令处理器是否响应编辑后的消息
- `TB_LISTENER_HANDLE_EDITED` - 指定哪些插件的监听器处理编辑消息
- 用空格分隔多个插件名

#### 开发模式配置

```bash
# 使用开发模式启动
NODE_ENV=development
```

**启动方式**：

```bash
# 生产模式
npm start

# 开发模式
npm run dev
```

### 配置文件示例

#### .env 完整示例

```bash
# 命令前缀配置
TB_PREFIX=". 。"
TB_SUDO_PREFIX="# $"

# 插件行为配置
TB_CMD_IGNORE_EDITED=false
TB_LISTENER_HANDLE_EDITED="sudo sure"

# 开发模式（可选）
# NODE_ENV=development
```

#### config.json 示例

```json
{
  "api_id": 12345678,
  "api_hash": "your_api_hash_here",
  "session": "your_session_string_here"
}
```

**获取API凭证**：
1. 访问 https://my.telegram.org
2. 登录Telegram账号
3. 进入 "API development tools"
4. 创建应用获取 api_id 和 api_hash

## 📦 核心工具模块

TeleBox提供了17个核心工具模块，位于 `src/utils/` 目录。

### 插件管理器

**pluginManager.ts** - 插件系统的核心管理器

```typescript
import { 
  getPrefixes,      // 获取命令前缀列表
  setPrefixes,      // 设置命令前缀
  loadPlugins,      // 加载所有插件
  listCommands,     // 列出所有命令
  getPluginEntry,   // 获取插件入口
  getCommandFromMessage,           // 从消息中提取命令
  dealCommandPluginWithMessage     // 处理命令消息
} from "@utils/pluginManager";
```

**主要功能**：
- 动态加载用户插件和系统插件
- 命令路由和分发
- 命令别名处理
- 前缀管理

### 全局客户端

**globalClient.ts** - 全局Telegram客户端实例

```typescript
import { getGlobalClient } from "@utils/globalClient";

const client = await getGlobalClient();
// 使用client进行API调用
await client.sendMessage(peer, { message: "Hello" });
```

**作用**：维护全局唯一的Telegram客户端实例，避免重复连接。

### 数据库工具

#### aliasDB.ts - 命令别名数据库

```typescript
import { AliasDB } from "@utils/aliasDB";

const aliasDB = new AliasDB();
aliasDB.set("h", "help");        // 设置别名
aliasDB.getOriginal("h");        // 获取原命令
```

#### sudoDB.ts - 管理员权限数据库

```typescript
import { SudoDB } from "@utils/sudoDB";

const sudoDB = new SudoDB();
sudoDB.add(userId);              // 添加管理员
sudoDB.has(userId);              // 检查权限
```

#### sureDB.ts - 确认操作数据库

```typescript
import { SureDB } from "@utils/sureDB";

const sureDB = new SureDB();
sureDB.set(userId, action);      // 设置待确认操作
```

#### sendLogDB.ts - 发送日志数据库

```typescript
import { SendLogDB } from "@utils/sendLogDB";

const sendLogDB = new SendLogDB();
sendLogDB.add(messageId, data); // 记录发送日志
```

### 实体处理工具

**entityHelpers.ts** - Telegram实体处理

```typescript
import { 
  getEntityWithHash,    // 获取实体及其哈希
  parseEntityId,        // 解析实体ID
  safeForwardMessage    // 安全转发消息
} from "@utils/entityHelpers";
```

**tlRevive.ts** - 实体序列化工具

```typescript
import { reviveEntities } from "@utils/tlRevive";

// 将实体序列化后反序列化回来
const entities = await reviveEntities(serializedData);
```

### 路径管理

**pathHelpers.ts** - 路径辅助工具

```typescript
import { 
  createDirectoryInAssets,  // 在assets目录创建子目录
  createDirectoryInTemp     // 在temp目录创建子目录
} from "@utils/pathHelpers";

const dataDir = createDirectoryInAssets("myplugin");
// 返回: /path/to/telebox/assets/myplugin
```

### 群组管理

**banUtils.ts** - 封禁管理工具

```typescript
import { 
  banUser,          // 封禁用户
  unbanUser,        // 解封用户
  kickUser,         // 踢出用户
  getBannedUsers,   // 获取封禁列表
  batchUnbanUsers   // 批量解封
} from "@utils/banUtils";

await banUser(client, chatId, userId);
```

### 系统功能

**cronManager.ts** - 定时任务管理器

```typescript
import { cronManager } from "@utils/cronManager";

cronManager.addTask("backup", {
  cron: "0 0 * * *",
  description: "每日备份",
  handler: async (client) => {
    // 执行任务
  }
});
```

**conversation.ts** - 对话管理器

```typescript
import { conversation } from "@utils/conversation";

// 等待用户回复
const response = await conversation.waitForMessage(userId, chatId);
```

**apiConfig.ts** - API配置管理

```typescript
import { apiConfig } from "@utils/apiConfig";

const config = apiConfig.get(); // 获取config.json内容
```

**loginManager.ts** - 登录管理器

```typescript
import { login } from "@utils/loginManager";

await login(); // 登录Telegram
```

**npm_install.ts** - NPM包安装工具

```typescript
import { npmInstall } from "@utils/npm_install";

await npmInstall("package-name"); // 安装NPM包
```

**teleboxInfoHelper.ts** - 系统信息助手

```typescript
import { getTeleboxInfo } from "@utils/teleboxInfoHelper";

const info = getTeleboxInfo(); // 获取TeleBox系统信息
```

## 🔍 核心API签名

### 消息限制

**Telegram消息最大 4096 字符**：
- 超过限制会抛出 `MESSAGE_TOO_LONG` 错误
- HTML 标签也计入字符数
- 需要分割长消息或使用文件发送

```typescript
const MAX_MESSAGE_LENGTH = 4096;

// 消息分割
function splitMessage(text: string, maxLength = 4096): string[] {
  if (text.length <= maxLength) return [text];
  
  const parts: string[] = [];
  let current = "";
  
  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > maxLength) {
      parts.push(current);
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) parts.push(current);
  return parts;
}
```

### Message API

```typescript
// 消息操作
await msg.edit({ text: "...", parseMode: "html" });
await msg.reply({ message: "..." });
await msg.delete({ revoke: true });

// 获取回复消息
const replyMsg = await msg.getReplyMessage();
```

### Client API

```typescript
import { getGlobalClient } from "@utils/globalClient";

const client = await getGlobalClient();

// 发送消息
await client.sendMessage(peer, { message: "...", parseMode: "html" });

// 获取实体
const entity = await client.getEntity(peer);

// 发送文件
await client.sendFile(peer, { file: "path/to/file" });
```

### Database API

**⚠️ 重要：TeleBox只使用 lowdb 作为数据库**

```typescript
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as path from "path";

// 初始化数据库
const dbPath = path.join(createDirectoryInAssets("plugin_name"), "data.json");
const db = await JSONFilePreset(dbPath, { users: [], config: {} });

// 读取数据
const users = db.data.users;

// 修改数据
db.data.users.push({ id: "123", name: "Alice" });
await db.write();
```

## 📝 插件开发框架

### 常用工具函数

```typescript
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "telegram";

// HTML转义（必需）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 获取前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 参数解析
const parseArgs = (msg: Api.Message) => {
  const text = msg.text || "";
  const parts = text.trim().split(/\s+/);
  return parts.slice(1); // 跳过命令本身
};

// 提取剩余文本
const getRemark = (msg: Api.Message, skipWords: number = 1): string => {
  const text = msg.text || "";
  const parts = text.trim().split(/\s+/);
  return parts.slice(skipWords).join(" ");
};

// 错误处理
const handleError = async (msg: Api.Message, error: any) => {
  const errorMsg = error.message || "未知错误";
  await msg.edit({
    text: `❌ <b>错误:</b> ${htmlEscape(errorMsg)}`,
    parseMode: "html"
  });
};

// 自动删除消息
const autoDelete = (msg: Api.Message, seconds: number = 5) => {
  setTimeout(() => msg.delete({ revoke: true }).catch(() => {}), seconds * 1000);
};
```

### 开发指南

#### 快速开始

##### 1. 创建插件

```typescript
// plugins/myplugin.ts
import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "telegram";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

class MyPlugin extends Plugin {
  description = `我的插件说明\n\n使用 ${mainPrefix}mycommand 触发`;
  
  cmdHandlers = {
    mycommand: async (msg: Api.Message) => {
      const text = `<b>Hello from MyPlugin!</b>`;
      await msg.edit({ text, parseMode: "html" });
    }
  };
}

export default new MyPlugin();
```

##### 2. 重载插件

```bash
.reload          # 重载所有插件
.reload myplugin # 重载指定插件
```

#### 核心API

##### Telegram操作

```typescript
import { getGlobalClient } from "@utils/globalClient";
import { Api } from "telegram";

const client = await getGlobalClient();

// 发送消息
await client.sendMessage(chatId, { 
  message: "Hello",
  parseMode: "html" 
});

// 编辑消息
await msg.edit({ 
  text: "<b>Updated</b>", 
  parseMode: "html" 
});

// 删除消息
await msg.delete({ revoke: true });

// 获取实体
const entity = await client.getEntity(peer);
```

##### 数据库操作 (lowdb)

```typescript
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as path from "path";

const dbPath = path.join(createDirectoryInAssets("myplugin"), "data.json");
const db = await JSONFilePreset(dbPath, { users: [] });

// 插入数据
db.data.users.push({ id: "123", name: "Alice" });
await db.write();

// 查询数据
const user = db.data.users.find(u => u.id === "123");

// 更新数据
const userIndex = db.data.users.findIndex(u => u.id === "123");
if (userIndex !== -1) {
  db.data.users[userIndex].name = "Bob";
  await db.write();
}

// 删除数据
db.data.users = db.data.users.filter(u => u.id !== "123");
await db.write();
```

##### 文件操作

```typescript
import { createDirectoryInAssets, createDirectoryInTemp } from "@utils/pathHelpers";
import * as fs from "fs";
import * as path from "path";

// 创建插件目录
const assetsDir = createDirectoryInAssets("myplugin");
const tempDir = createDirectoryInTemp("myplugin");

// 读写JSON配置
const configPath = path.join(assetsDir, "config.json");
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
```

### 📚 快速参考

#### 常用导入

```typescript
// 核心导入
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";

// 路径管理
import { createDirectoryInAssets, createDirectoryInTemp } from "@utils/pathHelpers";

// 数据库
import { JSONFilePreset } from "lowdb/node";

// 工具库
import * as path from "path";
import * as fs from "fs";
import _ from "lodash";
import dayjs from "dayjs";
```

#### 快速命令模板

```typescript
// 单命令插件
class QuickPlugin extends Plugin {
  description = "快速插件";
  cmdHandlers = {
    cmd: async (msg: Api.Message) => {
      await msg.edit({ text: "处理完成", parseMode: "html" });
    }
  };
}

export default new QuickPlugin();
```

#### 常用代码片段

```typescript
// 获取客户端
import { getGlobalClient } from "@utils/globalClient";
const client = await getGlobalClient();
if (!client) return;

// 参数解析
const args = msg.text?.trim().split(/\s+/).slice(1) || [];
const subCommand = args[0] || "";

// 错误处理
try {
  // 业务逻辑
} catch (error) {
  await msg.edit({ 
    text: `❌ 错误: ${error.message}`,
    parseMode: "html" 
  });
}

// lowdb配置管理
import { JSONFilePreset } from "lowdb/node";
const db = await JSONFilePreset(configPath, { key: "value" });
await db.update((data) => { data.key = newValue; });
const value = db.data.key;
```

### 🎨 插件开发模板

#### 🎨 标准插件开发模板

```typescript
// ========== 插件基础框架 ==========

import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";

class StandardPlugin extends Plugin {
  // 插件配置
  private readonly PLUGIN_NAME = "myplugin";
  private readonly PLUGIN_VERSION = "1.0.0";
  
  // 生成帮助文档
  private readonly HELP = HelpBuilder.build({
    title: "我的插件",
    icon: "📦",
    commands: [
      { command: "mp start", description: "开始任务" },
      { command: "mp stop", description: "停止任务" },
      { command: "mp status", description: "查看状态" },
      { command: "mp help", description: "显示帮助" }
    ]
  });
  
  // 插件描述
  description = this.HELP;
  
  // 命令处理器
  cmdHandlers = {
    mp: this.handleCommand.bind(this)
  };
  
  // 主命令处理
  private async handleCommand(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) return;
    
    // 使用标准参数解析
    const { subCommand, args } = parseCommand(msg);
    
    try {
      // 子命令路由
      switch (subCommand) {
        case "start":
          await this.handleStart(msg);
          break;
        case "stop":
          await this.handleStop(msg);
          break;
        case "status":
          await this.handleStatus(msg);
          break;
        default:
          await this.handleDefault(msg, subCommand);
      }
    } catch (error: any) {
      await sendError(msg, error, this.PLUGIN_NAME);
    }
  }
  
  // 默认处理
  private async handleDefault(msg: Api.Message, sub: string | undefined) {
    if (!sub || sub === "help" || sub === "h") {
      // 无参数时的默认行为
      await msg.edit({ text: this.HELP, parseMode: "html" });
    } else {
      // 未知命令
      const prefix = getPrefixInfo().display;
      await msg.edit({
        text: `❌ 未知命令: <code>${htmlEscape(sub)}</code>\n\n💡 使用 <code>${prefix}mp help</code> 查看帮助`,
        parseMode: "html"
      });
    }
  }
  
  // 具体功能实现（用户自定义）
  private async handleStart(msg: Api.Message) {
    await msg.edit({ text: "✅ 已启动", parseMode: "html" });
  }
  
  private async handleStop(msg: Api.Message) {
    await msg.edit({ text: "⏹️ 已停止", parseMode: "html" });
  }
  
  private async handleStatus(msg: Api.Message) {
    await msg.edit({ text: "📊 运行中", parseMode: "html" });
  }
}

export default new StandardPlugin();
```

#### 📦 配置管理框架

```typescript
// ========== 统一配置管理 ==========

import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as path from "path";

class PluginConfig<T = any> {
  private db: any = null;
  private pluginName: string;
  private defaultConfig: T;
  
  constructor(pluginName: string, defaultConfig: T) {
    this.pluginName = pluginName;
    this.defaultConfig = defaultConfig;
  }
  
  async init(): Promise<void> {
    if (this.db) return;
    
    const dbPath = path.join(
      createDirectoryInAssets(this.pluginName),
      `${this.pluginName}_config.json`
    );
    
    this.db = await JSONFilePreset<T>(dbPath, this.defaultConfig);
  }
  
  async get<K extends keyof T>(key?: K): Promise<K extends keyof T ? T[K] : T> {
    await this.init();
    return key ? this.db.data[key] : this.db.data;
  }
  
  async set<K extends keyof T>(key: K, value: T[K]): Promise<void> {
    await this.init();
    this.db.data[key] = value;
    await this.db.write();
  }
  
  async update(updates: Partial<T>): Promise<void> {
    await this.init();
    Object.assign(this.db.data, updates);
    await this.db.write();
  }
  
  async reset(): Promise<void> {
    await this.init();
    this.db.data = { ...this.defaultConfig };
    await this.db.write();
  }
}

// 使用示例
interface MyPluginConfig {
  enabled: boolean;
  apiKey: string;
  maxRetries: number;
  timeout: number;
}

const config = new PluginConfig<MyPluginConfig>("myplugin", {
  enabled: true,
  apiKey: "",
  maxRetries: 3,
  timeout: 30000
});

// 获取配置
const isEnabled = await config.get("enabled");
const allConfig = await config.get();

// 设置配置
await config.set("apiKey", "your-api-key");
await config.update({ enabled: false, maxRetries: 5 });
```

#### 🔄 消息处理模式

```typescript
// ========== 渐进式状态反馈 ==========

class ProgressManager {
  private msg: Api.Message;
  private startTime: number;
  
  constructor(msg: Api.Message) {
    this.msg = msg;
    this.startTime = Date.now();
  }
  
  async update(text: string, emoji: string = "🔄"): Promise<void> {
    const elapsed = formatDuration(Date.now() - this.startTime);
    await this.msg.edit({
      text: `${emoji} ${text}\n⏱️ 已用时: ${elapsed}`,
      parseMode: "html"
    });
  }
  
  async success(text: string): Promise<void> {
    const elapsed = formatDuration(Date.now() - this.startTime);
    await this.msg.edit({
      text: `✅ ${text}\n⏱️ 总用时: ${elapsed}`,
      parseMode: "html"
    });
  }
  
  async error(error: any): Promise<void> {
    await sendError(this.msg, error);
  }
}

// 使用示例
const progress = new ProgressManager(msg);
await progress.update("正在初始化...");
await progress.update("正在处理数据...", "📊");
await progress.success("处理完成！");
```

#### 🛡️ 错误处理框架

```typescript
// ========== 统一错误处理 ==========

enum ErrorType {
  PERMISSION = "权限不足",
  INVALID_INPUT = "输入无效",
  API_ERROR = "API错误",
  NETWORK = "网络错误",
  TIMEOUT = "超时",
  NOT_FOUND = "未找到",
  RATE_LIMIT = "请求过于频繁"
}

class PluginError extends Error {
  type: ErrorType;
  details?: any;
  
  constructor(type: ErrorType, message: string, details?: any) {
    super(message);
    this.type = type;
    this.details = details;
  }
}

// 错误处理器
class ErrorHandler {
  static async handle(msg: Api.Message, error: any): Promise<void> {
    console.error(`[Plugin Error]:`, error);
    
    let errorMsg: string;
    
    if (error instanceof PluginError) {
      errorMsg = `❌ <b>${error.type}:</b> ${htmlEscape(error.message)}`;
    } else if (error.message?.includes("FLOOD_WAIT")) {
      const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
      errorMsg = `⏳ <b>请求过于频繁</b>\n\n需要等待 ${waitTime} 秒后重试`;
    } else if (error.message?.includes("MESSAGE_TOO_LONG")) {
      errorMsg = `❌ <b>消息过长</b>\n\n请减少内容长度或分段发送`;
    } else {
      errorMsg = `❌ <b>操作失败:</b> ${htmlEscape(error.message || "未知错误")}`;
    }
    
    await msg.edit({ text: errorMsg, parseMode: "html" });
  }
}

// 使用示例
try {
  if (!userId) {
    throw new PluginError(ErrorType.INVALID_INPUT, "用户ID不能为空");
  }
  // ... 其他逻辑
} catch (error) {
  await ErrorHandler.handle(msg, error);
}
```

#### 📝 Telegram 消息格式规范

```typescript
// ========== HTML 格式处理 ==========

class MessageFormatter {
  // 发送文件时的标准格式
  static async sendFile(client: TelegramClient, peer: any, file: any, caption?: string) {
    return await client.sendFile(peer, {
      file,
      caption,
      parseMode: 'html'  // 必需！确保HTML格式正确解析
    });
  }
  
  // 构建安全的HTML消息
  static buildHtml(parts: { text: string, escape?: boolean }[]): string {
    return parts.map(part => 
      part.escape !== false ? htmlEscape(part.text) : part.text
    ).join('');
  }
  
  // 格式化链接
  static link(url: string, text: string): string {
    return `<a href="${htmlEscape(url)}">${htmlEscape(text)}</a>`;
  }
  
  // 格式化代码
  static code(text: string): string {
    return `<code>${htmlEscape(text)}</code>`;
  }
  
  // 格式化粗体
  static bold(text: string): string {
    return `<b>${htmlEscape(text)}</b>`;
  }
}

// 使用示例
const caption = MessageFormatter.buildHtml([
  { text: '🎨 ', escape: false },
  { text: title },
  { text: '\n\n🔗 原图: ', escape: false },
  { text: MessageFormatter.link(url, '查看'), escape: false }
]);
```

## 🚀 完整插件示例

### 简单命令插件

```typescript
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";

class SimplePlugin extends Plugin {
  description = "📌 简单示例插件";
  
  cmdHandlers = {
    ping: async (msg: Api.Message) => {
      const start = Date.now();
      await msg.edit({ text: "Pong! 🏓" });
      const latency = Date.now() - start;
      await msg.edit({ 
        text: `Pong! 🏓\n响应时间: ${latency}ms`,
        parseMode: "html"
      });
    },
    echo: async (msg: Api.Message) => {
      const text = msg.text?.replace(/^[.!。]echo\s*/i, "") || "无内容";
      await msg.edit({
        text: `🗣️ <b>回声:</b>\n<code>${text}</code>`,
        parseMode: "html"
      });
    }
  };
}

export default new SimplePlugin();
```

### 数据库插件

```typescript
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as path from "path";

class DataPlugin extends Plugin {
  description = "💾 数据存储插件示例";
  private db: any;
  
  constructor() {
    super();
    this.initDB();
  }
  
  private async initDB() {
    const dbPath = path.join(createDirectoryInAssets("dataplugin"), "data.json");
    this.db = await JSONFilePreset(dbPath, { records: [] });
  }
  
  cmdHandlers = {
    save: async (msg: Api.Message) => {
      const content = msg.text?.replace(/^[.!。]save\s*/i, "");
      if (!content) {
        await msg.edit({ text: "❌ 请提供要保存的内容" });
        return;
      }
      
      if (!this.db) await this.initDB();
      
      this.db.data.records.push({
        id: Date.now(),
        user_id: msg.senderId?.toString() || "unknown",
        content,
        created_at: Date.now()
      });
      await this.db.write();
      
      await msg.edit({ text: "✅ 已保存" });
    },
    
    list: async (msg: Api.Message) => {
      if (!this.db) await this.initDB();
      
      const userId = msg.senderId?.toString() || "unknown";
      const records = this.db.data.records
        .filter((r: any) => r.user_id === userId)
        .sort((a: any, b: any) => b.created_at - a.created_at)
        .slice(0, 10);
      
      if (records.length === 0) {
        await msg.edit({ text: "📄 没有记录" });
        return;
      }
      
      let text = "📋 <b>最近记录:</b>\n\n";
      records.forEach((r: any, i: number) => {
        const date = new Date(r.created_at).toLocaleString('zh-CN');
        text += `${i + 1}. <code>${r.content}</code>\n   <i>${date}</i>\n\n`;
      });
      
      await msg.edit({ text, parseMode: "html" });
    }
  };
}

export default new DataPlugin();
```

### 监听器插件

```typescript
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";

class MonitorPlugin extends Plugin {
  description = "👁️ 消息监控插件";
  private stats: any;
  private configPath: string;
  
  constructor() {
    super();
    this.configPath = path.join(createDirectoryInAssets("monitor"), "stats.json");
    this.initStats();
  }
  
  private async initStats() {
    this.stats = await JSONFilePreset(this.configPath, {
      totalMessages: 0,
      users: {},
      keywords: {}
    });
  }
  
  // 监听所有消息
  listenMessageHandler = async (msg: Api.Message) => {
    const userId = msg.senderId?.toString();
    if (!userId) return;
    
    // 更新统计
    this.stats.data.totalMessages++;
    this.stats.data.users[userId] = (this.stats.data.users[userId] || 0) + 1;
    
    // 关键词检测
    const text = msg.text?.toLowerCase() || "";
    if (text.includes("help")) {
      this.stats.data.keywords.help = (this.stats.data.keywords.help || 0) + 1;
    }
    
    await this.stats.write();
  };
  
  listenMessageHandlerIgnoreEdited = true;
  
  cmdHandlers = {
    stats: async (msg: Api.Message) => {
      const data = this.stats.data;
      const userCount = Object.keys(data.users).length;
      
      await msg.edit({
        text: `📊 <b>统计信息:</b>\n\n` +
              `📨 总消息数: <code>${data.totalMessages}</code>\n` +
              `👥 活跃用户: <code>${userCount}</code>\n` +
              `🔍 Help请求: <code>${data.keywords.help || 0}</code>`,
        parseMode: "html"
      });
    }
  };
}

export default new MonitorPlugin();
```

### 定时任务插件

```typescript
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { cronManager } from "@utils/cronManager";

class SchedulePlugin extends Plugin {
  description = "⏰ 定时任务插件";
  private reminders: Map<string, any> = new Map();
  
  // 定时任务定义
  cronTasks = {
    dailyReport: {
      cron: "0 9 * * *", // 每天早上9点
      description: "每日报告",
      handler: async (client: any) => {
        const cmdIgnoreEdited = !!JSON.parse(
          process.env.TB_CMD_IGNORE_EDITED || "true"  // 默认为true，忽略编辑消息
        );
        const chatId = process.env.TB_REPORT_CHAT || "me";
        await client.sendMessage(chatId, {
          message: "📅 每日报告\n\n今天是新的一天，加油！"
        });
      }
    }
  };
  
  cmdHandlers = {
    remind: async (msg: Api.Message) => {
      const parts = msg.text?.split(/\s+/) || [];
      if (parts.length < 3) {
        await msg.edit({
          text: "❌ 用法: <code>.remind [分钟] [提醒内容]</code>",
          parseMode: "html"
        });
        return;
      }
      
      const minutes = parseInt(parts[1]);
      const reminder = parts.slice(2).join(" ");
      
      if (isNaN(minutes) || minutes <= 0) {
        await msg.edit({ text: "❌ 请输入有效的分钟数" });
        return;
      }
      
      const reminderId = Date.now().toString();
      const timeout = setTimeout(async () => {
        const client = await getGlobalClient();
        await client.sendMessage(msg.peerId, {
          message: `⏰ <b>提醒:</b> ${reminder}`,
          parseMode: "html",
          replyTo: msg.id
        });
        this.reminders.delete(reminderId);
      }, minutes * 60 * 1000);
      
      this.reminders.set(reminderId, timeout);
      
      await msg.edit({
        text: `✅ 已设置提醒，将在 ${minutes} 分钟后提醒您`,
        parseMode: "html"
      });
    },
    
    reminders: async (msg: Api.Message) => {
      if (this.reminders.size === 0) {
        await msg.edit({ text: "📝 没有活动的提醒" });
        return;
      }
      
      await msg.edit({
        text: `📝 活动提醒数量: ${this.reminders.size}`,
        parseMode: "html"
      });
    }
  };
}

export default new SchedulePlugin();
```

### 带资源清理的插件

```typescript
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { EventManager } from "@utils/eventManager";
import { cronManager } from "@utils/cronManager";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import path from "path";

class MemorySafePlugin extends Plugin {
  name = "memory_safe";
  private eventHandlerIds: string[] = [];
  private timers: NodeJS.Timeout[] = [];
  private db: any = null;
  
  description = `✅ <b>内存安全插件示例</b>
  
📝 <b>特性:</b>
• 完整的生命周期管理
• 资源清理示例
• 内存泄漏预防

🔧 <b>命令:</b>
• <code>.safe</code> - 测试插件功能
• <code>.memtest</code> - 内存测试`;

  cmdHandlers = {
    safe: async (msg: Api.Message) => {
      await msg.edit({
        text: "✅ <b>内存安全插件</b>\n\n所有资源都已正确管理，不会造成内存泄漏。",
        parseMode: "html"
      });
    },
    
    memtest: async (msg: Api.Message) => {
      const before = MemoryMonitor.snapshot();
      
      // 模拟资源使用
      for (let i = 0; i < 1000; i++) {
        this.timers.push(setTimeout(() => {}, 10000));
      }
      
      const after = MemoryMonitor.snapshot();
      const diff = MemoryMonitor.diff(before, after);
      
      await msg.edit({
        text: `📊 <b>内存测试结果</b>\n\n` +
              `_HEAP USED: ${(diff.heapUsed / 1024 / 1024).toFixed(2)}MB_\n` +
              `⚠️ 注意：这些资源将在插件清理时自动释放`,
        parseMode: "html"
      });
    }
  };
  
  async onLoad(): Promise<void> {
    console.log(`[${this.name}] Loading plugin...`);
    
    // 初始化数据库
    const dbPath = path.join(createDirectoryInAssets(this.name), 'data.json');
    this.db = await JSONFilePreset(dbPath, {  [] });
    
    // 注册事件监听器
    const client = await getGlobalClient();
    const messageHandler = async (event: NewMessageEvent) => {
      if (event.message.text?.includes('safe_test')) {
        await event.message.reply('✅ Memory safe test passed!');
      }
    };
    
    const handlerId = EventManager.register(
      this.name, 
      messageHandler, 
      new NewMessage(),
      {
        cleanup: async () => {
          console.log(`[${this.name}] Cleaning up event handler`);
        }
      }
    );
    
    this.eventHandlerIds.push(handlerId);
    
    // 注册定时任务
    cronManager.set(`${this.name}_cleanup`, '0 */6 * * *', async () => {
      console.log(`[${this.name}] Running periodic cleanup`);
      await this.periodicCleanup();
    }, {
      pluginName: this.name,
      description: 'Periodic resource cleanup'
    });
  }
  
  private async periodicCleanup(): Promise<void> {
    // 清理过期的临时数据
    if (this.db) {
      const now = Date.now();
      this.db.data.data = this.db.data.data.filter(
        (item: any) => now - item.timestamp < 24 * 60 * 60 * 1000
      );
      await this.db.write();
    }
  }
  
  async cleanup(): Promise<void> {
    console.log(`[${this.name}] Starting cleanup process...`);
    const startTime = Date.now();
    
    try {
      // 1. 清理事件监听器
      let removedHandlers = 0;
      for (const handlerId of this.eventHandlerIds) {
        // EventManager 会处理实际的移除
        removedHandlers++;
      }
      this.eventHandlerIds = [];
      
      // 2. 清理定时器
      let clearedTimers = 0;
      for (const timer of this.timers) {
        clearTimeout(timer);
        clearedTimers++;
      }
      this.timers = [];
      
      // 3. 清理 cron 任务
      const removedCrons = cronManager.delByPlugin(this.name);
      
      // 4. 关闭数据库
      if (this.db) {
        await this.db.write();
        this.db = null;
      }
      
      // 5. 触发垃圾回收（如果可用）
      await MemoryMonitor.triggerGC();
      
      const duration = Date.now() - startTime;
      console.log(`[${this.name}] Cleanup completed in ${duration}ms`);
      console.log(`[${this.name}] Resources cleaned up:`, {
        eventHandlers: removedHandlers,
        timers: clearedTimers,
        cronTasks: removedCrons,
        database: 'closed'
      });
      
    } catch (error) {
      console.error(`[${this.name}] Error during cleanup:`, error);
    }
  }
}

export default new MemorySafePlugin();
```

### 定时任务插件示例

```typescript
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { cronManager } from "@utils/cronManager";

class ScheduledTasksPlugin extends Plugin {
  name = "scheduled_tasks";
  private activeTimers = new Map<string, NodeJS.Timeout>();
  
  description = `⏰ <b>定时任务插件</b>
  
📝 <b>功能:</b>
• 安全的定时任务管理
• 资源自动清理
• 任务状态监控

🔧 <b>命令:</b>
• <code>.task add [分钟] [内容]</code> - 添加任务
• <code>.task list</code> - 查看任务
• <code>.task clear</code> - 清空任务`;

  cmdHandlers = {
    task: async (msg: Api.Message) => {
      const args = msg.text?.split(/\s+/) || [];
      const subcommand = args[1]?.toLowerCase();
      
      switch(subcommand) {
        case 'add':
          await this.addTask(msg, args.slice(2));
          break;
        case 'list':
          await this.listTasks(msg);
          break;
        case 'clear':
          await this.clearTasks(msg);
          break;
        default:
          await msg.edit({
            text: this.description,
            parseMode: "html"
          });
      }
    }
  };
  
  private async addTask(msg: Api.Message, args: string[]): Promise<void> {
    if (args.length < 2) {
      await msg.edit({
        text: "❌ <b>用法:</b> <code>.task add [分钟] [内容]</code>",
        parseMode: "html"
      });
      return;
    }
    
    const minutes = parseInt(args[0]);
    const content = args.slice(1).join(' ');
    
    if (isNaN(minutes) || minutes <= 0) {
      await msg.edit({
        text: "❌ <b>错误:</b> 请输入有效的分钟数",
        parseMode: "html"
      });
      return;
    }
    
    const taskId = `task_${Date.now()}`;
    const delay = minutes * 60 * 1000;
    
    const timer = setTimeout(async () => {
      try {
        const client = await getGlobalClient();
        await client.sendMessage(msg.peerId, {
          message: `⏰ <b>提醒:</b> ${content}`,
          parseMode: "html",
          replyTo: msg.id
        });
      } catch (error) {
        console.error(`[ScheduledTasks] Error sending reminder:`, error);
      } finally {
        this.activeTimers.delete(taskId);
      }
    }, delay);
    
    this.activeTimers.set(taskId, timer);
    
    await msg.edit({
      text: `✅ <b>任务已添加</b>\n\n⏰ ${minutes}分钟后提醒:\n${content}`,
      parseMode: "html"
    });
  }
  
  private async listTasks(msg: Api.Message): Promise<void> {
    if (this.activeTimers.size === 0) {
      await msg.edit({
        text: "📋 <b>当前没有活跃任务</b>",
        parseMode: "html"
      });
      return;
    }
    
    let text = `📊 <b>活跃任务 (${this.activeTimers.size})</b>\n\n`;
    const now = Date.now();
    
    for (const [taskId, timer] of this.activeTimers) {
      // 注意：无法精确获取剩余时间，这里只显示任务ID
      text += `• ${taskId}\n`;
    }
    
    await msg.edit({
      text,
      parseMode: "html"
    });
  }
  
  private async clearTasks(msg: Api.Message): Promise<void> {
    let clearedCount = 0;
    
    for (const [taskId, timer] of this.activeTimers) {
      clearTimeout(timer);
      clearedCount++;
    }
    
    this.activeTimers.clear();
    
    await msg.edit({
      text: `✅ <b>已清空 ${clearedCount} 个任务</b>`,
      parseMode: "html"
    });
  }
  
  async cleanup(): Promise<void> {
    console.log(`[${this.name}] Cleaning up scheduled tasks...`);
    
    // 清理所有定时器
    let clearedCount = 0;
    for (const [taskId, timer] of this.activeTimers) {
      clearTimeout(timer);
      clearedCount++;
    }
    
    this.activeTimers.clear();
    
    // 清理 cron 任务
    const removedCrons = cronManager.delByPlugin(this.name);
    
    console.log(`[${this.name}] Cleanup completed:`, {
      clearedTimers: clearedCount,
      removedCronTasks: removedCrons
    });
  }
}

export default new ScheduledTasksPlugin();
```

### 数据库插件示例

```typescript
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import path from "path";

class DatabasePlugin extends Plugin {
  name = "database_demo";
  private db: any = null;
  private dbPath: string;
  
  constructor() {
    super();
    this.dbPath = path.join(createDirectoryInAssets(this.name), 'data.json');
  }
  
  description = `💾 <b>数据库插件示例</b>
  
📝 <b>功能:</b>
• 安全的数据库管理
• 自动资源清理
• 数据持久化

🔧 <b>命令:</b>
• <code>.db save [内容]</code> - 保存数据
• <code>.db list</code> - 列出数据
• <code>.db clear</code> - 清空数据`;

  cmdHandlers = {
    db: async (msg: Api.Message) => {
      const args = msg.text?.split(/\s+/) || [];
      const subcommand = args[1]?.toLowerCase();
      
      switch(subcommand) {
        case 'save':
          await this.saveData(msg, args.slice(2).join(' '));
          break;
        case 'list':
          await this.listData(msg);
          break;
        case 'clear':
          await this.clearData(msg);
          break;
        default:
          await msg.edit({
            text: this.description,
            parseMode: "html"
          });
      }
    }
  };
  
  private async initDB(): Promise<void> {
    if (!this.db) {
      console.log(`[${this.name}] Initializing database...`);
      this.db = await JSONFilePreset(this.dbPath, { 
        records: [], 
        lastCleanup: Date.now() 
      });
    }
  }
  
  private async saveData(msg: Api.Message, content: string): Promise<void> {
    if (!content.trim()) {
      await msg.edit({
        text: "❌ <b>错误:</b> 请输入要保存的内容",
        parseMode: "html"
      });
      return;
    }
    
    await this.initDB();
    
    this.db.data.records.push({
      id: Date.now(),
      userId: msg.senderId?.toString() || 'unknown',
      content: content.trim(),
      timestamp: Date.now()
    });
    
    await this.db.write();
    
    await msg.edit({
      text: `✅ <b>数据已保存</b>\n\n📝 内容: ${content}`,
      parseMode: "html"
    });
  }
  
  private async listData(msg: Api.Message): Promise<void> {
    await this.initDB();
    
    const userId = msg.senderId?.toString() || 'unknown';
    const records = this.db.data.records
      .filter((r: any) => r.userId === userId)
      .sort((a: any, b: any) => b.timestamp - a.timestamp)
      .slice(0, 10);
    
    if (records.length === 0) {
      await msg.edit({
        text: "📋 <b>没有找到记录</b>",
        parseMode: "html"
      });
      return;
    }
    
    let text = `📊 <b>最近记录 (${records.length})</b>\n\n`;
    records.forEach((record: any, index: number) => {
      const date = new Date(record.timestamp).toLocaleString();
      text += `${index + 1}. <code>${record.content}</code>\n`;
      text += `   <i>${date}</i>\n\n`;
    });
    
    await msg.edit({
      text,
      parseMode: "html"
    });
  }
  
  private async clearData(msg: Api.Message): Promise<void> {
    await this.initDB();
    
    const userId = msg.senderId?.toString() || 'unknown';
    const beforeCount = this.db.data.records.length;
    
    this.db.data.records = this.db.data.records.filter(
      (r: any) => r.userId !== userId
    );
    
    await this.db.write();
    const afterCount = this.db.data.records.length;
    
    await msg.edit({
      text: `✅ <b>已清空 ${beforeCount - afterCount} 条记录</b>`,
      parseMode: "html"
    });
  }
  
  async cleanup(): Promise<void> {
    console.log(`[${this.name}] Cleaning up database resources...`);
    
    try {
      // 1. 确保所有写入完成
      if (this.db?.write) {
        await this.db.write();
        console.log(`[${this.name}] Database flushed to disk`);
      }
      
      // 2. 清理引用
      this.db = null;
      
      // 3. 运行定期清理（如果需要）
      if (this.dbPath) {
        console.log(`[${this.name}] Database file remains at: ${this.dbPath}`);
      }
      
      console.log(`[${this.name}] Database cleanup completed successfully`);
    } catch (error) {
      console.error(`[${this.name}] Error during database cleanup:`, error);
    }
  }
}

export default new DatabasePlugin();
```

## 🔧 系统插件说明

TeleBox内置15个系统插件，位于 `src/plugin/` 目录。

### 基础功能插件

#### help - 帮助系统

**文件**: `src/plugin/help.ts`

**功能**：
- 显示所有可用命令列表
- 自动读取插件描述
- 显示TeleBox版本信息
- 智能命令分组显示

**命令**：

```
.help              # 显示所有命令
.help [命令名]     # 显示特定命令的帮助
```

#### alias - 命令别名

**文件**: `src/plugin/alias.ts`

**功能**：
- 为命令设置自定义别名
- 别名数据持久化存储
- 支持查看、设置、删除别名

**命令**：

```
.alias set [别名] [原命令]   # 设置别名
.alias del [别名]            # 删除别名
.alias list                  # 列出所有别名
```

#### sudo - 权限管理

**文件**: `src/plugin/sudo.ts`

**功能**：
- 管理管理员用户列表
- 权限验证
- 支持添加、删除、查看管理员

**命令**：

```
.sudo add [用户ID]    # 添加管理员
.sudo del [用户ID]    # 删除管理员
.sudo list            # 列出所有管理员
```

#### debug - 调试工具

**文件**: `src/plugin/debug.ts`

**功能**：
- 获取用户、群组、频道详细信息
- 消息调试
- 实体信息查询

**命令**：

```
.id           # 获取当前对话或回复消息的ID
.entity       # 获取实体详细信息
.msg          # 获取消息完整数据
```

#### sure - 确认操作

**文件**: `src/plugin/sure.ts`

**功能**：
- 危险操作二次确认
- 防止误操作
- 超时自动取消

**使用方式**：其他插件调用SureDB进行确认

### 系统管理插件

#### sysinfo - 系统信息

**文件**: `src/plugin/sysinfo.ts`

**功能**：
- 显示TeleBox运行状态
- CPU、内存、磁盘使用情况
- 系统版本信息

**命令**：

```
.sysinfo      # 显示系统信息
```

#### update - 更新管理

**文件**: `src/plugin/update.ts`

**功能**：
- 从Git拉取最新代码
- 自动安装依赖
- 重启TeleBox

**命令**：

```
.update       # 普通更新
.update -f    # 强制更新（覆盖本地修改）
```

#### bf - 备份管理

**文件**: `src/plugin/bf.ts`

**功能**：
- 备份TeleBox所有数据
- 恢复历史备份
- 压缩备份文件
- 支持定时备份

**命令**：

```
.bf           # 创建备份
.hf           # 恢复备份（从最新备份恢复）
```

#### tpm - TeleBox插件包管理器

**文件**: `src/plugin/tpm.ts`

**功能**：
- 安装、卸载、更新插件包
- 从NPM或Git仓库安装插件
- 插件依赖管理
- 插件搜索

**命令**：

```
.tpm i [插件名]           # 安装插件
.tpm rm [插件名]          # 卸载插件
.tpm ls                   # 列出已安装插件
.tpm search [关键词]      # 搜索插件
.tpm update [插件名]      # 更新插件
```

### 开发工具插件

#### exec - 命令执行

**文件**: `src/plugin/exec.ts`

**功能**：
- 执行Shell命令
- 显示命令输出
- 错误处理

**命令**：

```
.exec [shell命令]    # 执行Shell命令
```

⚠️ **安全警告**：此插件具有系统级权限，请谨慎使用

#### reload - 热重载

**文件**: `src/plugin/reload.ts`

**功能**：
- 重新加载插件
- 无需重启TeleBox
- 用于插件开发调试

**命令**：

```
.reload [插件名]     # 重载指定插件
.reload              # 重载所有插件
```

#### sendLog - 日志发送

**文件**: `src/plugin/sendLog.ts`

**功能**：
- 发送系统日志文件
- 查看错误日志
- 调试问题

**命令**：

```
.log          # 发送日志文件
.errlog       # 发送错误日志
```

### 实用工具插件

#### ping - 网络测试

**文件**: `src/plugin/ping.ts`

**功能**：
- 测试网络延迟
- 检测Telegram API连接
- 显示响应时间

**命令**：

```
.ping         # 测试延迟
```

#### prefix - 前缀管理

**文件**: `src/plugin/prefix.ts`

**功能**：
- 动态修改命令前缀
- 查看当前前缀
- 支持多前缀

**命令**：

```
.prefix               # 查看当前前缀
.prefix set [前缀]    # 设置前缀
```

#### re - 消息复读

**文件**: `src/plugin/re.ts`

**功能**：
- 复读回复的消息
- 转发消息

**命令**：

```
.re           # 复读回复的消息
```

## 🎯 用户插件示例

`plugins/` 目录包含78个用户插件示例，展示了TeleBox的各种功能实现。

**插件总览**：
- 群组管理类：10+ 个插件
- 媒体处理类：15+ 个插件  
- 实用工具类：20+ 个插件
- 网络服务类：10+ 个插件
- 娱乐游戏类：10+ 个插件
- 高级功能类：10+ 个插件

### 群组管理类

#### aban - 自动封禁管理

**文件**: `plugins/aban.ts`

**功能**：
- 自动检测并封禁违规用户
- 支持关键词过滤
- 支持白名单机制
- 批量解封功能
- 使用lowdb存储封禁记录

#### clean_member - 成员清理

**文件**: `plugins/clean_member.ts`

**功能**：
- 清理僵尸粉、删除号
- 批量踢出长期不活跃成员
- 支持自定义清理规则
- 成员活跃度分析

#### pmcaptcha - 私聊验证码

**文件**: `plugins/pmcaptcha.ts`

**功能**：
- 防止私聊骚扰
- 多种验证方式（算术、图片等）
- 自动封禁失败用户
- 验证超时管理

#### dme - 消息批量管理

**文件**: `plugins/dme.ts`

**功能**：
- 批量删除消息
- 消息过滤和筛选
- 支持按时间范围删除

#### da - 批量删除

**文件**: `plugins/da.ts`

**功能**：
- 启动/停止批量删除任务
- 删除进度追踪
- 任务状态管理

#### sunremove - 太阳图标清理

**文件**: `plugins/sunremove.ts`

**功能**：
- 清理特定图标或标记
- 自动检测和删除

### 搜索与信息类

#### search - 通用搜索

**文件**: `plugins/search.ts`

**功能**：
- 多引擎搜索
- 结果聚合
- 搜索历史

#### ddg - DuckDuckGo搜索

**文件**: `plugins/ddg.ts`

**功能**：
- DuckDuckGo搜索引擎集成
- 免配置，开箱即用
- 搜索结果格式化显示

#### soutu - 搜图

**文件**: `plugins/soutu.ts`

**功能**：
- 以图搜图
- 支持多个搜图引擎
- 图片相似度搜索

#### rate - 汇率查询

**文件**: `plugins/rate.ts`

**功能**：
- 实时汇率转换
- 支持多种货币
- 历史汇率查询
- 汇率走势图表

### 下载与媒体类

#### yt-dlp - 视频下载

**文件**: `plugins/yt-dlp.ts`

**功能**：
- YouTube视频下载
- 多平台支持
- 格式选择
- 批量下载

#### getstickers - 贴纸获取

**文件**: `plugins/getstickers.ts`

**功能**：
- 贴纸包下载
- 批量导出
- 格式转换

#### gif - GIF处理

**文件**: `plugins/gif.ts`

**功能**：
- GIF生成
- GIF编辑
- 格式转换

#### eatgif - 表情包生成

**文件**: `plugins/eatgif.ts`

**功能**：
- 趣味表情包生成
- 自定义模板
- 批量生成

#### audio_to_voice - 音频转语音

**文件**: `plugins/audio_to_voice.ts`

**功能**：
- 音频文件转语音消息
- 格式转换
- 音质调整

### 开发工具类

#### git_PR - GitHub PR管理

**文件**: `plugins/git_PR.ts`

**功能**：
- GitHub Pull Request管理
- PR创建和更新
- 代码审查助手

#### his - 历史记录

**文件**: `plugins/his.ts`

**功能**：
- 命令历史记录
- 历史查询和回放
- 历史搜索

### 娱乐游戏类

#### lottery - 抽奖系统

**文件**: `plugins/lottery.ts`

**功能**：
- 群组抽奖功能
- 奖池管理
- 中奖记录
- 抽奖配置

#### crazy4 - 疯狂四子棋

**文件**: `plugins/crazy4.ts`

**功能**：
- 四子棋游戏
- 多人对战
- 游戏统计
- AI对战模式

### 实用转换类

#### convert - 格式转换

**文件**: `plugins/convert.ts`

**功能**：
- 文件格式转换
- 编码转换
- 单位转换

#### encode - 编解码

**文件**: `plugins/encode.ts`

**功能**：
- Base64编解码
- URL编解码
- 哈希计算
- 加密解密

#### qr - 二维码

**文件**: `plugins/qr.ts`

**功能**：
- 生成二维码
- 解析二维码
- 批量处理

### 贴纸管理类

#### sticker - 贴纸管理

**文件**: `plugins/sticker.ts`

**功能**：
- 贴纸包管理
- 贴纸下载
- 贴纸转换

#### pic_to_sticker - 图片转贴纸

**文件**: `plugins/pic_to_sticker.ts`

**功能**：
- 图片转贴纸
- 批量转换
- 自定义参数

#### sticker_to_pic - 贴纸转图片

**文件**: `plugins/sticker_to_pic.ts`

**功能**：
- 贴纸转图片
- 格式选择
- 批量处理

#### copy_sticker_set - 复制贴纸包

**文件**: `plugins/copy_sticker_set.ts`

**功能**：
- 完整复制贴纸包
- 批量操作
- 自定义名称

### 媒体处理类

#### image_monitor - 图片监控

**文件**: `plugins/image_monitor.ts`

**功能**：
- 自动监听群组图片
- 支持图片自动保存
- 支持图片内容识别
- **无需命令触发，自动工作**
- 使用消息监听器实现

#### music - 音乐搜索下载

**文件**: `plugins/music.ts`

**功能**：
- 支持多平台音乐搜索
- 高品质音乐下载
- 歌词同步下载
- 播放列表管理

#### music_bot - 音乐Bot集成

**文件**: `plugins/music_bot.ts`

**功能**：
- 与音乐Bot交互
- 自动下载音乐
- Bot命令转发

### 网络工具类

#### speedtest - 网速测试

**文件**: `plugins/speedtest.ts`

**功能**：
- 测试服务器网速
- 支持多个测速节点
- 详细的网络诊断信息
- 上传/下载速度测试

#### speedlink - 速度链接

**文件**: `plugins/speedlink.ts`

**功能**：
- 链接速度测试
- 延迟检测
- 可用性检查

#### ip - IP查询

**文件**: `plugins/ip.ts`

**功能**：
- IP地址查询
- 地理位置信息
- ISP信息
- 代理检测

#### whois - 域名查询

**文件**: `plugins/whois.ts`

**功能**：
- 域名WHOIS查询
- 注册信息查询
- DNS记录查询
- 域名状态检查

#### dig - DNS查询

**文件**: `plugins/dig.ts`

**功能**：
- DNS记录查询
- 支持多种记录类型
- 递归查询
- 反向解析

#### warp - Cloudflare WARP管理

**文件**: `plugins/warp.ts`

**功能**：
- Cloudflare WARP配置管理
- VPN连接控制
- 网络状态监控

#### ssh - SSH远程管理

**文件**: `plugins/ssh.ts`

**功能**：
- 远程服务器管理
- 支持多服务器配置
- 安全的密钥管理
- SSH命令执行

### 高级功能类

#### shift - 任务调度系统

**文件**: `plugins/shift.ts`

**功能**：
- 复杂任务编排
- 支持任务依赖
- 任务状态监控
- 定时任务管理

#### sub - 订阅管理

**文件**: `plugins/sub.ts`

**功能**：
- RSS订阅推送
- 自定义订阅源
- 定时推送配置
- 订阅内容过滤

#### gt - Google翻译

**文件**: `plugins/gt.ts`

**功能**：
- Google翻译集成
- 多语言翻译支持
- 自动语言检测

#### ids - ID查询

**文件**: `plugins/ids.ts`

**功能**：
- 用户/群组ID查询
- 多目标ID批量查询
- ID信息导出

### AI与自动化类

#### ai - AI助手

**文件**: `plugins/ai.ts`

**功能**：
- 多模型AI对话
- 上下文管理
- 智能回复
- 配置管理

#### aitc - AI文本分类

**文件**: `plugins/aitc.ts`

**功能**：
- 文本分类
- 情感分析
- 内容审核

#### acron - 高级定时任务

**文件**: `plugins/acron.ts`

**功能**：
- 复杂定时任务管理
- 任务编排
- 执行日志
- 任务持久化

#### autochangename - 自动改名

**文件**: `plugins/autochangename.ts`

**功能**：
- 定时自动更改用户名
- 自定义改名规则
- 改名历史记录

#### autodel - 自动删除

**文件**: `plugins/autodel.ts`

**功能**：
- 自动删除消息
- 定时清理
- 条件过滤

#### autodelcmd - 自动删除命令

**文件**: `plugins/autodelcmd.ts`

**功能**：
- 命令消息自动删除
- 延时删除
- 白名单管理

## ⚠️ 重要注意事项

### 代码细节说明

1. **拼写特殊性**
   - `DEFAUTL_PLUGIN_PATH` - 实际代码中是 DEFAUTL 而非 DEFAULT
   - 这是源代码中的实际拼写，请保持一致

2. **Hook系统状态**
   - `patchMsgEdit()` 功能当前已注释
   - 为sudo用户提供消息编辑重定向功能
   - 需要时可手动启用

3. **环境变量默认值**
   - `TB_CMD_IGNORE_EDITED` 默认为 "true"
   - `listenMessageHandlerIgnoreEdited` 默认为 true
   - 大部分插件默认忽略编辑消息

4. **数据库选择**
   - **只使用 lowdb** 作为数据存储
   - 虽然有 better-sqlite3 依赖，但主要使用 lowdb
   - 所有插件数据存储在 assets/插件名/ 目录下

5. **插件数量**
   - 系统插件：15个
   - 用户插件示例：78个
   - 总计93个插件

6. **代理配置**
   - config.json 支持 proxy 配置
   - 默认使用 SOCKS5 代理
   - 端口通常为 7877

### 开发最佳实践

1. **插件命名**
   - 插件文件名必须与主命令一致
   - 避免单字母插件名
   - 使用 snake_case 命名

2. **错误处理**
   - 始终捕获异常
   - 使用 htmlEscape 处理用户输入
   - 提供友好的错误提示

3. **性能优化**
   - 避免在消息监听器中执行重操作
   - 使用异步操作
   - 合理使用缓存

4. **安全边界**
   - 命令处理器必须有明确前缀
   - 消息监听器需要明确过滤条件
   - 避免触发Telegram风控