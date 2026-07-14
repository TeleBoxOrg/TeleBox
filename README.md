<div align="center">

# 🚀 TeleBox

[![License](https://img.shields.io/badge/License-LGPL%202.1-blue.svg?style=for-the-badge)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24.x-green.svg?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.2-blue.svg?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![Version](https://img.shields.io/badge/Version-0.2.8-orange.svg?style=for-the-badge)](CHANGELOG.md)

**稳定可靠的 Telegram UserBot 框架**

_TypeScript 全栈 · 插件热加载 · 一键扩展 · 可与 TeleBox-Next 无缝切换_

[📖 快速开始](#-快速开始) · [🔌 插件生态](#-插件生态) · [🛠️ 开发指南](https://github.com/TeleBoxOrg/TeleBox/blob/main/TELEBOX_DEVELOPMENT.md) · [📋 安装](https://github.com/TeleBoxOrg/TeleBox/blob/main/INSTALL.md)

</div>

---

## ✨ 为什么选择 TeleBox

<table>
<tr>
<td width="33%">

### 📦 **插件即扩展**

🔄 **动态加载**  
安装、卸载、更新插件，按需热重载

🏷️ **别名系统**  
把常用命令映射成你习惯的短指令

👂 **消息 / 事件监听**  
不只是命令：可做自动回复、统计、定时任务

</td>
<td width="33%">

### 🛡️ **开箱即用**

🌐 **远程插件商店**  
`.tpm` 一键搜索 / 安装 / 批量更新

👑 **权限体系**  
sudo / sure，把能力安全分享给协作者

🔀 **版本切换**  
`.switch go` 在 Classic 与 Next 之间直切，会话与插件配置一并迁移

</td>
<td width="33%">

### ⚡ **生产就绪**

♻️ **Generation 生命周期**  
重载可中止、可清理，避免资源泄漏

⬆️ **自动更新**  
主仓 + 插件可自动拉取，重启后补齐状态

🔧 **一键修复**  
`.autofix`：清重名插件 → 硬同步代码 → 重启 → 更新插件

</td>
</tr>
</table>

## 🏗️ 项目结构

<details>
<summary><b>📁 点击展开项目结构</b></summary>

```
📦 TeleBox/
├── 🎯 src/
│   ├── 🚪 index.ts              # 入口
│   ├── 🔌 plugin/               # 内置系统插件（22 个）
│   │   ├── help.ts · tpm.ts · update.ts · switch.ts · autofix.ts
│   │   ├── status.ts · ping.ts · reload.ts · exec.ts · sudo.ts
│   │   └── …
│   ├── 🛠️ utils/                # 运行时 / 插件管理 / 会话 / 日志
│   └── 🪝 hook/                 # 客户端补丁与类型增强
├── 🔌 plugins/                  # 用户插件目录（.tpm 安装到这里）
├── 📁 assets/                   # 运行时数据与资源
├── 📂 temp/ · logs/
├── ⚙️ package.json · tsconfig.json
└── 📋 INSTALL.md · TELEBOX_DEVELOPMENT.md
```

</details>

## 🧩 插件抽象（开发者）

```typescript
abstract class Plugin {
  abstract description:
    | string
    | ((...args: any[]) => string | void)
    | ((...args: any[]) => Promise<string | void>);

  abstract cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  >;

  listenMessageHandler?: (msg: Api.Message) => Promise<void>;
  eventHandlers?: Array<{ event?: any; handler: (event: any) => Promise<void> }>;
  cronTasks?: Record<string, {
    cron: string;
    description: string;
    handler: (client: TelegramClient) => Promise<void>;
  }>;
}
```

> 默认命令前缀：`.` `。` `$` · 开发模式（`npm run dev`）：`!` `！`  
> 完整规范见 [TELEBOX_DEVELOPMENT.md](https://github.com/TeleBoxOrg/TeleBox/blob/main/TELEBOX_DEVELOPMENT.md)

## 🔌 插件生态

### 🎯 内置插件

<table>
<thead>
<tr>
<th width="14%">插件</th>
<th width="28%">命令</th>
<th width="58%">说明</th>
</tr>
</thead>
<tbody>
<tr><td><strong>help</strong></td><td><code>help</code>, <code>h</code></td><td>帮助与命令列表</td></tr>
<tr><td><strong>tpm</strong></td><td><code>tpm</code></td><td>插件管理器：搜索 / 安装 / 卸载 / 更新 / 上传</td></tr>
<tr><td><strong>update</strong></td><td><code>update</code></td><td>拉取主仓最新代码并安装依赖</td></tr>
<tr><td><strong>switch</strong></td><td><code>switch</code></td><td>Classic ↔ Next 版本切换（会话转换 + 配置迁移）</td></tr>
<tr><td><strong>autofix</strong></td><td><code>autofix</code></td><td>一键修复：清重名插件 → 硬同步 → 重启 → 更新插件</td></tr>
<tr><td><strong>reload</strong></td><td><code>reload</code>, <code>exit</code>, <code>restart</code>, <code>health</code>, <code>memory</code>…</td><td>重载 / 退出 / 健康与内存检查</td></tr>
<tr><td><strong>status</strong></td><td><code>status</code>, <code>sysinfo</code></td><td>运行状态与系统信息</td></tr>
<tr><td><strong>version</strong></td><td><code>version</code>, <code>ver</code></td><td>版本号与更新状态</td></tr>
<tr><td><strong>ping</strong></td><td><code>ping</code></td><td>API / 目标 / DC 延迟探测（TCP 优先）</td></tr>
<tr><td><strong>debug</strong></td><td><code>id</code>, <code>entity</code>, <code>msg</code>, <code>echo</code></td><td>对话 / 实体 / 消息调试</td></tr>
<tr><td><strong>sudo</strong></td><td><code>sudo</code></td><td>管理员授权</td></tr>
<tr><td><strong>sure</strong></td><td><code>sure</code></td><td>授权他人以 bot 身份发送（支持重定向）</td></tr>
<tr><td><strong>exec</strong></td><td><code>exec</code></td><td>安全执行 Shell 命令</td></tr>
<tr><td><strong>alias</strong></td><td><code>alias</code></td><td>命令别名 / 重命名</td></tr>
<tr><td><strong>prefix</strong></td><td><code>prefix</code></td><td>命令前缀管理</td></tr>
<tr><td><strong>bf</strong></td><td><code>bf</code>, <code>hf</code></td><td>备份工具</td></tr>
<tr><td><strong>sendlog</strong></td><td><code>sendlog</code>, <code>logs</code>, <code>log</code></td><td>发送日志文件</td></tr>
<tr><td><strong>loglevel</strong></td><td><code>loglevel</code></td><td>日志级别</td></tr>
<tr><td><strong>re</strong></td><td><code>re</code></td><td>消息复读</td></tr>
<tr><td><strong>save</strong></td><td><code>save</code></td><td>会话 / 配置保存相关</td></tr>
<tr><td><strong>leech</strong></td><td><code>leech</code></td><td>历史消息抓取与归档</td></tr>
<tr><td><strong>agent</strong></td><td><code>agent</code></td><td>内置 Agent 能力</td></tr>
</tbody>
</table>

### 🌟 扩展插件

官方插件仓库提供 100+ 社区插件，安装、更新、卸载都走 TPM：

| 操作 | 命令 |
|------|------|
| 搜索 | `.tpm search` / `.tpm s` |
| 安装 | `.tpm i <名>` · `.tpm i a b c` · `.tpm i all` |
| 从文件装 | 回复 `.ts` 文件 + `.tpm install` |
| 卸载 | `.tpm rm <名>` · `.tpm rm all` |
| 更新 | `.tpm update` / `.tpm ua` |
| 列表 | `.tpm ls` · `.tpm lv` |
| 上传 | `.tpm ul <名>` |

<div align="center">

[![Plugin Repository](https://img.shields.io/badge/🔌_插件仓库-TeleBox--Plugins-blue?style=for-the-badge)](https://github.com/TeleBoxOrg/TeleBox-Plugins)

</div>

## 🛠️ 技术栈

| 领域 | 选型 | 版本 |
|:----:|:----:|:----:|
| 运行时 | Node.js | `24.x` |
| 语言 | TypeScript | `^5.9.2` |
| Telegram | Teleproto | `^1.228.1` |
| 数据库 | better-sqlite3 · lowdb | `^12.2.0` · `^7.0.1` |
| 运行 | tsx | `^4.22.4` |
| HTTP / 图像 / 工具 | axios · sharp · lodash · cron | 见 `package.json` |

## 🚀 快速开始

<div align="center">

[![安装指南](https://img.shields.io/badge/📋_完整安装指南-INSTALL.md-green?style=for-the-badge)](https://github.com/TeleBoxOrg/TeleBox/blob/main/INSTALL.md)

</div>

```bash
git clone https://github.com/TeleBoxOrg/TeleBox.git ~/telebox
cd ~/telebox && npm install && npm start
# 生产环境建议：pm2 start "npm start" --name telebox
```

### 常用命令

| 场景 | 示例 |
|------|------|
| 帮助 | `.help` · `.help tpm` |
| 装插件 | `.tpm i weather` |
| 查延迟 | `.ping` · `.ping 1.1.1.1` |
| 系统状态 | `.status` |
| 更新主仓 | `.update` |
| 切到 Next | `.switch go` |
| 一键修复 | `.autofix` |

```bash
npm run dev   # 开发模式，前缀改为 ! / ！
```

## 🔗 相关链接

| | |
|:--:|:--:|
| [![TeleBox](https://img.shields.io/badge/📦_TeleBox-Classic-blue?style=for-the-badge&logo=github)](https://github.com/TeleBoxOrg/TeleBox) | [![TeleBox-Next](https://img.shields.io/badge/📦_TeleBox--Next-blue?style=for-the-badge&logo=github)](https://github.com/TeleBoxOrg/TeleBox-Next) |
| [![Plugins](https://img.shields.io/badge/🔌_TeleBox--Plugins-green?style=for-the-badge&logo=github)](https://github.com/TeleBoxOrg/TeleBox-Plugins) | [![Issues](https://img.shields.io/badge/🆘_Issues-red?style=for-the-badge&logo=github)](https://github.com/TeleBoxOrg/TeleBox/issues) |

<div align="center">

## 📄 许可证

[![LGPL-2.1](https://img.shields.io/badge/License-LGPL--2.1-blue?style=for-the-badge)](LICENSE)

本项目采用 **LGPL-2.1** 开源

---

**TeleBox** — 把 Telegram UserBot 做成可维护的工程

<sub>Made with ❤️ by TeleBox Team</sub>

</div>
