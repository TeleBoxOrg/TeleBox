# TeleBox Leech V1 功能解释

## 1. Login Telegram Session

TeleBox 本身已经有 Telegram session 登录流程：

- `src/utils/apiConfig.ts` 管理 `config.json`
- `src/utils/loginManager.ts` 管理 QR / 手机号登录
- `src/utils/runtimeManager.ts` 创建并持有全局 `TelegramClient`

Leech V1 不重新实现一套独立登录，而是复用 TeleBox runtime 的登录状态。

新增命令：

```text
.leech login
.leech session
```

用途：

- 检查当前 session 是否可用。
- 输出当前登录用户 ID、username、name。
- 记录 structured log：`session.check`

## 2. Leech chat/group messages with date range

命令：

```text
.leech chat <target> --from <date> --to <date> [--limit N] [--batch N]
```

Target 支持：

| target | 说明 |
|---|---|
| `here` | 当前命令所在 chat/group/channel |
| `@username` | 公开群组/频道/用户 |
| `-100123456789` | Telegram supergroup/channel ID |
| `https://t.me/name` | t.me 公开链接 |
| `https://t.me/c/123456789/1` | t.me 私有群/频道消息链接，会转换成 `-100123456789` |

日期：

| 参数 | 说明 |
|---|---|
| `--from 2026-01-01` | 从 2026-01-01 00:00:00 开始 |
| `--to 2026-01-31` | 到 2026-01-31 23:59:59 结束 |

抓取逻辑：

1. 从 `--to` 附近开始向旧消息分页。
2. 每批最多 100 条。
3. 保存落在 `[from, to]` 内的消息。
4. 如果消息时间早于 `from`，停止。

## 3. Save to local SQLite DB

默认 DB 路径：

```text
assets/leech/leech.db
```

查看命令：

```text
.leech db
```

主要表：

- `leech_jobs`：任务元数据。
- `leech_messages`：消息数据。
- `leech_actions`：结构化 action log。

`leech_messages` 使用 `(chat_id, message_id)` 作为 primary key，所以重复抓同一范围会 upsert，不会无限重复插入。

## 4. Structured log

每个关键动作都会有 JSON log：

- `command.<subcommand>`
- `session.check`
- `chat.leech.command`
- `chat.resolve_target`
- `chat.fetch_batch`
- `chat.save_batch`
- `chat.save_message`（跳过异常消息时）

每条 log 同时写入：

1. Console stdout
2. SQLite `leech_actions`

这样后续可以直接用 SQL 回放任务：

```sql
SELECT *
FROM leech_actions
WHERE action_id = 'leech_chat_xxx'
ORDER BY id ASC;
```

## 5. Commands

### `.leech help`

显示帮助。

### `.leech login`

检查 session。

### `.leech chat`

抓消息。

Examples:

```text
.leech chat here --from 2026-01-01 --to 2026-01-31
.leech chat @mygroup --from 2026-01-01 --to 2026-01-31 --limit 1000
.leech chat https://t.me/c/123456789/1 --from 2026-01-01 --to 2026-01-02
```

### `.leech jobs`

查看最近任务。

```text
.leech jobs
.leech jobs 20
```

### `.leech stats`

查看保存统计。

### `.leech db`

查看 SQLite DB 路径。

## 6. 代码注释风格

核心模块的关键逻辑使用中英文注释：

```ts
// Telegram offsetDate is exclusive, so +1 second keeps the --to second inclusive.
// Telegram 的 offsetDate 是排除边界，因此 +1 秒来保证 --to 当秒被包含。
```

这样方便后续中文沟通，也保留英文技术上下文。

## 7. 本地验证

```powershell
npm run leech:smoke
```

这个命令不会连接 Telegram，会使用 fake client 模拟 3 条消息，并跑两层验证：

1. `LeechService` service 层。
2. `src/plugin/leech.ts` 插件命令层。

- 2 条在日期范围内，应保存到 SQLite。
- 1 条早于 `--from`，应触发边界停止。

验证点：

- `leech_jobs` 有 1 条任务。
- `leech_messages` 有 2 条消息。
- `leech_actions` 有多条 structured action log。
- `LeechService.stats()` 能读取统计结果。
- 插件命令 `.leech login/chat/jobs/stats/db` 都能返回预期文本。
# TeleBox Leech V1 Features / 功能解释

## 1. Login Telegram Session / 登录 Telegram Session

TeleBox already has a Telegram session login flow built-in:

TeleBox 本身已经有 Telegram session 登录流程：

- `src/utils/apiConfig.ts` manages `config.json` / 管理 `config.json`
- `src/utils/loginManager.ts` handles QR / phone login / 处理 QR / 手机号登录
- `src/utils/runtimeManager.ts` creates and holds the global `TelegramClient` / 创建并持有全局 `TelegramClient`

Leech V1 does NOT implement a separate login. It reuses the TeleBox runtime login.

Leech V1 不重新实现登录，而是复用 TeleBox runtime 的登录状态。

Commands / 命令：

```text
.leech login
.leech session
```

Purpose / 用途：
- Check if the current session is valid. / 检查当前 session 是否可用。
- Output current user ID, username, name. / 输出当前登录用户信息。
- Structured log action: `session.check` / 结构化日志 action。

## 2. Leech Chat/Group Messages with Date Range / 按日期范围抓取消息

Command / 命令：

```text
.leech chat <target> --from <date> --to <date> [--limit N] [--batch N]
```

### Supported Targets / 支持的 Target

| Target | Description / 说明 |
|---|---|
| `here` | Current chat/group/channel where the command is sent / 命令所在的当前 chat |
| `@username` | Public group/channel/user / 公开群组/频道/用户 |
| `-100123456789` | Telegram supergroup/channel ID |
| `https://t.me/name` | Public t.me link / 公开链接 |
| `https://t.me/c/123456789/1` | Private link, converted to `-100123456789` / 私有链接，自动转换 |

### Date Parameters / 日期参数

| Param / 参数 | Description / 说明 |
|---|---|
| `--from 2026-01-01` | Start from 2026-01-01 00:00:00 / 从 2026-01-01 00:00:00 开始 |
| `--to 2026-01-31` | End at 2026-01-31 23:59:59 / 到 2026-01-31 23:59:59 结束 |

### Fetch Logic / 抓取逻辑

1. Start from `--to` and paginate toward older messages. / 从 `--to` 附近开始向旧消息分页。
2. Fetch in batches of up to 100. / 每批最多 100 条。
3. Save messages within `[from, to]`. / 保存落在日期范围内的消息。
4. Stop if a message is older than `from`. / 消息早于 `from` 时停止。

## 3. Save to Local SQLite DB / 保存到本地 SQLite 数据库

Default DB path / 默认路径：

```text
assets/leech/leech.db
```

Check with / 查看：`.leech db`

Tables / 表：
- `leech_jobs` — task metadata / 任务元数据
- `leech_messages` — message data / 消息数据
- `leech_actions` — structured action log / 结构化 action 日志

`leech_messages` uses `(chat_id, message_id)` as primary key, so re-fetching the same range will upsert (not duplicate).

`leech_messages` 使用 `(chat_id, message_id)` 作为主键，重复抓取同一范围会 upsert，不会重复插入。

## 4. Structured Log / 结构化日志

Every key action produces a JSON log entry, written to both:

每个关键动作都会生成 JSON 日志，同时写入：

1. Console stdout
2. SQLite `leech_actions` table

Key actions / 关键 action：
- `command.<subcommand>` — command entry / 命令入口
- `session.check` — session verification / session 检查
- `chat.leech.command` — main leech flow / 主抓取流程
- `chat.resolve_target` — target resolution / target 解析
- `chat.fetch_batch` — batch fetching / 分批抓取
- `chat.save_batch` — batch saving / 分批保存

Query example / 查询示例：

```sql
SELECT * FROM leech_actions
WHERE action_id = 'leech_chat_xxx'
ORDER BY id ASC;
```

## 5. All Commands / 全部命令

| Command / 命令 | Description / 说明 |
|---|---|
| `.leech help` | Show help / 显示帮助 |
| `.leech login` / `.leech session` | Check Telegram session / 检查 session |
| `.leech chat <target> --from <date> --to <date>` | Fetch messages / 抓取消息 |
| `.leech jobs [N]` | View recent jobs / 查看最近任务 |
| `.leech stats` | View SQLite stats / 查看保存统计 |
| `.leech db` | Show DB path / 查看数据库路径 |

## 6. Code Comment Style / 代码注释风格

Core logic uses bilingual comments:

核心逻辑使用中英文注释：

```ts
// Telegram offsetDate is exclusive, so +1 second keeps the --to second inclusive.
// Telegram 的 offsetDate 是排除边界，因此 +1 秒来保证 --to 当秒被包含。
```

This facilitates Chinese communication while preserving English technical context.

这样方便中文沟通，同时保留英文技术上下文。

## 7. Local Verification / 本地验证

```powershell
npm run leech:smoke
```

This command does NOT connect to Telegram. It uses a fake client to simulate 3 messages:

这个命令不会连接 Telegram，会使用 fake client 模拟 3 条消息：

- 2 messages within the date range → should be saved. / 2 条在范围内 → 应保存。
- 1 message before `--from` → should trigger boundary stop. / 1 条早于 `--from` → 触发边界停止。

Verification points / 验证点：

- `leech_jobs` has 1 row / 有 1 条任务
- `leech_messages` has 2 rows / 有 2 条消息
- `leech_actions` has multiple structured logs / 有多条结构化日志
- `LeechService.stats()` returns correct statistics / 返回正确统计
- Plugin commands `.leech login/chat/jobs/stats/db` return expected output / 插件命令返回预期文本
