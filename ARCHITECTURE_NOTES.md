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
