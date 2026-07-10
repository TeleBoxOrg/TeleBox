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
