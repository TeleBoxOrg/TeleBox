# 架构 / 设计审查记录

本文档由健康检查 agent 在发散性审查中追加发现，记录本体（teleproto 版）中
过于复杂、冗余或存在过度设计 / 性能隐患的架构问题。每条包含：问题描述、
影响范围、建议改进方向。

---

## 1. getCommandFromMessage 每条消息都新建并关闭一次 SQLite 连接（性能）

- 问题描述：
  `src/utils/pluginManager.ts` 中 `getCommandFromMessage(msg)` 对**每一条**进来的
  消息都执行 `new AliasDB()`（在 `src/utils/aliasDB.ts` 中 `new Database(...)` 打开
  better-sqlite3 连接），查询完成后 `aliasDB.close()`。即每条消息都经历“打开数据库连接
  → 查询 → 关闭连接”的完整开销。在高频群聊中，每条消息都建立/销毁一个原生数据库连接，
  属于明显的重复资源开销。
- 影响范围：性能（高消息量下连接打开/关闭的系统调用与 VFS 锁竞争开销）；可维护性（隐藏的热点）。
- 建议改进方向：
  - 维护一个进程级单例 `AliasDB`（或在 runtime 启动时初始化一次、shutdown 时关闭），
    `getCommandFromMessage` 直接复用该单例，避免每条消息重开连接。
  - 由于别名是低频写入、高频读取的配置，也可在内存中缓存一份 alias 映射，更新时失效，
    完全避免热路径上的数据库访问。
  - 注意：`AliasDB` 已在 `setPlugins` 中按次使用，同样可统一为单例复用。

---

## 2. reload 插件存在未被使用的实例字段（冗余 / 死代码）

- 问题描述：
  `src/plugin/reload.ts` 第 429 行声明了实例字段
  `private lastReloadMemoryMb: number | null = null;`，但在 `reload`
  cmdHandler 内部（第 434 行）又声明了同名局部常量 `const lastReloadMemoryMb =
  beforeMemory.heapUsed;`，后续内存 delta 计算（第 452 行）实际使用的是局部常量。
  实例字段 `lastReloadMemoryMb` 在整个类中从未被读取或写入，属于完全无用的死代码。
- 影响范围：可维护性（误导读者以为字段会在多次 reload 间保留状态，实际并不参与任何逻辑；
  增加无用状态）。风险（低，仅混淆，无功能错误）。
- 建议改进方向：
  - 直接删除第 429 行的实例字段声明，消除冗余；
  - 或将 `reload` 内统计逻辑改为真正复用实例字段（在 reload 开始时写入、
    结束时计算 delta），让字段承担实际职责，而不是既声明又不用。

---

## 3. sub 插件 `arg` 变量解析后从未使用（冗余 / 死代码）

- 问题描述：
  `src/../TeleBox_Plugins/sub/sub.ts`（插件仓库）中 cmdHandler 解析了
  `const arg = parts[2];`（第 155 行），但后续 `switch (cmd)` 的所有分支
  （up / update / info / fix-docker / logs / clean / backup / restore 等）
  均未使用 `arg`。该变量为死代码；结合本仓库历史已修复过的命令注入问题，
  应警惕此类“解析了用户输入却未校验”的写法后续被误用而重新引入注入风险。
- 影响范围：可维护性（无用变量）。风险（低，当前无注入，但属于未来注入的隐患面）。
- 建议改进方向：
  - 删除未使用的 `arg` 声明；若某些子命令（如 `restore <名称>`）未来需要参数，
    应在使用处显式解析并做白名单/路径校验后再传入任何 shell 命令。

---

## 4. status.ts 使用字符串 `execSync` 而非 `execFile` 数组，与全仓安全约定不一致

- 问题描述：
  `src/plugin/status.ts` 的 `safeExec(command: string)`（第 856 行）内部调用
  `execSync(command, options)`（字符串命令）。虽然当前所有调用点（第 640~770 行）
  都只拼接**硬编码或 fs.existsSync 计算出的路径**（如 `/System/Volumes/Data`、`/usr/sbin/sysctl`），
  暂无注入风险，但全仓其余命令执行点（`src/plugin/ping.ts` 用 `execFile` 参数数组、
  `src/utils/npm_install.ts` 用 `execFileSync` 参数数组、`exec.ts` 的 `trackChildProcess(exec(...))`
  是授权的 exec 命令本身）都遵循“参数数组、无 shell 插值”的约定。status.ts 单独使用
  字符串 `execSync` 是例外，构成潜在注入面——一旦未来有人在 `safeExec` 调用中拼入
  任何用户输入（哪怕只是目标路径/网卡名），就会立即变成命令注入。
  另：`status.ts` 单文件已达 972 行，私用方法数量众多（getMac*/getCpu*/getDisk*/safeExec 等），
  属于巨型文件，职责可拆分。
- 影响范围：风险（当前安全，但是潜在注入面，违反最小意外原则）；可维护性（巨型文件、约定不一致使审查时更易误判）。
- 建议改进方向：
  - 将 `safeExec` 改为 `execFileSync(bin, args[])` 数组式签名（如
    `safeExec(bin, args[])`），调用点改为 `this.safeExec("df", ["-k", targetPath])` 等，
    从根本上杜绝 shell 插值；
  - 或将 `status.ts` 按子系统（disk / cpu / memory / network / mac / win）拆分为
    `src/plugin/status/*` 子模块，主文件只负责聚合与权限校验，降低单文件复杂度。

---

## 5. hook/listen.ts 的 patchMsgEdit 为死代码，且一旦启用会在每条消息 edit 时新建 SQLite 连接（性能 / 风险）

- 问题描述：
  `src/hook/listen.ts` 中的 `patchMsgEdit()` 通过改写 `Api.Message.prototype.edit`
  （原型链 monkey-patch）实现：当发送者是 sudo 用户时，把 `edit` 改为重新 `sendMessage`
  一条新消息。但 `index.ts` 第 46 行 `// patchMsgEdit();` 明确注释未启用，因此该函数
  当前**完全未被调用**（死代码）。
  更危险的是，其内部 `checkIfSenderIdFromSudoUser` 在**每一次** `edit` 调用时都会
  `new SudoDB()` → 打开 better-sqlite3 连接 → 查询 → `close()`。这与第 1 条发现是同一类
  问题：一旦误启用（哪怕只是去掉那行注释），所有命令的 `msg.edit(...)` 都会变成
  “打开 DB 连接 → 查询 → 关闭” 的热路径开销，且原型链 patch 会影响进程内所有
  `Api.Message` 实例，行为难以追踪、难以测试。
- 影响范围：风险（当前安全，但属于“误启用即出错”的隐患面）；可维护性（死代码 + 原型链污染的强耦合）。
- 建议改进方向：
  - 如果该 sudo 重定向功能确实不再需要，直接删除 `src/hook/listen.ts` 整个文件及
    `index.ts` 第 46 行的注释，消除死代码与原型污染风险；
  - 若未来确实需要，应改为在消息分发层（pluginManager）基于 `isSudoUser` 做一次性判定，
    而非 monkey-patch 公共原型，且 sudo 列表应走内存缓存（同第 1 条），避免热路径开库。

---

## 6. 工作树完整性：src/plugin/agent.ts 曾出现未提交的损坏注入（安全 / 风险）

- 问题描述：
  本仓库 `src/plugin/agent.ts` 的工作树（未提交状态）曾被注入大量与上下文不符的垃圾代码，
  例如：在 `buildSystemPrompt` 的数组字面量中插入独立表达式语句
  `displayName ? \`[身份]...\` : \`[身份]...\``（成为语法错误的悬空语句）；
  在 `markdownToTelegramHtml` 函数体中部插入一个**外来的**
  `return { update_plan: "记一下计划", ... }[name] || name;`，使该函数提前 return、后面的
  HTML 转义逻辑（含已删除的 `usageTotal` / `elapsed` 辅助函数）全部不可达；并在
  `toolLabel` 的对象字面量、`AgentStatus` 构造函数与 `finish` 方法内部注入
  `this.state = "..."`，属于放在对象/函数体内会直接报 SyntaxError 的非法赋值。
  这些改动不是任何已提交版本的内容——`git show HEAD:src/plugin/agent.ts` 与 HEAD 完全一致，
  说明是本地未提交、从外部混入的损坏内容。已通过 `git checkout -- src/plugin/agent.ts`
  回退到已提交的干净版本（即远程 main 的实际内容）。
- 影响范围：风险（高 —— 若不慎 `git add .` 提交，会破坏 .agent 渲染并引入语法错误，
  CI/启动即失败）；可维护性（无正式提交历史可回溯这些注入来源）。
- 建议改进方向：
  - 提交前**永远**先 `git status` 确认待提交清单，绝不使用 `git add .` / `git add -A`
    整树添加，避免把这类未授权/损坏内容夹带进本体仓库；
  - 对核心插件文件（agent.ts 等）考虑加 pre-commit 钩子或 CI 跑 `tsc --noEmit` / 语法校验，
    任何未提交的孤立改动在进入提交前就被拦下；
  - 若工作树频繁出现非自发的外部修改，应排查运行环境（cron/编辑器/同步工具）的写入来源。

---

## 7. agent.ts 一次未提交的大型重构因模板字符串缺少结束反引号而整体无法编译（风险）

- 问题描述：
  工作树中 `src/plugin/agent.ts` 存在一次未提交的大规模重构（将配置字段
  `ai_providers`→`providers`、`active_provider`→`default_provider`、`api_interface`→`type`，
  并新增向后兼容迁移逻辑，约 60 行 diff 跨数十处）。其中 `ai set` 子命令的错误提示
  `throw new Error(\`...\uFF1Aopenai / gemini / anthropic\`)` 在第 2600 行**漏写了结束反引号**，
  写成 `anthropic);`——反引号缺失使该模板字符串一路延伸到文件末尾，导致
  `tsc` 报出 `TS1005` / `TS1127` 等一连串语法错误，且 `tsx`/esbuild 在运行时也会
  直接解析失败，bot 将**完全无法启动**。该问题只在做全仓 `tsc --noEmit` 时才暴露；
  仅靠肉眼 review 这段中文转义字符串极易漏看。
- 影响范围：风险（高 —— 漏反引号会让整文件语法非法、启动即崩溃）；
  可维护性（大跨度重命名字段 + 中文 `\u` 转义字符串，diff 难以逐字核对）。
- 建议改进方向：
  - 任何对 `agent.ts` 的重构提交前，必须跑一次 `node_modules/.bin/tsc --noEmit`
    （或 `esbuild --bundle=false` 语法校验）作为门禁，确保无 `TS1005`/`TS1127` 类语法错误；
  - 配置字段重命名这类破坏性改动建议拆成更小、可独立编译提交的 PR，并在 CI 加语法门禁；
  - 错误文案等面向用户的字符串尽量用真正的 UTF-8 文本而非 `\u` 转义，便于 review 与定位。

---

## 8. 插件仓库可静默引入 mtcute 版（`telegram` 包）导入，构建期无门禁（风险 / 可维护性）

- 问题描述：
  插件仓库 `TeleBox_Plugins` 为 teleproto 版生态，所有插件应通过
  `import { Api, TelegramClient } from "teleproto"` 取用类型与客户端类。但 `nodeseek.ts`
  误写成 `import { Api } from "telegram"; import { TelegramClient } from "telegram";`——
  即引入了 mtcute/teleproto 的旧版 `telegram` 包。`teleproto` 版运行时**并未安装**
  `telegram` 这个 npm 包（两仓库 API 不兼容），因此该文件在 tsx 加载阶段即
  `Cannot find module "telegram"`，插件静默加载失败、整插件不可用。`outdated/` 下的
  `gpt.ts`、`gemini.ts` 同样用了 `from "telegram"`，但那是归档目录、不参与构建，故未爆。
  根本原因是：仓库对“teleproto 版禁用 `telegram` 包导入”这一红线**没有任何**
  tsconfig 路径别名、构建脚本或 CI 门禁来强制拦截，只能靠人工 review 发现。
- 影响范围：风险（高 —— 一旦某插件误引入 `telegram` 包，该插件在 teleproto 运行时
  100% 加载失败，且失败是静默的，不会阻塞其他插件）；可维护性（无自动防线，
  串仓隐患完全依赖人力排查）。
- 建议改进方向：
  - 在插件仓库 `tsconfig.json` 增加 `paths` 或 `compilerOptions` 约束，把 `telegram`
    映射到一个会触发编译错误的桩模块（或在 build 脚本里 `grep -rn 'from "telegram"'`
    并非零退出），把串仓问题提前到编译/CI 阶段暴露；
  - 健康检查 agent 已对 `from "telegram" | from "mtcute" | from "gramjs"` 做全仓扫描，
    并跳过 `outdated/`、`scripts/`；建议把同样的正则固化进仓库自身的 lint/CI；
  - 在 `README.md` / `CONTRIBUTING` 中明确“teleproto 版插件一律从 `teleproto` 导入，
  禁止 `telegram`/`mtcute`/`gramjs`”。

---

## 9. src/plugin/agent.ts 是提交进仓库的转译产物，导致 `tsc --noEmit` 噪声淹没真实错误

- 问题描述：
  `src/plugin/agent.ts` 是一个约 3000 行、131KB 的**已被打包/转译**文件（特征：
  全文件 `import_axios = require("axios")`、`import_fs4 = require("fs")` 这类 esbuild 风格的
  `require` 别名、`var` 声明、函数无类型标注）。因为不是手写 TS 源码，整文件会产生约 545 条
  `TS7006`（隐式 any）等类型错误，使 `tsc --noEmit` 对该文件**必然无法通过**。
  这带来两个实际问题：
    1. 全仓 `tsc` 门禁形同虚设——真正的错误（如本次发现的 `safeReply` 引用未声明变量
       `plainFallback`，见下方影响）被 545 条 `implicit any` 噪声淹没，人工 review 根本扫不到；
    2. 该文件是核心 `.agent/.plan` 智能体，**运行直接由 `tsx` 执行未编译源码**，转译产物与源码
       不一致，且任何对它的修改都要在“打包产物”上 diff，极易漏改、难维护。
- 影响范围：可维护性（高 —— 改动需在巨型转译产物上做，diff 不可读）；风险（高 ——
  `tsc` 无法作为提交门禁，真实类型/逻辑错误（如未声明变量 `ReferenceError`）会被静默放过）。
- 建议改进方向：
  - 把 `agent` 智能体拆回**可维护的手写 TS 源文件**（或保留在独立的源码目录、由构建步骤产出
    单一 bundle，而不是把 bundle 直接提交进 `src/`）；让 `src/` 下全部为可 `tsc --noEmit` 通过的源；
  - 在 CI / 提交前门禁跑 `node_modules/.bin/tsc --noEmit`，将本体 `src/` 中除 agent.ts bundle
    外的错误数维持为 0；
  - 本次健康检查已在 `safeReply`（`src/plugin/agent.ts` 约第 1797 行）修复一处真实 bug：
    HTML 发送失败时回退纯文本本应使用已计算的 `safePlain`，却误引用了从未声明的
    `plainFallback`，导致回退分支抛 `ReferenceError` 被外层空 catch 吞掉、纯文本兜底完全失效。

---

## 10. 全仓 `tsc --noEmit` 当前不可通过，掩盖真实回归

- 问题描述：
  当前 `npx tsc --noEmit -p tsconfig.json` 报出 **560 条**错误：其中 545 条集中在
  `src/plugin/agent.ts`（转译产物，见第 9 条），其余 15 条分布在 `plugins/`（本地插件，
  已在 `.gitignore` 中、不计入本体构建），以及 `src` 下已修复的 `agent.ts` 逻辑错误。
  由于 `plugins/*` 被 `tsconfig.json` 的 `include` 纳入编译（`"include": ["src/**/*", "plugins/**/*"]`），
  而 `plugins/` 下大量本地插件未随本体提交、缺乏完整上下文，tsc 也会在此报错——这些错误与
  本体代码质量无关，却让 `tsc` 退出码恒为非 0，无法作为本体 CI 门禁。
- 影响范围：风险（中 —— 没有有效的编译门禁，本体回归无自动防线）；可维护性（中）。
- 建议改进方向：
  - 将 `tsconfig.json` 的 `include` 收窄为 `["src/**/*"]`，把本地 `plugins/` 的编译交给插件
    仓库自己的配置，避免本体 `tsc` 被插件噪声干扰；
  - 配合第 9 条把 `agent.ts` 还原为可编译源码后，本体 `tsc --noEmit` 应可稳定通过，从而成为
    有效的提交/CI 门禁。