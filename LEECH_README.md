# TeleBox Leech V1 README

TeleBox Leech V1 是一个内置 Telegram Userbot 插件，用当前 TeleBox 登录的 Telegram session 抓取 chat/group/channel 的历史消息，并保存到本地 SQLite。

## 功能清单

1. Login Telegram Session  
   - TeleBox runtime 负责真实登录。
   - Leech 插件提供 `.leech login` / `.leech session` 检查当前 session。
2. Leech chat / group messages with date range  
   - `.leech chat <target> --from YYYY-MM-DD --to YYYY-MM-DD`
   - 支持 `here`、`@username`、数字 ID、`https://t.me/...` 链接。
3. Save to local SQLite DB  
   - 默认 DB：`assets/leech/leech.db`
   - 表：`leech_jobs`、`leech_messages`、`leech_actions`
4. Structured log for every action  
   - 每个关键 action 都会输出 JSON log 到 console。
   - 同时写入 `leech_actions` 表，方便审计。
5. Bilingual comments  
   - 核心代码包含中英文注释，方便后续二开。

## 快速开始

```powershell
cd "C:\Users\user\Desktop\TP AI Agent\TeleBox_reverse\TeleBox"
npm install
npm start
```

第一次启动会要求输入 Telegram `api_id`、`api_hash`，然后选择 QR login 或手机号登录。登录成功后 session 会保存到项目根目录 `config.json`。

> 不要提交真实 `config.json`，里面有 Telegram session。

## 本地 smoke 验证

不连接 Telegram，只验证 Leech V1 的 SQLite schema、structured log、日期范围分页、保存链路和插件命令入口：

```powershell
npm run leech:smoke
```

成功时会输出：

```text
leech smoke ok
```

并创建临时 SQLite DB：

- `temp/leech-smoke.db`：service 层验证。
- `temp/leech-plugin-smoke.db`：插件命令层验证，覆盖 `.leech login/chat/jobs/stats/db`。

## 命令

### 检查登录 session

```text
.leech login
.leech session
```

输出当前 Telegram 用户 ID、username、name。

### 抓当前聊天

```text
.leech chat here --from 2026-01-01 --to 2026-01-31
```

`here` 表示命令所在的当前 chat/group/channel。

### 抓指定群组/频道

```text
.leech chat @example_group --from 2026-01-01 --to 2026-01-31 --limit 500 --batch 100
```

参数：

- `--from`：开始日期，必填。
- `--to`：结束日期，必填。
- `--limit`：最多保存多少条消息，可选，不填表示按日期范围抓到边界。
- `--batch`：每批抓取数量，1-100，默认 100。

### 查看任务

```text
.leech jobs
.leech jobs 20
```

### 查看统计

```text
.leech stats
```

### 查看 DB 路径

```text
.leech db
```

## SQLite 表说明

### `leech_jobs`

每一次 leech 任务的元数据：

- target
- chat_id / chat_title / chat_type
- from_ts / to_ts
- status
- saved_count / scanned_count
- started_at / finished_at
- error

### `leech_messages`

保存每条 Telegram message：

- chat_id + message_id
- date_ts / date_iso
- sender_id / sender_username / sender_name
- message_text
- media_type
- reply_to_msg_id
- views / forwards
- raw_json

### `leech_actions`

结构化 action log：

- action_id
- job_id
- action
- status
- timestamp
- actor
- target
- details_json

## Structured log 示例

```json
{
  "scope": "telebox.leech",
  "timestamp": "2026-06-27T01:00:00.000Z",
  "actionId": "leech_chat_1780000000000_abcd1234",
  "jobId": 1,
  "action": "chat.fetch_batch",
  "status": "success",
  "actor": "123456",
  "target": "-100123456789",
  "details": {
    "batchNo": 1,
    "received": 100
  }
}
```

## 注意事项

- 这是 userbot：默认只响应自己发出的命令消息。
- Telegram API 有 rate limit；大范围抓取建议分段跑。
- `assets/leech/leech.db` 属于本地数据，不要提交到 git。
- 可用 `TB_LEECH_DB_PATH` 临时覆盖 DB 路径，方便测试或隔离环境。
- 如果需要导出，可直接使用 SQLite 工具读取 DB。
# TeleBox Leech V1 README / TeleBox Leech V1 说明文档

TeleBox Leech V1 is a built-in Telegram Userbot plugin that uses the current TeleBox session to fetch historical messages from any chat/group/channel within a date range, and saves them to a local SQLite database.

TeleBox Leech V1 是一个内置 Telegram Userbot 插件，用当前 TeleBox 登录的 Telegram session 抓取 chat/group/channel 的历史消息，并保存到本地 SQLite。

## Features / 功能清单

1. **Login Telegram Session / 登录 Telegram Session**
   - TeleBox runtime handles the actual Telegram login.
   - TeleBox runtime 负责真正的 Telegram 登录。
   - The leech plugin provides `.leech login` / `.leech session` to check the current session status.
   - Leech 插件提供 `.leech login` / `.leech session` 检查当前 session 状态。

2. **Leech chat / group messages with date range / 按日期范围抓取 chat/group 消息**
   - `.leech chat <target> --from YYYY-MM-DD --to YYYY-MM-DD`
   - Supports `here`, `@username`, numeric ID, `https://t.me/...` links.
   - 支持 `here`、`@username`、数字 ID、`https://t.me/...` 链接。

3. **Save to local SQLite DB / 保存到本地 SQLite 数据库**
   - Default DB path: `assets/leech/leech.db`
   - Tables: `leech_jobs`, `leech_messages`, `leech_actions`
   - 默认数据库路径：`assets/leech/leech.db`
   - 表：`leech_jobs`、`leech_messages`、`leech_actions`

4. **Structured log for every action / 每个 action 都有结构化日志**
   - Every key action outputs a JSON log to the console and writes to the `leech_actions` table.
   - 每个关键 action 都会输出 JSON log 到 console，并写入 `leech_actions` 表。

5. **Bilingual code comments / 中英文代码注释**
   - Core logic uses bilingual comments (English + Chinese) for easier maintenance.
   - 核心逻辑使用中英文注释，方便后续维护。

## Quick Start / 快速开始

```powershell
cd "C:\Users\user\Desktop\TP AI Agent\TeleBox_reverse\TeleBox"
npm install
npm start
```

On first start, you will be prompted for Telegram `api_id` and `api_hash`, then choose QR login or phone login. The session is saved to `config.json` in the project root.

第一次启动会要求输入 Telegram `api_id`、`api_hash`，然后选择 QR 登录或手机号登录。登录成功后 session 会保存到项目根目录 `config.json`。

> Do NOT commit real `config.json` — it contains your Telegram session.
> 不要提交真实 `config.json`，里面有你的 Telegram session。

## Local Smoke Test / 本地冒烟测试

Without connecting to Telegram, verifies the SQLite schema, structured log, date range pagination, save pipeline, and plugin command entry points:

不连接 Telegram，只验证 SQLite schema、结构化日志、日期范围分页、保存链路和插件命令入口：

```powershell
npm run leech:smoke
```

On success it outputs `leech service smoke ok` and `leech plugin smoke ok`, creating temporary SQLite DBs:

成功时输出 `leech service smoke ok` 和 `leech plugin smoke ok`，并创建临时 SQLite DB：

- `temp/leech-smoke.db` — service layer / 服务层验证
- `temp/leech-plugin-smoke.db` — plugin command layer / 插件命令层验证 (covers `.leech login/chat/jobs/stats/db`)

## Commands / 命令

### Check login session / 检查登录 session

```text
.leech login
.leech session
```

Outputs the current Telegram user ID, username, and name. / 输出当前 Telegram 用户 ID、用户名和昵称。

### Fetch current chat / 抓取当前聊天

```text
.leech chat here --from 2026-01-01 --to 2026-01-31
```

`here` means the chat/group/channel where the command is sent. / `here` 表示命令所在的当前 chat/group/channel。

### Fetch specific group/channel / 抓取指定群组/频道

```text
.leech chat @example_group --from 2026-01-01 --to 2026-01-31 --limit 500 --batch 100
```

| Param / 参数 | Description / 说明 |
|---|---|
| `--from` | Start date (required) / 开始日期（必填） |
| `--to` | End date (required) / 结束日期（必填） |
| `--limit` | Max messages to save (optional) / 最多保存条数（可选） |
| `--batch` | Batch size per fetch, 1–100, default 100 / 每批抓取数量 |

### View jobs / 查看任务

```text
.leech jobs
.leech jobs 20
```

### View stats / 查看统计

```text
.leech stats
```

### View DB path / 查看数据库路径

```text
.leech db
```

## SQLite Table Schema / SQLite 表结构

### `leech_jobs`

Metadata for each leech task. / 每次 leech 任务的元数据。

| Column | Type | Description / 说明 |
|---|---|---|
| id | INTEGER PK | Auto-increment job ID / 自增任务 ID |
| action_id | TEXT | Structured log action ID / 结构化日志 action ID |
| target | TEXT | User-supplied target / 用户传入的 target |
| chat_id | TEXT | Telegram chat ID |
| chat_title | TEXT | Chat title / 群名 |
| from_ts / to_ts | INTEGER | Date range (Unix seconds) / 日期范围（Unix 秒） |
| status | TEXT | `running` / `completed` / `failed` |
| saved_count | INTEGER | Messages saved / 已保存消息数 |
| scanned_count | INTEGER | Messages scanned / 已扫描消息数 |

### `leech_messages`

Saved Telegram messages. Uses `(chat_id, message_id)` as primary key for upsert.

保存的 Telegram 消息。使用 `(chat_id, message_id)` 作为主键，支持 upsert。

| Column | Type | Description / 说明 |
|---|---|---|
| chat_id | TEXT | Telegram chat ID |
| message_id | INTEGER | Telegram message ID |
| date_ts / date_iso | INTEGER / TEXT | Message timestamp / 消息时间戳 |
| sender_id | TEXT | Sender user ID / 发送者 ID |
| sender_username | TEXT | Sender username / 发送者用户名 |
| sender_name | TEXT | Sender display name / 发送者昵称 |
| message_text | TEXT | Message body text / 消息正文 |
| media_type | TEXT | Media class name / 媒体类型 |
| raw_json | TEXT | Full message snapshot / 完整消息快照 |

### `leech_actions`

Structured action log for audit trail. / 结构化 action 日志，用于审计。

| Column | Type | Description / 说明 |
|---|---|---|
| action_id | TEXT | Unique action ID / 唯一 action ID |
| job_id | INTEGER | Associated job ID / 关联任务 ID |
| action | TEXT | Action name / 动作名称 |
| status | TEXT | `start` / `progress` / `success` / `error` / `skipped` |
| timestamp | TEXT | ISO 8601 timestamp / ISO 8601 时间戳 |
| details_json | TEXT | JSON payload / JSON 详情 |

## Structured Log Example / 结构化日志示例

```json
{
  "scope": "telebox.leech",
  "timestamp": "2026-06-27T01:00:00.000Z",
  "actionId": "leech_chat_1780000000000_abcd1234",
  "jobId": 1,
  "action": "chat.fetch_batch",
  "status": "success",
  "actor": "123456",
  "target": "-100123456789",
  "details": {
    "batchNo": 1,
    "received": 100
  }
}
```

## Notes / 注意事项

- This is a userbot: it only responds to commands sent by the logged-in user by default.
- 这是 userbot：默认只响应登录用户自己发出的命令。
- Telegram API has rate limits; for large date ranges, consider splitting into smaller segments.
- Telegram API 有速率限制；大范围抓取建议分段执行。
- `assets/leech/leech.db` is local data — do NOT commit to git.
- `assets/leech/leech.db` 是本地数据，不要提交到 git。
- Use `TB_LEECH_DB_PATH` env var to override DB path for testing or isolation.
- 可用 `TB_LEECH_DB_PATH` 环境变量临时覆盖数据库路径。
