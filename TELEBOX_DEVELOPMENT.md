# TeleBox 开发规范

## 目录
📁 [核心架构](#核心架构)
💡 [生命周期管理](#生命周期管理)
⚠️ [内存泄漏预防](#内存泄漏预防)
🔌 [插件系统](#插件系统)
🎨 [指令架构设计](#指令架构设计)
📋 [开发规范](#开发规范)
⚙️ [环境配置](#环境配置)
📦 [核心工具模块](#核心工具模块)
🔍 [核心API签名](#核心api签名)
📝 [插件开发框架](#插件开发框架)
🚀 [完整插件示例](#完整插件示例)
🔧 [系统插件说明](#系统插件说明)
🎯 [用户插件示例](#用户插件示例)
⚠️ [重要注意事项](#重要注意事项)

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
职责：
- 加载环境变量
- 初始化Telegram客户端
- 加载插件系统
- 应用Hook补丁

#### 工具模块 (utils/)
17个核心工具文件：
| 文件名 | 功能说明 |
| --- | --- |
| pluginBase.ts | 插件基类定义 |
| pluginManager.ts | 插件管理器，负责加载和路由 |
| globalClient.ts | 全局Telegram客户端实例 |
| loginManager.ts | 登录管理器 |
| apiConfig.ts | API配置管理 |
| pathHelpers.ts | 路径辅助工具 |
| entityHelpers.ts | Telegram实体处理工具 |
| aliasDB.ts | 命令别名数据库 |
| sudoDB.ts | 管理员权限数据库 |
| sureDB.ts | 确认操作数据库 |
| sendLogDB.ts | 发送日志数据库 |
| banUtils.ts | 封禁管理工具 |
| cronManager.ts | 定时任务管理器 |
| conversation.ts | 对话管理器 |
| tlRevive.ts | Telegram实体序列化工具 |
| npm_install.ts | NPM包安装工具 |
| teleboxInfoHelper.ts | 系统信息助手 |

#### 系统插件 (plugin/)
15个内置插件：
| 插件名 | 功能说明 |
| --- | --- |
| alias.ts | 命令别名管理 |
| bf.ts | 备份功能 |
| debug.ts | 调试工具 |
| exec.ts | 命令执行 |
| help.ts | 帮助系统 |
| ping.ts | 网络测试 |
| prefix.ts | 前缀管理 |
| re.ts | 消息复读 |
| reload.ts | 热重载 |
| sendLog.ts | 日志发送 |
| sudo.ts | 权限管理 |
| sure.ts | 确认操作 |
| sysinfo.ts | 系统信息 |
| tpm.ts | 插件包管理器 |
| update.ts | 更新管理 |

#### Hook系统 (hook/)
`listen.ts` - 消息监听器和编辑补丁（为sudo用户提供特殊消息处理）  
`patches/` - Telegram API补丁  
`types/` - 类型定义  
特殊功能：
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
规范：
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
- 当前版本: 0.2.6
- Node.js要求: >= 14.x
- TypeScript版本: ^5.9.2
- Telegram库版本: ^2.26.22
- 协议: LGPL-2.1-only

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
`cleanup()` 方法是解决内存泄漏的核心。每次插件被重载或系统关闭时，TeleBox 会自动调用此方法。开发者必须在此方法中清理所有外部资源，以下是完整指南：

#### 基本原则
1. **必须实现**：所有插件必须实现 `cleanup()` 方法，未实现的插件将被拒绝加载
2. **完整清理**：清理所有创建的资源，包括定时器、事件监听器、数据库连接等
3. **错误容忍**：使用 try-catch 确保部分失败不影响整体清理
4. **资源跟踪**：使用数据结构（如数组、Map）跟踪创建的所有资源
5. **显式释放**：手动释放大对象引用，辅助垃圾回收

#### 资源清理示例
```typescript
class MyPlugin extends Plugin {
  private timers: NodeJS.Timeout[] = [];
  private dbConnection: any = null;
  private eventListeners: Array<{ event: string, handler: Function }> = [];
  private cronTaskNames: string[] = [];
  private largeDataCache: any = null;
  
  async cleanup(): Promise<void> {
    console.log(`[MyPlugin] Starting cleanup...`);
    
    try {
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
      this.cronTaskNames.forEach(taskName => {
        cronManager.del(taskName);
      });
      this.cronTaskNames = [];
      
      // 5. 显式释放大对象引用
      this.largeDataCache = null;
      
      console.log(`[MyPlugin] Cleanup completed successfully`);
    } catch (error) {
      console.error(`[MyPlugin] Error during cleanup:`, error);
      // 继续清理其他资源，不抛出错误
    }
  }
}
```

#### 高级清理模式
1. **事件监听器清理**
```typescript
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

2. **定时器管理**
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

3. **数据库管理**
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
    // 确保所有写入完成
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
- 未移除的事件监听器 - 最常见原因
- 未清理的定时器/间隔 - setTimeout/setInterval
- 闭包引用 - 内部函数引用外部变量
- 全局变量 - 未清理的缓存和大对象
- 数据库连接 - 未关闭的文件句柄
- 未停止的Cron任务 - 在重载时继续运行

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
}
```

### 泄漏检测技巧
1. 定期内存快照：
```typescript
const before = MemoryMonitor.snapshot();
// 执行操作
const after = MemoryMonitor.snapshot();
console.log(MemoryMonitor.diff(before, after));
```

2. 重载测试：
```bash
# 连续重载5次，观察内存增长
for i in {1..5}; do echo ".reload"; sleep 2; done
```

3. 开发时使用 `--expose-gc` 标志手动触发垃圾回收：
```typescript
// 在cleanup()中
if (typeof global.gc === 'function') {
  global.gc();
}
```

## 🔌 插件系统

### 插件基类
实际实现 (`src/utils/pluginBase.ts`)：
```typescript
type CronTask = {
  cron: string;
  description: string;
  handler: (client: TelegramClient) => Promise<void>;
};

const cmdIgnoreEdited = !!JSON.parse(
  process.env.TB_CMD_IGNORE_EDITED || "true"
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
}
```

### 插件加载机制
加载流程 (`src/utils/pluginManager.ts`)：
```typescript
const USER_PLUGIN_PATH = path.join(process.cwd(), "plugins");
const DEFAUTL_PLUGIN_PATH = path.join(process.cwd(), "src", "plugin");  // 注意：实际代码中是DEFAUTL而非DEFAULT

// 1. 先加载用户插件
await setPlugins(USER_PLUGIN_PATH);

// 2. 再加载系统插件
await setPlugins(DEFAUTL_PLUGIN_PATH);
```
加载规则：
- 扫描目录下所有 `.ts` 文件
- 使用动态 `require` 加载模块
- 检查是否为有效的 `Plugin` 实例
- 注册命令到全局命令表
- 处理命令别名

优先级：
- 用户插件先加载，可以覆盖系统插件
- 同名命令：后加载覆盖先加载
- 监听器和事件处理器：全部执行，不互斥

### 插件触发方式

#### ⚠️ 安全边界声明
重要：为防止Telegram风控和滥用，必须明确各种触发器的边界

##### 1. 命令处理器 (cmdHandlers)
触发条件：
- 仅当消息以配置的前缀开头时触发
- 默认前缀：`.。$`
- 开发环境前缀：`!！`
- 通过 `TB_PREFIX` 环境变量自定义

##### 2. 消息监听器 (listenMessageHandler)
触发条件：
- 监听所有消息，不管是否有命令前缀
- 必须有明确的过滤逻辑，不能对所有消息都处理
- 通过 `listenMessageHandlerIgnoreEdited` 控制是否忽略编辑消息

##### 3. 事件处理器 (eventHandlers)
触发条件：
- 监听特定的 Telegram 事件
- 只处理必要的特定事件，不得滥用事件监听

##### 4. 定时任务 (cronTasks)
触发条件：
- 按 cron 表达式定期执行
- 控制执行频率，避免过度请求
- 不得在所有会话中随意发送消息

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
适用场景：功能相关，共享配置或状态，需要统一管理
```typescript
import { getPrefixes } from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0]; // 获取主前缀

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
  
  private async showHelp(msg) {
    const helpText = `🎵 ${mainPrefix}music 指令帮助
    
命令格式：
${mainPrefix}music [子命令] [参数]

可用子命令：
• search (s) - 搜索音乐
• cookie - 设置Cookie

示例：
${mainPrefix}music search 周杰伦
${mainPrefix}music cookie set your_cookie`;
    
    await msg.edit({ text: helpText, parseMode: 'html' });
  }
}
```
特点：
- 单一主指令入口
- 内部路由处理子功能
- 支持子指令别名
- 便于功能扩展和配置管理
- 统一的错误处理

#### 模式二：独立指令模式（特殊场景，1%）
适用场景：功能完全独立，需要提供便捷的短指令
```typescript
import { getPrefixes } from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0]; // 获取主前缀

class SpeedTestPlugin extends Plugin {
  cmdHandlers = {
    speedtest: handleSpeedTest,  // 完整指令
    st: handleSpeedTest,         // 短别名
  }
  
  description = `⚡ 网速测试工具
  
使用方法：
${mainPrefix}speedtest 或 ${mainPrefix}st
  
测试服务器网络连接速度`;
}
```
特点：
- 每个指令都是独立的处理函数
- 支持指令级别的别名
- 适合单一功能插件
- 用户可使用短指令快速访问

### 选择指南
- 默认选择：主从指令模式（99%）
  - ✅ 多个相关功能
  - ✅ 需要子命令（如 add、remove、list）
  - ✅ 共享配置或状态
  - ✅ 功能可能扩展
- 何时使用独立指令模式（1%）：
  - 单一独立功能
  - 需要极简的快捷指令
  - 功能不会扩展
  - 与其他功能无关联

### 帮助系统设计
所有插件必须：
- 定义简洁明了的 `help_text`
- 在 `description` 中引用帮助文本
- 支持 help 子指令或无参数时显示帮助
- 使用动态主前缀，不硬编码 "." 符号

#### 帮助文案规范
1. **简洁明了**：避免冗长和不必要的技术细节
2. **结构清晰**：功能描述、使用方法、示例三部分
3. **完整覆盖**：所有指令/子指令都要包含，但不重复
4. **格式统一**：on/off、true/false 等选项统一描述
5. **动态前缀**：使用 mainPrefix 变量，不硬编码 "." 符号

#### 推荐的帮助文案格式
```typescript
import { getPrefixes } from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0]; // 获取主前缀

const help_text = `⚙️ <b>${pluginName}</b>

<b>📝 功能描述:</b>
• 简明的功能1描述
• 简明的功能2描述

<b>🔧 使用方法:</b>
• <code>${mainPrefix}${command1} [参数]</code> - 简洁说明
• <code>${mainPrefix}${command2}</code> - 简洁说明
• <code>${mainPrefix}${command} ${subcommand}</code> - 简洁说明

<b>💡 示例:</b>
• <code>${mainPrefix}${command} ${example}</code> - 说明
• <code>${mainPrefix}${command} ${subcommand} ${example}</code> - 说明`;
```

#### 反面示例（需避免）
```typescript
// ❌ 问题1：硬编码 "." 前缀
const help_text = `.command 使用说明`;

// ❌ 问题2：冗长且技术细节过多
const help_text = `此插件使用了最新的AI算法，基于Transformer架构，参数量达到1.5B...`;

// ❌ 问题3：指令重复描述
const help_text = `
开启: .cmd on
关闭: .cmd off
启用: .cmd true
禁用: .cmd false
`;

// ❌ 问题4：帮助信息不完整
const help_text = `.cmd - 一个命令`;
```

## 📋 开发规范

### 命名规范

#### 文件命名
- 插件文件: `snake_case.ts` (如 `image_monitor.ts`)
- 工具模块: `camelCase.ts` (如 `pluginBase.ts`)
- 类型定义: `PascalCase.d.ts` (如 `TelegramTypes.d.ts`)
- ⚠️ 禁止插件文件使用单字母 (如 `a.ts`, `x.ts` 等)

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
- ⚠️ 插件指令的主指令必须是插件文件名，其余别名可以在帮助文档中声明，但主指令必须与文件名一致
- ⚠️ 不允许将命令名定义为常量，必须直接使用字符串字面量

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
```

#### 错误处理
```typescript
// 错误分类
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

#### 日志规范
```typescript
// 日志级别
console.debug('[Plugin] Processing message:', msgId);  // 详细调试信息
console.info('[Plugin] Plugin loaded successfully');   // 一般信息
console.warn('[Plugin] API rate limit approaching');   // 警告信息
console.error('[Plugin] Failed to process:', error);   // 错误信息
```

#### 注释规范
- **提倡单行注释**：使用 `//` 而不是多行注释
- **控制数量**：只在关键逻辑、复杂算法、非直观代码处添加注释
- **避免过度注释**：不要注释显而易见的代码
- **关键部分必须注释**：复杂逻辑、特殊处理、潜在陷阱

```typescript
// ✅ 良好的注释示例
class GoodExample {
  // 缓存用户数据，避免频繁API请求
  private userCache = new Map<string, UserData>();
  
  // 限制缓存大小，防止内存泄漏
  private MAX_CACHE_SIZE = 100;
  
  // 处理消息，支持编辑消息
  async handleMessage(msg: Api.Message, isEdited = false) {
    // 检查权限
    if (!(await this.checkPermission(msg.senderId))) {
      return;
    }
    
    // 处理图片消息
    if (msg.photo) {
      // 特殊处理GIF，转为视频
      if (this.isGif(msg)) {
        await this.processGif(msg);
      } else {
        await this.processImage(msg);
      }
    }
  }
  
  // 每6小时清理一次缓存
  async cleanup() {
    this.userCache.clear();
  }
}

// ❌ 过度注释示例
class BadExample {
  // 这是一个计数器变量
  private counter = 0;
  
  // 增加计数器
  increment() {
    // 计数器加1
    this.counter += 1;
  }
  
  // 获取计数器值
  getCount() {
    // 返回计数器
    return this.counter;
  }
}
```

### 内存安全编码规范

#### 必须实现 cleanup()
- 所有插件必须实现 `cleanup()` 方法
- 必须清理所有外部资源
- 必须移除所有事件监听器
- 必须清除所有定时器
- 必须包含 try-catch，确保部分失败不影响整体

#### 资源跟踪
- 使用数组或Map跟踪创建的资源
- 为每个资源分配唯一ID
- 在 cleanup() 中遍历清理

#### 避免全局状态
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

#### 限制缓存大小
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

## ⚙️ 环境配置

### 必需配置文件

#### config.json - Telegram API配置
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

#### .env - 环境变量配置
```env
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
  }
}
```

### 进程管理配置

#### ecosystem.config.js - PM2配置
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

### 环境变量详解

#### 命令前缀配置
```env
# 生产环境命令前缀
TB_PREFIX=". 。"

# Sudo命令前缀（管理员专用）
TB_SUDO_PREFIX="# $"
```
说明：
- 支持多个前缀，用空格分隔
- 常用前缀：`.。$!#`
- Sudo前缀用于需要管理员权限的命令

#### 插件行为配置
```env
# 全局设置命令是否忽略编辑的消息
TB_CMD_IGNORE_EDITED=false

# 设置哪些插件的监听不忽略编辑的消息
TB_LISTENER_HANDLE_EDITED="sudo sure"
```
说明：
- `TB_CMD_IGNORE_EDITED` - 控制命令处理器是否响应编辑后的消息
- `TB_LISTENER_HANDLE_EDITED` - 指定哪些插件的监听器处理编辑消息
- 用空格分隔多个插件名

#### 开发模式配置
```env
# 使用开发模式启动
NODE_ENV=development
```
启动方式：
```bash
# 生产模式
npm start

# 开发模式
npm run dev
```

## 📦 核心工具模块
TeleBox提供了17个核心工具模块，位于 `src/utils/` 目录。

### 插件管理器
```typescript
import { 
  getPrefixes,      // 获取命令前缀列表
  setPrefixes,      // 设置命令前缀
  loadPlugins,      // 加载所有插件
  listCommands,     // 列出所有命令
  getCommandFromMessage,           // 从消息中提取命令
  dealCommandPluginWithMessage     // 处理命令消息
} from "@utils/pluginManager";
```

### 全局客户端
```typescript
import { getGlobalClient } from "@utils/globalClient";

const client = await getGlobalClient();
// 使用client进行API调用
await client.sendMessage(peer, { message: "Hello" });
```

### 数据库工具
```typescript
// 命令别名数据库
import { AliasDB } from "@utils/aliasDB";
const aliasDB = new AliasDB();
aliasDB.set("h", "help");        // 设置别名
aliasDB.getOriginal("h");        // 获取原命令

// 管理员权限数据库
import { SudoDB } from "@utils/sudoDB";
const sudoDB = new SudoDB();
sudoDB.add(userId);              // 添加管理员
sudoDB.has(userId);              // 检查权限
```

### 实体处理工具
```typescript
import { 
  getEntityWithHash,    // 获取实体及其哈希
  parseEntityId,        // 解析实体ID
  safeForwardMessage    // 安全转发消息
} from "@utils/entityHelpers";
```

### 路径管理
```typescript
import { 
  createDirectoryInAssets,  // 在assets目录创建子目录
  createDirectoryInTemp     // 在temp目录创建子目录
} from "@utils/pathHelpers";

const dataDir = createDirectoryInAssets("myplugin");
// 返回: /path/to/telebox/assets/myplugin
```

## 🔍 核心API签名

### 消息限制
- Telegram消息最大 4096 字符
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
⚠️ 重要：TeleBox只使用 lowdb 作为数据库
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
  const text = msg.text || " ";
  const parts = text.trim().split(/\s+/);
  return parts.slice(1); // 跳过命令本身
};
```

### 开发指南

#### 快速开始
1. 创建插件
```typescript
// plugins/myplugin.ts
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getPrefixes } from "@utils/pluginManager";

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
  
  async cleanup(): Promise<void> {
    console.log("[MyPlugin] Cleanup completed");
  }
}

export default new MyPlugin();
```

2. 重载插件
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
```

## 🚀 完整插件示例

### 简单命令插件
```typescript
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getPrefixes } from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

class SimplePlugin extends Plugin {
  description = `📌 简单示例插件
  
使用 ${mainPrefix}ping 和 ${mainPrefix}echo 测试基础功能`;
  
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
      const text = msg.text?.replace(new RegExp(`^${mainPrefix}echo\\s*`, 'i'), "") || "无内容";
      await msg.edit({
        text: `🗣️ <b>回声:</b>\n<code>${text}</code>`,
        parseMode: "html"
      });
    }
  };
  
  async cleanup(): Promise<void> {
    console.log("[SimplePlugin] Cleanup completed");
  }
}

export default new SimplePlugin();
```

### 带资源清理的插件
```typescript
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { cronManager } from "@utils/cronManager";
import { getPrefixes } from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

class MemorySafePlugin extends Plugin {
  name = "memory_safe";
  private timers: NodeJS.Timeout[] = [];
  private cronTaskNames: string[] = [];
  
  description = `✅ <b>内存安全插件示例</b>
  
使用 ${mainPrefix}safe 测试插件功能`;

  cmdHandlers = {
    safe: async (msg: Api.Message) => {
      await msg.edit({
        text: "✅ <b>内存安全插件</b>\n\n所有资源都已正确管理，不会造成内存泄漏。",
        parseMode: "html"
      });
    }
  };
  
  async onLoad(): Promise<void> {
    console.log(`[${this.name}] Loading plugin...`);
    
    // 设置定时器
    const timer = setTimeout(() => {
      console.log(`[${this.name}] Timer executed`);
    }, 5000);
    this.timers.push(timer);
    
    // 设置定时任务
    const cronTaskName = `${this.name}_cleanup`;
    cronManager.set(cronTaskName, '0 */6 * * *', async () => {
      console.log(`[${this.name}] Running periodic cleanup`);
    });
    this.cronTaskNames.push(cronTaskName);
  }
  
  async cleanup(): Promise<void> {
    console.log(`[${this.name}] Starting cleanup process...`);
    const startTime = Date.now();
    
    try {
      // 1. 清理定时器
      for (const timer of this.timers) {
        clearTimeout(timer);
      }
      this.timers = [];
      
      // 2. 清理 cron 任务
      for (const taskName of this.cronTaskNames) {
        cronManager.del(taskName);
      }
      this.cronTaskNames = [];
      
      const duration = Date.now() - startTime;
      console.log(`[${this.name}] Cleanup completed in ${duration}ms`);
    } catch (error) {
      console.error(`[${this.name}] Error during cleanup:`, error);
    }
  }
}

export default new MemorySafePlugin();
```

## 🔧 系统插件说明
TeleBox内置15个系统插件，位于 `src/plugin/` 目录。

### 基础功能插件
- **help** - 帮助系统：显示所有可用命令列表，自动读取插件描述
- **alias** - 命令别名：为命令设置自定义别名，别名数据持久化存储
- **sudo** - 权限管理：管理管理员用户列表，权限验证
- **debug** - 调试工具：获取用户、群组、频道详细信息
- **sure** - 确认操作：危险操作二次确认，防止误操作

### 系统管理插件
- **sysinfo** - 系统信息：显示TeleBox运行状态，CPU、内存、磁盘使用情况
- **update** - 更新管理：从Git拉取最新代码，自动安装依赖
- **bf** - 备份管理：备份TeleBox所有数据，恢复历史备份
- **tpm** - TeleBox插件包管理器：安装、卸载、更新插件包

### 开发工具插件
- **exec** - 命令执行：执行Shell命令，显示命令输出
- **reload** - 热重载：重新加载插件，无需重启TeleBox
- **sendLog** - 日志发送：发送系统日志文件，查看错误日志

### 实用工具插件
- **ping** - 网络测试：测试网络延迟，检测Telegram API连接
- **prefix** - 前缀管理：动态修改命令前缀，查看当前前缀
- **re** - 消息复读：复读回复的消息，转发消息

## 🎯 用户插件示例
`plugins/` 目录包含78个用户插件示例，展示了TeleBox的各种功能实现。

### 插件分类
- 群组管理类：10+ 个插件
- 媒体处理类：15+ 个插件
- 实用工具类：20+ 个插件
- 网络服务类：10+ 个插件
- 娱乐游戏类：10+ 个插件
- 高级功能类：10+ 个插件

### 重要插件示例
- **aban.ts** - 自动封禁管理：自动检测并封禁违规用户，支持关键词过滤
- **image_monitor.ts** - 图片监控：自动监听群组图片，无需命令触发
- **music.ts** - 音乐搜索下载：支持多平台音乐搜索，高品质音乐下载
- **speedtest.ts** - 网速测试：测试服务器网速，支持多个测速节点
- **ssh.ts** - SSH远程管理：远程服务器管理，安全的密钥管理
- **gt.ts** - Google翻译：Google翻译集成，多语言翻译支持

## ⚠️ 重要注意事项

### 代码细节说明
- **拼写特殊性**：`DEFAUTL_PLUGIN_PATH` - 实际代码中是 DEFAUTL 而非 DEFAULT
- **Hook系统状态**：`patchMsgEdit()` 功能当前已注释
- **环境变量默认值**：`TB_CMD_IGNORE_EDITED` 默认为 "true"
- **数据库选择**：只使用 lowdb 作为数据存储
- **代理配置**：config.json 支持 proxy 配置，默认使用 SOCKS5 代理，端口通常为 7877
- **命令名定义**：插件中的命令名必须直接使用字符串字面量，不允许定义为常量

### 开发最佳实践
- **动态获取前缀**：始终使用 `getPrefixes()[0]` 获取主前缀，不要硬编码 "."
- **帮助文本简洁**：避免冗长描述，只提供必要信息
- **资源清理**：每个插件必须正确实现 cleanup() 方法，防止内存泄漏
- **错误处理**：所有异步操作必须包含 try-catch，防止未处理的异常
- **HTML转义**：显示用户输入前必须使用 htmlEscape() 转义
- **注释规范**：使用单行注释，控制数量，只注释关键逻辑
- **命令名定义**：必须直接使用字符串字面量，不允许将命令名定义为常量

### 安全边界
- 命令处理器必须有明确前缀
- 消息监听器需要明确过滤条件，禁止监控所有消息
- 避免触发Telegram风控机制
- 控制定时任务执行频率，避免过度请求