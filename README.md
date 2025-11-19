<div align="center">

# 🚀 TeleBox

[![License](https://img.shields.io/badge/License-LGPL%202.1-blue.svg?style=for-the-badge)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-green.svg?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.2-blue.svg?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![Version](https://img.shields.io/badge/Version-0.2.6-orange.svg?style=for-the-badge)](CHANGELOG.md)

**现代化 Telegram Bot 开发框架**

_基于 Node.js 和 TypeScript 构建，提供强大的插件系统和丰富的功能模块_

[📖 快速开始](#-快速开始) • [🔌 插件生态](#-插件生态) • [🛠️ 开发指南](https://github.com/TeleBoxOrg/TeleBox/blob/main/TELEBOX_DEVELOPMENT.md) • [📚 文档](#-相关链接)

</div>

---

## ✨ 核心特性

<table>
<tr>
<td width="33%">

### 📦 **模块化插件架构**

🔄 **动态插件加载**  
支持热重载，无需重启即可更新插件

🏷️ **命令别名系统**  
灵活的命令重定向和自定义别名

🎯 **多命令支持**  
单个插件可注册多个命令和子命令

👂 **消息监听器**  
支持全局消息监听和事件处理

</td>
<td width="33%">

### 🔧 **内置功能模块**

⚙️ **系统管理**  
进程管理、系统信息监控、日志查看

🛡️ **权限控制**  
sudo 权限分配和用户管理

🌐 **远程插件**  
在线插件商店，一键安装/卸载

💻 **Shell 执行**  
安全的命令行执行环境

🔍 **信息查询**  
用户、群组、频道详细信息获取

</td>
<td width="33%">

### ⚡ **高性能设计**

🔒 **TypeScript**  
类型安全，开发体验优秀

🚀 **异步架构**  
基于 Promise 的非阻塞设计

🛠️ **错误处理**  
完善的异常捕获和恢复机制

💾 **内存优化**  
智能缓存和资源管理

</td>
</tr>
</table>

## 🏗️ 项目结构

<details>
<summary><b>📁 点击展开项目结构</b></summary>

```
📦 TeleBox/
├── 🎯 src/                     # 核心源代码
│   ├── 🚪 index.ts            # 应用入口点
│   ├── 🔌 plugin/             # 内置插件目录
│   │   ├── 📖 help.ts         # 帮助系统
│   │   ├── 📦 tpm.ts          # 插件管理器
│   │   ├── 🆔 id.ts           # 信息查询
│   │   ├── 👑 sudo.ts         # 权限管理
│   │   ├── 💻 exec.ts         # Shell 执行
│   │   ├── 🏓 ping.ts         # 网络测试
│   │   ├── 📊 sysinfo.ts      # 系统信息
│   │   └── 🔧 ...             # 其他内置插件
│   └── 🛠️ utils/              # 工具库
│       ├── ⚙️ pluginManager.ts     # 插件管理核心
│       ├── 🔗 entityHelpers.ts     # Telegram 实体处理
│       ├── 🔐 loginManager.ts      # 登录管理
│       ├── 💬 conversation.ts      # 对话管理
│       └── 🧰 ...                  # 其他工具
├── 🔌 plugins/                # 用户插件目录
├── 📁 assets/                 # 静态资源
├── 💾 my_session/             # 会话文件
├── 📂 temp/                   # 临时文件
├── ⚙️ package.json            # 项目配置
├── 📝 tsconfig.json           # TypeScript 配置
└── 📋 INSTALL.md              # 安装文档
```

</details>

## 🧩 核心组件

<div align="center">

### 🔧 **插件系统架构**

</div>

```typescript
// 🎨 现代化的插件抽象类设计
abstract class Plugin {
  // 📝 必需属性 - 插件描述（支持动态生成）
  abstract description:
    | string
    | ((...args: any[]) => string | void)
    | ((...args: any[]) => Promise<string | void>);
    
  // ⚡ 必需属性 - 命令处理器映射表
  abstract cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  >;
  
  // 👂 可选属性 - 消息监听器
  listenMessageHandler?: (msg: Api.Message) => Promise<void>;
  
  // 🎯 可选属性 - 事件处理器
  eventHandlers?: Array<{
    event?: any;
    handler: (event: any) => Promise<void>;
  }>;
  
  // ⏰ 可选属性 - 定时任务
  cronTasks?: Record<string, {
    cron: string;
    description: string;
    handler: (client: TelegramClient) => Promise<void>;
  }>;
}

// 💡 trigger 参数说明：
// 用于 sudo 用户权限传递，如 eat 插件获取 sudo 用户头像
// 示例：.sudo eat @target -> trigger 为 sudo 用户的消息
```

<table>
<tr>
<td width="50%">

### 🎮 **命令系统**

🔤 **多前缀支持**  
支持 `.` `。` `$` 等多种命令前缀

🧪 **开发模式**  
开发环境使用 `!` `！` 前缀

🧠 **智能解析**  
自动识别命令和参数

💬 **错误处理**  
友好的错误提示和帮助信息

</td>
<td width="50%">

### 🛡️ **权限管理**

👑 **sudo 系统**  
分级权限控制

📋 **用户白名单**  
灵活的访问控制

🔒 **安全执行**  
受限的 shell 命令执行

🔐 **会话管理**  
安全的登录和认证机制

</td>
</tr>
</table>

## 🔌 插件生态

### 🎯 **内置插件**

<table>
<thead>
<tr>
<th width="15%">🔌 插件</th>
<th width="25%">⌨️ 命令</th>
<th width="60%">📋 功能描述</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>📖 help</strong></td>
<td><code>h</code>, <code>help</code></td>
<td>🎯 帮助系统和命令列表</td>
</tr>
<tr>
<td><strong>📦 tpm</strong></td>
<td><code>tpm</code></td>
<td>🔧 插件管理器（安装/卸载/搜索）</td>
</tr>
<tr>
<td><strong>🛠️ debug</strong></td>
<td><code>id</code>, <code>entity</code>, <code>msg</code>, <code>echo</code></td>
<td>🔍 调试工具：获取用户/群组/频道详细信息</td>
</tr>
<tr>
<td><strong>👑 sudo</strong></td>
<td><code>sudo</code></td>
<td>🛡️ 权限管理和用户授权</td>
</tr>
<tr>
<td><strong>💻 exec</strong></td>
<td><code>exec</code></td>
<td>🔒 安全的 Shell 命令执行</td>
</tr>
<tr>
<td><strong>🏓 ping</strong></td>
<td><code>ping</code></td>
<td>🌐 网络延迟测试工具</td>
</tr>
<tr>
<td><strong>📊 sysinfo</strong></td>
<td><code>sysinfo</code></td>
<td>📈 系统信息监控</td>
</tr>
<tr>
<td><strong>🏷️ alias</strong></td>
<td><code>alias</code></td>
<td>🔄 命令别名管理</td>
</tr>
<tr>
<td><strong>🔄 update</strong></td>
<td><code>update</code></td>
<td>⬆️ 系统更新管理</td>
</tr>
<tr>
<td><strong>📦 bf</strong></td>
<td><code>bf</code></td>
<td>💾 数据备份工具</td>
</tr>
<tr>
<td><strong>🔄 reload</strong></td>
<td><code>reload</code>, <code>exit</code></td>
<td>♻️ 插件重新加载和进程管理</td>
</tr>
<tr>
<td><strong>📜 sendlog</strong></td>
<td><code>sendlog</code>, <code>logs</code>, <code>log</code></td>
<td>📤 日志文件发送工具</td>
</tr>
<tr>
<td><strong>🔁 re</strong></td>
<td><code>re</code></td>
<td>🗣️ 消息复读工具</td>
</tr>
<tr>
<td><strong>✅ sure</strong></td>
<td><code>sure</code></td>
<td>🤔 确认操作工具</td>
</tr>
</tbody>
</table>

### 🌟 **扩展插件**

<div align="center">

🎪 **丰富的插件生态系统**

</div>

> 🔍 **查看可用插件** → `.tpm search` / `.tpm s`  
> 📥 **安装插件** → `.tpm install <插件名>` / `.tpm i <插件名>`  
> 📦 **批量安装** → `.tpm i <插件1> <插件2> <插件3>`  
> 🌟 **一键安装全部** → `.tpm i all`  
> 📁 **从文件安装** → 回复文件 + `.tpm install`  
> 🗑️ **卸载插件** → `.tpm remove <插件名>` / `.tpm rm <插件名>`  
> 🗂️ **批量卸载** → `.tpm rm <插件1> <插件2> <插件3>`  
> 🔄 **一键更新全部** → `.tpm update` / `.tpm ua`  
> 📋 **查看已安装** → `.tpm list` / `.tpm ls`  
> 📊 **详细列表** → `.tpm list -v` / `.tpm lv`  
> 📤 **上传插件** → `.tpm upload <插件名>` / `.tpm ul <插件名>`

<div align="center">

[![Plugin Repository](https://img.shields.io/badge/🔌_插件仓库-TeleBox__Plugins-blue?style=for-the-badge)](https://github.com/TeleBoxDev/TeleBox_Plugins)

</div>

## 🛠️ 技术栈

<div align="center">

|  🏗️ **技术领域**   |   🔧 **技术选型**    | 📊 **版本** |
| :----------------: | :------------------: | :---------: |
|   🚀 **运行时**    |       Node.js        |   `20.19.4`    |
|  💎 **开发语言**   |      TypeScript      |   `5.9.2`   |
| 📡 **Telegram 库** |        GramJS        |  `2.26.22`  |
|   💾 **数据库**    |    better-sqlite3    |  `12.2.0`   |
|   💾 **数据库**    |        lowdb         |   `7.0.1`   |
|  ⚡ **构建工具**   | tsx + tsconfig-paths |  `latest`   |
| 🌐 **HTTP 客户端** |        axios         |  `1.11.0`   |
|  🖼️ **图像处理**   |        sharp         |  `0.34.3`   |
|   🧰 **工具库**    |        lodash        |  `4.17.21`  |
|  ⏰ **任务调度**   |         cron         |   `4.3.3`   |

</div>

## 🚀 快速开始

<div align="center">

### 📥 **安装部署**

[![安装指南](https://img.shields.io/badge/📋_完整安装指南-点击查看-green?style=for-the-badge)](https://github.com/TeleBoxDev/TeleBox/blob/main/INSTALL.md)

</div>

### 💡 **基本命令**

<table>
<tr>
<td width="50%">

**🔍 信息查询**

```bash
.help                    # 📖 查看所有命令
.help <命令>             # 📝 查看特定命令帮助
.id                      # 🆔 获取当前聊天信息
```

</td>
<td width="50%">

**🔧 插件管理**

```bash
.tpm search              # 🔍 查看远程插件列表
.tpm i <插件名>          # 📥 安装插件
.sudo add <用户>         # 👑 添加 sudo 权限
```

</td>
</tr>
</table>

### 🧪 **开发模式**

<div align="center">

```bash
# 🚀 启动开发模式
NODE_ENV=development tpm run dev
```

💡 _开发模式下使用_ `!` _和_ `！` _作为命令前缀_

</div>

## 📚 相关链接

<div align="center">

<table>
<tr>
<td align="center" width="20%">

[![主仓库](https://img.shields.io/badge/📦_主仓库-TeleBox-blue?style=for-the-badge&logo=github)](https://github.com/TeleBoxDev/TeleBox)

</td>
<td align="center" width="20%">

[![插件仓库](https://img.shields.io/badge/🔌_插件仓库-TeleBox__Plugins-green?style=for-the-badge&logo=github)](https://github.com/TeleBoxDev/TeleBox_Plugins)

</td>
<td align="center" width="20%">

[![安装指南](https://img.shields.io/badge/📋_安装指南-INSTALL.md-orange?style=for-the-badge)](https://github.com/TeleBoxDev/TeleBox/blob/main/INSTALL.md)

</td>
<td align="center" width="20%">

[![更新日志](https://img.shields.io/badge/📝_更新日志-CHANGELOG.md-purple?style=for-the-badge)](CHANGELOG.md)

</td>
<td align="center" width="20%">

[![问题反馈](https://img.shields.io/badge/🆘_问题反馈-Issues-red?style=for-the-badge&logo=github)](https://github.com/TeleBoxDev/TeleBox/issues)

</td>
</tr>
</table>

</div>

<div align="center">

## 📄 许可证

[![LGPL-2.1](https://img.shields.io/badge/License-LGPL--2.1-blue?style=for-the-badge)](LICENSE)

本项目采用 **LGPL-2.1** 许可证开源

---

### 🎯 **TeleBox**

_让 Telegram Bot 开发更简单、更强大_

<sub>Made with ❤️ by TeleBox Team</sub>

</div>
