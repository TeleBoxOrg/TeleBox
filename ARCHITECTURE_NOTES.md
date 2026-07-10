# TeleBox 架构/设计审查笔记

> 由健康检查 agent 维护。记录过于复杂、冗余或脆弱的架构设计问题，以及其影响与改进方向。
> 每次审查发现追加到文末，避免覆盖历史记录。

---

## [2026-07-10] 插件源 ↔ 运行镜像严重分叉（`telebox/plugins/` vs `TeleBox_Plugins`）

### 问题描述

插件存在**两份副本**，且二者并不一致：

1. **规范源**：`/root/TeleBox_Plugins/<plugin>/<plugin>.ts`（子目录布局，已纳入 git 跟踪）。
2. **运行镜像**：`/root/telebox/plugins/<plugin>.ts`（扁平布局），由 `pluginManager.ts` 在 `process.cwd()/plugins` 下直接 `require` 加载，是实际执行的代码。

`telebox/plugins/*` 整体被 `.gitignore` 忽略（仅 `moyu.ts` 等个别文件被 force-commit 例外），因此它**不受 telebox 仓库版本控制约束**，与 `TeleBox_Plugins` 规范源之间没有自动同步机制。

本次审查发现运行镜像曾被一次**粗暴的全局 `\n` → `<br>` 文本替换**污染：替换把"消息文本里的换行"和"程序数据里的换行（shell 输出、文件内容、正则、HTTP body）"不加区分地一并改成了 `<br>`，导致大量真实 bug：

- `shellEscape` 正则由 `/[\r\n]/` 变成 `/[\r<br>]/`（字符类误删字面量 `< b r >`），使密码等参数中的 `b`/`r`/`>` 被静默删除 → `.ssh passwd` 设置的是错误密码。
- 多处对真实命令输出（如 `dig`、`qr`/`zbarimg`、`convert -version`、`getent`、`netstat`、`authorized_keys` 文件、`git` 输出、namebeta SSE、Gemini API 文本、multipart 上传 body 的 `\r\n`）使用 `split('<br>')` / `\r<br>`，导致解析失败或仅解析到单行。

规范源 `TeleBox_Plugins` 始终正确（全部使用 `\n`），说明问题**只发生在运行镜像**，且长时间未被发现。

### 影响范围

- **安全**：`ssh.ts` 的 `shellEscape` 损坏会让 `.ssh passwd` / `.ssh enableroot` 写入与用户预期不一致的 root 密码。
- **功能正确性**：`dig`、`qr`、`sticker_to_pic`、`rev`、`service`、`music`、`subinfo`、`search`、`whois`、`ai`、`yt-dlp`、`ssh` 等插件的解析逻辑全部受损；`ai.ts` 的图片 multipart 上传因 `\r<br>` 而非 `\r\n` 而结构错误。
- **可维护性**：两份副本差异巨大（如 `ai.ts` 两副本相差 75 行、`music.ts` 相差 44 行），无法可靠判断哪份是"真相"，任何修复都必须手动判断"这是规范演进还是镜像腐化"，极易出错。

### 建议改进方向

1. **建立单一可信源 + 构建步骤**：让 `telebox/plugins/` 成为**由 `TeleBox_Plugins` 生成的产物**（CI/部署脚本拷贝并按需做 HTML 转义），而非手工维护的副本。运行镜像不应被手动编辑。
2. **若必须保留两套文件**：将 `telebox/plugins/` 整体纳入 git 跟踪（移除 `.gitignore` 中的 `plugins/*`），使镜像与源的差异常规化、可被 review 与 diff 捕获；并为"镜像与规范源漂移"添加 CI 校验（例如对比关键解析点的 `split`/`\r\n` 是否一致）。
3. **HTML 转义应在渲染层集中处理**：Telegram `parseMode: "html"` 下 `\n` 本就会被正确渲染为换行，`<br>` 并非必需。应避免在源码里"先写 `\n` 再全局替换成 `<br>`"这种文本级 hack；统一在发送前做一次转义即可，彻底消除"数据里的 `\n` 被误伤"的根因。
4. **对 `shellEscape` 等安全关键函数加单元测试**：覆盖含 `b`/`r`/`<`/`>` 的输入的转义结果，防止正则/字符类回归。

---

## [2026-07-10] 插件生命周期定时器的清理依赖 `cleanup()` 实现

### 问题描述

`cy.ts` / `checkin.ts` / `music_hub.ts` 使用裸 `setInterval`，各自把句柄存到实例字段，并在 `cleanup()` / `stop()` 中 `clearInterval`。当前 `pluginManager.runPluginCleanup` 会在每次 reload/卸载时调用 `cleanup()`，因此**目前没有定时器泄漏**。

但这是一种"约定式"保证：一旦某插件忘记实现 `cleanup()`（`Plugin` 基类未强制），reload 后旧定时器会继续在已销毁的 generation 上运行，访问失效 client / 写入已卸载的 DB，造成僵尸定时器与难以排查的崩溃。

### 影响范围

- 所有使用裸 `setInterval`/`setTimeout` 且未正确清理的插件；reload 频率越高累积越多。
- `generationContext` 已提供 `lifecycle.setInterval`/`trackChildProcess`/`trackDisposable` 等受控资源 API（见 `exec.ts`、`bf.ts`），插件却未统一使用。

### 建议改进方向

1. **统一使用受控 API**：插件内部的周期性任务应改用 `lifecycle.setInterval(...)`（已具备 abort 时自动清理与诊断日志），而非裸 `setInterval`，把清理责任下沉到 generation 生命周期。
2. **基类强制 / 告警**：在 `Plugin` 基类或 `pluginManager` 中，对持有裸定时器字段却未实现 `cleanup()` 的插件在加载时打印告警，或将 `cleanup()` 设为必须。
3. **reload 诊断**：利用现有 `formatResidualResources` 诊断，在 drain 超时时报告未清理的 timer/listener，便于定位遗漏插件。
