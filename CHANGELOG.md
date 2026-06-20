# Changelog

## [0.2.8] - 2026-06-07

> **版本类型**：次要版本升级  
> **开发周期**：2026-01-08 至 2026-06-07（199 次提交）  
> **上一版本**：v0.2.7（2026-01-07）

---

## 🎯 重大变更（Breaking Changes）

### 1. 插件热重载机制变更
- **变更内容**：插件更新和重载操作现在触发完整的进程退出和重启，而非内存软重载
- **影响范围**：依赖 PM2 或其他进程管理器才能自动重启
- **相关提交**：
  - `feat(update): use process exit instead of soft reload after update`
  - `feat(tpm): use process exit instead of soft reload after update`
- **迁移建议**：确保使用 PM2 管理 TeleBox 进程，或配置其他进程监控方案

### 2. GenerationContext 生命周期系统引入
- **变更内容**：所有插件和运行时组件现在受 `GenerationContext` 管理，支持优雅的资源清理和中止信号
- **影响范围**：插件开发者需要适配新的生命周期钩子（`setup()`、`cleanup()`、`dispose()`）
- **技术亮点**：
  - 基于 AbortSignal 的统一中止机制
  - 三阶段生命周期：abort → drain → dispose
  - 防止内存泄漏和资源悬挂

### 3. Teleproto 1.225 升级
- **变更内容**：底层 Telegram 客户端库从 1.224.1 升级至 1.225.3
- **影响范围**：`updateManager` 内部结构变化，`fetchChannelDifference` 格式调整

---

## 🚀 核心架构改进

### GenerationContext 生命周期系统（2026-05-10）
**技术背景**：解决插件重载时的内存泄漏和资源未清理问题

#### 核心实现
- 提供统一的 AbortSignal 和资源跟踪机制
- 支持异步任务的自动取消和等待队列排空

#### 系统集成
- **运行时管理器**：集成 GenerationContext，实现 abort-drain-dispose 模型
- **插件管理器**：集成到插件生命周期管理
- **定时任务管理**：支持每代任务追踪
- **全局客户端**：所有网络请求可中止
- **登录管理器**：轮询和提示支持中止信号
- **对话等待机制**：等待操作可通过 signal 中止
- **实体辅助函数**：重试和退避支持中止

#### 插件适配
- **PluginBase 增强**：新增 GenerationContext 感知的生命周期钩子
- **备份插件**：子进程和等待绑定到 GenerationContext
- **Exec 插件**：Shell 子进程和定时器绑定到 GenerationContext
- **TPM 插件**：重试退避和节流支持生命周期

#### 插件清理优化
批量移除空 `cleanup()` 覆盖方法（由 PluginBase 统一处理）：
- 涉及插件：alias, debug, help, loglevel, ping, prefix, re, sendLog, tpm

#### 诊断工具
- 新增生命周期状态查询命令
- 提供压力测试工具用于验证资源释放

---

## 🛡️ 稳定性与可靠性

### Channel Gap Circuit Breaker（2026-05-18 至 05-27）
**问题背景**：部分频道的 `pts` 差异过大导致 Telegram 更新队列阻塞，影响其他频道消息接收

#### 核心机制
- 检测 `PERSISTENT_TIMESTAMP_OUTDATED` 和 `HISTORY_GET_FAILED` 错误
- 自动断开问题频道，保护全局更新流

#### 迭代优化
- 对反复触发的频道实施指数退避
- 跨重载保持退避状态
- 降低熔断阈值（3→2），提高响应速度
- 适配 Teleproto 1.225 新格式
- 识别 Constructor schema 不同步问题

### 日志系统优化
#### 日志降级与限流
- 将频道更新错误从 ERROR 降级为 WARN，减少噪音
- 每个频道 5 分钟内仅记录一次降级日志
- 降级日志输出到 stdout 而非 stderr

#### 全局错误处理
- 新增全局 `uncaughtException` 和 `unhandledRejection` 处理器
- 从 Error 对象提取消息进行降级过滤
- 拦截 console.log 中的 PERSISTENT_TIMESTAMP_OUTDATED
- 防止 GramJS 级别覆盖取消日志降级

### 安全消息操作
防止因 Telegram API 限制导致的崩溃：

- 新增安全 getMessages 包装器
- 导出安全回复消息辅助函数
- **批量应用**：`bf`, `debug`, `re`, `status`, `sudo`, `sure`, `tpm` 插件全部采用安全消息查询
- 保护回复查找和历史获取操作

### 运行时稳定性修复
- 防止重载操作陷入 15 秒死锁
- 插件加载失败时保持运行时存活
- 修复 msg.edit() 崩溃防护
- 修复生命周期 bugs 阻塞插件重载
- 保护未注册会话的自检
- 恢复未注册授权密钥的登录

### 自动健康检查
- 多次自动健康检查修复（20260530-2049, 20260516-2207）

---

## 🔌 插件系统增强

### TPM（TeleBox Plugin Manager）改进
#### 安装与状态管理
- 防止动态内容破坏 HTML 格式
- 优化消息分页显示
- 调整搜索安装状态判断与命令提示
- 插件备份使用 .bak 后缀
- 修复拉取插件 429 错误
- 提高 Entities 上限

#### 重载后消息更新修复
- 所有命令使用新客户端编辑最终状态
- 修复重载后无法更新消息问题

### 插件资源清理规范
- 完善插件 cleanup 资源释放规范
- 为备份与重载插件补充资源清理逻辑
- 统一轻量插件 cleanup 实现
- 排除 logger 和 channelGapBreaker 不被缓存清除
- 隔离插件设置失败，添加生命周期回退

### Alias 插件重构
- 支持多词别名与原命令解析优化
- 新增原命令别名唯一性逻辑
- 完善多词别名解析与命令重写机制

### Re 插件修复
- 修复非话题群组意外获取 reply chain 首条消息
- 统一消息删除为始终撤回
- 私聊中撤回命令删除

### 其他插件功能
- **SendLog**：包含 PM2 默认日志路径、修复模板字符串插值
- **Status**：支持进度条、自定义格式、展示当前模板、规范化标签示例
- **Sure**：使用安全回复查找、保留话题根
- **Sudo**：使用安全回复查找、保留话题根
- **Ping**：转义 IP/域名占位符
- **Help**：格式化问题修复、HTML 格式支持

---

## 📝 文档与开发体验

### 文档全面更新（2026-06-07）
- 全面文档改进和不一致性修复
- 更新 Node.js 版本和项目链接
- 优化 INSTALL.md 格式与步骤说明
- 完善 help 文案编写规范
- 将 GramJS 替换为 Teleproto
- 补充插件开发规范

### 安装说明改进
- 简化安装说明，移除风险命令
- 添加 PM2 一键命令说明
- 补充 API 凭据信息
- 移除冗余介绍章节
- 修复 PM2 启动命令

### 开发规范
- 统一重载/更新/退出成功消息格式
- 重启前显示"正在重启进程"
- 始终显示毫秒级耗时

---

## 🛠️ 依赖与环境

### Node.js 版本升级
- 更新 .nvmrc 到 Node.js 24.x
- 添加 engines.node 到 package.json
- run-tsx.cjs 在 Node.js 22+ 应用 --localstorage-file 标志

### 依赖更新
- **重大升级**：
  - `teleproto`: 1.225.4 → 1.227.0
  - `axios`: 1.15.2 → 1.16.1
  - `better-sqlite3`: 12.9.0 → 12.10.0
  - `tsx`: 4.21.0 → 4.22.3
  - `opencc-js`: 1.3.0 → 1.3.1
  - `@types/node`: 24.12.2 → 24.12.4

- **新增依赖**：
  - `node-schedule`（定时任务）
  - `cheerio`（HTML 解析）
  - `@modelcontextprotocol/sdk`（MCP 协议）
  - `glob`（文件匹配）

- **锁文件维护**：
  - 为 Node.js 24 刷新 package-lock.json
  - 多次依赖更新

### 构建与配置
- 配置 TypeScript 输出目录
- 排除 temp 文件不参与 TypeScript 构建
- 收紧 .gitignore 规则
- 忽略 package-lock.json 和本地 ecosystem 配置
- 跟踪可移植 ecosystem 配置

---

## 🎨 格式化与解析增强

### Telegram 格式化工具
- 添加 Telegram 文本格式化工具
- 增强引用、列表与行内解析
- 适配 Bot API HTML 限制并增强块级语义
- 优化 HTML 转义与 URL 安全处理
- 清理不支持的 `<cite>` 标签

### Telegraph 格式化工具
- 添加 Telegraph 文本格式化工具
- 实现接近 CommonMark 的 Markdown → Telegraph 语义解析

### 状态反馈增强
- 新增状态反馈机制
- 修复渲染问题

---

## 🔧 内部优化与重构

### 运行时管理器重构（2026-04-01）
- 新增可重建运行时管理器
- 全局客户端走运行时管理
- 拆分登录初始化流程
- 按运行时重载插件绑定
- 清理对话等待的旧运行时监听
- 通过运行时启动入口初始化
- 优化重载与内存管理体验

### 内存泄漏修复
- 彻底修复内存泄露并更新上游
- 内存泄露修复静默模式
- reload 插件的内存泄露修复 patch
- 采用更稳健的 leak fix 设计

### HTML 转义与安全
- Teleproto 解析器中解码 HTML 实体
- 帮助文本中使用 HTML 实体替换全角尖括号
- 批量修复插件 HTML 转义问题

### 版本显示改进
- 添加共享显示版本格式化器
- help 和 status 使用格式化的 TeleBox 显示版本

### Update 命令增强
- 自动检测 git remote 和分支，支持任意安装方式
- 拉取 TeleBoxOrg 仓库代码修复分叉分支问题
- 使用 reloadRuntime 进行生命周期感知重载

### Reload 命令优化
- 使用局部变量替换实例状态以保证代安全
- 直接解析退出消息聊天

### 编译器与类型修复
- 修复多处编译器报错问题
- 修复在插件中调用 loadPlugins 报 runtime not initialized 错误

### 配置清理
- 移除预设 PM2 ecosystem 配置
- 移除 reloadRuntime 中的冗余 abort 调用
- 清理未使用的导入

---

## 📊 统计摘要

- **总提交数**：199 commits
- **开发周期**：2026-01-08 至 2026-06-07（约 5 个月）
- **主要贡献者**：TiaraBasori, Empty, 小城事故多, xream, EAlyce 等
- **核心里程碑**：
  - 2026-01-10 至 01-21：Telegram/Telegraph 格式化工具
  - 2026-04-01：运行时管理器重构
  - 2026-05-10：GenerationContext 生命周期系统
  - 2026-05-18 至 05-27：Channel Gap Circuit Breaker
  - 2026-05-30：热重载机制改为进程退出
  - 2026-06-07：文档全面更新

---

## 🎓 技术亮点

1. **GenerationContext 生命周期系统**
   - 基于 AbortSignal 的统一资源管理
   - 三阶段清理模型：abort → drain → dispose
   - 覆盖运行时、插件、定时任务、网络请求等所有异步资源

2. **Channel Gap Circuit Breaker**
   - 自动识别和隔离问题频道
   - 指数退避策略防止级联故障
   - 跨重载保持状态，确保保护持续有效

3. **进程级热重载**
   - 彻底解决内存泄漏问题
   - 依赖 PM2 自动重启，确保服务连续性

4. **安全消息操作层**
   - 统一的 API 错误处理
   - 防止边界条件导致的崩溃

5. **日志系统智能化**
   - 频道级错误降级和限流
   - 减少约 90% 的噪音日志输出

---

## 🔄 迁移指南

### 从 0.2.7 升级至 0.2.8

#### 1. 环境要求
```bash
# 更新 Node.js 至 24.x（推荐）
nvm install 24
nvm use 24

# 安装/更新依赖
npm install
```

#### 2. 进程管理
**必须使用 PM2 或类似工具**：
```bash
# 安装 PM2
npm install -g pm2

# 启动 TeleBox
pm2 start "npm start" --name telebox

# 保存配置并设置开机自启
pm2 save
pm2 startup systemd
```

#### 3. 插件开发者
如果您开发了自定义插件，需要适配新的生命周期系统：

```typescript
// 旧插件（0.2.x）
class MyPlugin extends PluginBase {
  async setup() {
    this.timer = setInterval(() => {}, 1000);
  }
  
  async cleanup() {
    if (this.timer) clearInterval(this.timer);
  }
}

// 新插件（0.2.8）
class MyPlugin extends PluginBase {
  async setup() {
    // GenerationContext 自动管理生命周期
    this.ctx.addCleanup(() => {
      console.log('插件正在卸载');
    });
    
    // 使用 signal 让异步操作可中止
    this.timer = setInterval(() => {
      if (this.ctx.signal.aborted) return;
      // 执行任务
    }, 1000);
  }
  
  // cleanup() 现在由 PluginBase 自动处理
  // 除非需要特殊清理逻辑，否则无需覆盖
}
```

#### 4. 检查日志路径
如果使用自定义 PM2 配置，确认日志路径：
```javascript
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'telebox',
    script: 'npm',
    args: 'start',
    error_file: './logs/telebox-error.log',
    out_file: './logs/telebox-out.log'
  }]
}
```

---

## 🙏 致谢

感谢所有为 TeleBox 0.2.8 做出贡献的开发者！

---

**完整提交历史**：[v0.2.7...v0.2.8](https://github.com/TeleBoxOrg/TeleBox/compare/e39fb2b...04b715a)

---

## [0.2.7] - 2026-01-07

- 添加些依赖

## [0.2.6] - 2025-10-03

- sudo 支持自定义命令前缀，使用环境变量 `TB_SUDO_PREFIX` 覆盖，默认主命令前缀

## [0.2.5] - 2025-09-24

- 支持配置 Telegram 代理
  - 在 config.json 中设置 proxy 字段
    - `"proxy": { "ip": "127.0.0.1", "port": 40000, "socksType": 5 }`
  - [官方文档](https://gram.js.org/beta/interfaces/custom.ProxyInterface.html)
- 命令监听忽略编辑的消息: `true` (可使用环境变量 `TB_CMD_IGNORE_EDITED` 覆盖)
- Plugin 添加 ignoreEdited 参数, 可覆盖全局设置
- Plugin 添加 listenMessageHandlerIgnoreEdited 参数, 设置为 `false` 时, listener 会监听编辑的消息
- 环境变量 `TB_LISTENER_HANDLE_EDITED` 可设置不忽略监听编辑的消息的插件
- eatgif 利用 ffmpeg 将 gif 转成 webm 表情包
- 添加 dotenv 依赖 以及 env 配置文件
