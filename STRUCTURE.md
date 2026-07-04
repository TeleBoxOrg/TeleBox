# TeleBox 项目结构说明

> 用途：快速看懂 TeleBox 的目录结构，方便后续逆向和二开。  
> 路径基准：`C:\Users\user\Desktop\TP AI Agent\TeleBox_reverse\TeleBox`  
> 分支：`feature/TelegramUserbot/Leeching/V1Telebox`  
> commit：`6902a35`

## 1. 顶层结构

```text
TeleBox/
|-- .env-sample              # 环境变量样例
|-- .npmrc                   # npm 配置
|-- .nvmrc                   # Node 版本提示
|-- CHANGELOG.md             # 版本变更记录
|-- INSTALL.md               # 安装指南
|-- LICENSE                  # LGPL-2.1-only
|-- README.md                # 项目介绍
|-- TELEBOX_DEVELOPMENT.md   # 官方开发规范/插件开发文档
|-- LEECH_README.md          # Leech V1 使用说明
|-- LEECH_ARCHITECTURE.md    # Leech V1 架构设计
|-- LEECH_FEATURES.md        # Leech V1 功能解释
|-- package.json             # npm scripts + dependencies
|-- tsconfig.json            # TS 配置，@utils/* alias
|-- scripts/
|   `-- run-tsx.cjs          # 用 tsx 启动 TS 入口
|-- src/
|   |-- index.ts             # 程序入口
|   |-- hook/                # teleproto / Message patch
|   |-- plugin/              # 内置插件
|   `-- utils/               # runtime、插件、DB、日志、格式化工具
|-- plugins/
|   `-- moyu.ts              # 用户插件示例
|-- assets/                  # 运行期数据目录
|-- temp/                    # 临时目录
`-- node_modules/            # 依赖目录；仓库只跟踪 .gitkeep
```

## 2. npm scripts

| script | 命令 | 用途 |
|---|---|---|
| `start` | `node scripts/run-tsx.cjs ./src/index.ts` | 正式启动 |
| `dev` | `NODE_ENV=development node scripts/run-tsx.cjs ./src/index.ts` | 开发模式启动 |
| `tpm` | `node scripts/run-tsx.cjs ./src/plugin/tpm.ts` | 单独运行 TPM 相关入口 |
| `leech:smoke` | `node scripts/run-tsx.cjs ./scripts/leech-smoke.ts` | 本地验证 Leech SQLite/structured log/date range 链路 |

## 3. `src/` 结构

### 3.1 入口与 Hook

| 文件 | 行数 | 说明 |
|---|---:|---|
| `src/index.ts` | 27 | 入口；加载 dotenv/logger/hook；注册全局异常；启动 runtime |
| `src/hook/listen.ts` | 40 | 可选 patch `Message.edit`，当前入口里未启用 `patchMsgEdit()` |
| `src/hook/patches/telegram.patch.ts` | 62 | patch HTMLParser；给 `Api.Message` 增加 `deleteWithDelay`、`safeDelete` |
| `src/hook/types/telegram.d.ts` | 38 | TypeScript module augmentation，声明新增 Message 方法 |
| `scripts/leech-smoke.ts` | 260 | 本地 smoke 测试，不连接 Telegram，覆盖 service 层和插件命令层 |

### 3.2 `src/utils/` 核心工具

| 文件 | 行数 | 主要职责 |
|---|---:|---|
| `src/utils/runtimeManager.ts` | 401 | runtime 状态机、TelegramClient 创建、start/reload/shutdown、generation 管理 |
| `src/utils/generationContext.ts` | 550 | 生命周期容器；追踪 task/timer/listener/child-process；drain/dispose |
| `src/utils/pluginManager.ts` | 596 | 插件扫描、require cache 清理、命令解析、事件注册、cron 注册、reload 入口 |
| `src/utils/pluginBase.ts` | 99 | Plugin 抽象类、插件有效性校验 |
| `src/utils/globalClient.ts` | 9 | 从 runtimeManager 重导出 global client/generation API |
| `src/utils/apiConfig.ts` | 100 | `config.json` 读写、首次 API_ID/API_HASH 输入、保存 session |
| `src/utils/loginManager.ts` | 262 | Telegram 登录：已有 session、QR、手机号、2FA |
| `src/utils/logger.ts` | 398 | console 覆写、日志等级、GramJS 日志降级/限流 |
| `src/utils/cronManager.ts` | 105 | cron 任务注册/删除/清理，接入 GenerationContext |
| `src/utils/pathHelpers.ts` | 38 | 创建 `assets/*`、`temp/*` 子目录 |
| `src/utils/npm_install.ts` | 66 | npm install 包/项目依赖，清理 npm 环境变量后执行 |
| `src/utils/authGuards.ts` | 28 | AUTH_KEY_UNREGISTERED 判断与 safe auth/getMe 包装 |
| `src/utils/safeGetMessages.ts` | 51 | 安全获取消息/回复消息 |
| `src/utils/channelGapBreaker.ts` | 336 | 频道 gap 错误熔断/退避 |
| `src/utils/entityHelpers.ts` | 362 | Telegram entity 解析/重试/取消 |
| `src/utils/conversation.ts` | 277 | 对话等待/取消/超时封装 |
| `src/utils/aliasDB.ts` | 106 | alias SQLite 数据库 |
| `src/utils/sudoDB.ts` | 144 | sudo 用户/群 SQLite 数据库 |
| `src/utils/sureDB.ts` | 192 | sure 用户/群/消息 SQLite 数据库 |
| `src/utils/sendLogDB.ts` | 47 | sendlog 目标配置 SQLite 数据库 |
| `src/utils/telegramFormatter.ts` | 583 | Telegram HTML/实体格式化 |
| `src/utils/telegraphFormatter.ts` | 761 | Telegraph 页面节点格式化 |
| `src/utils/teleboxInfoHelper.ts` | 49 | 读取 app 名、git commit、config appName |
| `src/utils/tlRevive.ts` | 88 | TL/JSON 结构 revive 辅助 |
| `src/utils/banUtils.ts` | 285 | ban/kick 相关 Telegram 工具 |

### 3.2.1 `src/utils/leech/` Leech V1 工具

| 文件 | 主要职责 |
|---|---|
| `src/utils/leech/types.ts` | Leech 类型定义 |
| `src/utils/leech/dateRange.ts` | 日期范围解析，`YYYY-MM-DD` 转 Telegram 秒级时间戳 |
| `src/utils/leech/json.ts` | 安全 JSON 序列化、ID/number 转换 |
| `src/utils/leech/leechDB.ts` | SQLite schema 与 jobs/messages/actions 读写 |
| `src/utils/leech/structuredLogger.ts` | JSON structured log 输出并写入 DB |
| `src/utils/leech/targetResolver.ts` | target 解析：here、@username、数字 ID、t.me link |
| `src/utils/leech/messageSerializer.ts` | Telegram Message 转 SQLite row |
| `src/utils/leech/leechService.ts` | 核心 leech 流程：resolve/fetch/save/log |

### 3.3 `src/plugin/` 内置插件

| 文件 | 行数 | 命令/入口 | 说明 |
|---|---:|---|---|
| `src/plugin/help.ts` | 294 | `help`, `h` | 帮助系统 |
| `src/plugin/alias.ts` | 144 | `alias` | 命令别名 set/del/list |
| `src/plugin/prefix.ts` | 117 | `prefix` | 运行时前缀查看/设置 |
| `src/plugin/sudo.ts` | 282 | `sudo` | sudo 用户/群权限与消息监听代执行 |
| `src/plugin/sure.ts` | 405 | `sure` | sure 白名单/消息规则 |
| `src/plugin/re.ts` | 143 | `re` | 回复复读 |
| `src/plugin/debug.ts` | 754 | `id`, `entity` | 用户/群/频道/message link 解析与调试 |
| `src/plugin/ping.ts` | 467 | `ping` | Telegram API/ICMP/DC 延迟测试 |
| `src/plugin/exec.ts` | 169 | `exec` | 通过 Telegram 执行 shell 命令 |
| `src/plugin/status.ts` | 972 | `status`, `sysinfo` | 系统状态/运行状态 |
| `src/plugin/reload.ts` | 759 | `reload` | 插件/进程重载、内存监控 |
| `src/plugin/update.ts` | 144 | `update` | git 更新 + npm install |
| `src/plugin/tpm.ts` | 1439 | `tpm` | 远程插件安装/卸载/搜索 |
| `src/plugin/bf.ts` | 720 | `bf`, `hf` | 备份/恢复 plugins + assets |
| `src/plugin/sendLog.ts` | 257 | `sendlog`, `logs`, `log` | 发送日志文件 |
| `src/plugin/loglevel.ts` | 98 | `loglevel` | 调整日志等级 |
| `src/plugin/leech.ts` | 303 | `leech` | Leech V1：session 检查、按日期抓消息、保存 SQLite |

### 3.4 `plugins/` 用户插件

| 文件 | 行数 | 命令 | 说明 |
|---|---:|---|---|
| `plugins/moyu.ts` | 51 | `moyu` | 从外部 API 下载图片，用 `CustomFile` 上传到 Telegram |

## 4. 运行期目录约定

| 目录 | 用途 | 建议 |
|---|---|---|
| `assets/` | 长期数据、SQLite、JSON config、插件缓存 | 二开新增功能配置放 `assets/<feature>/` |
| `temp/` | 临时下载/解压/生成文件 | leech 下载临时文件放 `temp/leech/` |
| `plugins/` | 用户插件 | 快速试验新功能先放这里 |
| `src/plugin/` | 内置插件 | 稳定功能再迁入这里 |
| `node_modules/` | npm dependencies | 不提交内容 |

## 5. Tracked 文件清单

```text
.env-sample
.gitignore
.npmrc
.nvmrc
CHANGELOG.md
INSTALL.md
LEECH_ARCHITECTURE.md
LEECH_FEATURES.md
LEECH_README.md
LICENSE
README.md
TELEBOX_DEVELOPMENT.md
assets/.gitkeep
node_modules/.gitkeep
package.json
plugins/.gitkeep
plugins/moyu.ts
scripts/leech-smoke.ts
scripts/run-tsx.cjs
src/hook/listen.ts
src/hook/patches/telegram.patch.ts
src/hook/types/telegram.d.ts
src/index.ts
src/plugin/alias.ts
src/plugin/bf.ts
src/plugin/debug.ts
src/plugin/exec.ts
src/plugin/help.ts
src/plugin/leech.ts
src/plugin/loglevel.ts
src/plugin/ping.ts
src/plugin/prefix.ts
src/plugin/re.ts
src/plugin/reload.ts
src/plugin/sendLog.ts
src/plugin/status.ts
src/plugin/sudo.ts
src/plugin/sure.ts
src/plugin/tpm.ts
src/plugin/update.ts
src/utils/aliasDB.ts
src/utils/apiConfig.ts
src/utils/authGuards.ts
src/utils/banUtils.ts
src/utils/channelGapBreaker.ts
src/utils/conversation.ts
src/utils/cronManager.ts
src/utils/entityHelpers.ts
src/utils/generationContext.ts
src/utils/globalClient.ts
src/utils/leech/dateRange.ts
src/utils/leech/json.ts
src/utils/leech/leechDB.ts
src/utils/leech/leechService.ts
src/utils/leech/messageSerializer.ts
src/utils/leech/structuredLogger.ts
src/utils/leech/targetResolver.ts
src/utils/leech/types.ts
src/utils/logger.ts
src/utils/loginManager.ts
src/utils/npm_install.ts
src/utils/pathHelpers.ts
src/utils/pluginBase.ts
src/utils/pluginManager.ts
src/utils/runtimeManager.ts
src/utils/safeGetMessages.ts
src/utils/sendLogDB.ts
src/utils/sudoDB.ts
src/utils/sureDB.ts
src/utils/teleboxInfoHelper.ts
src/utils/telegramFormatter.ts
src/utils/telegraphFormatter.ts
src/utils/tlRevive.ts
telebox.png
temp/.gitkeep
tsconfig.json
```

## 6. 二开提交范围建议

建议在 `feature/TelegramUserbot/Leeching/V1Telebox` 中先只提交文档和自己的新增插件/工具，不要提交：

- `config.json`
- `.env`
- `assets/**/*.db`
- `assets/**/config.json`（除非是样例）
- `temp/**`
- `node_modules/**`

如果开始做 V1 leech，建议第一批文件：

```text
plugins/leech.ts
plugins/leech/lib/leechTypes.ts
plugins/leech/lib/leechQueue.ts
plugins/leech/lib/leechDB.ts
plugins/leech/lib/httpDownloader.ts
plugins/leech/lib/telegramUploader.ts
```
