# Changelog

## [0.2.7] --2026-01-07

- 添加些依赖

## [0.2.6] --2025-10-03

- sudo 支持自定义命令前缀，使用环境变量 `TB_SUDO_PREFIX` 覆盖，默认主命令前缀

## [0.2.5] --2025-09-24

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

## [0.2.4] --2025-09-13

- 修复 Api.Message.deleteWithDelay 没有类型提醒
- hook 添加 Api.Message.safeDelet，用于安全删除消息，而不是遇到某些消息无法删除而退出进程

## [0.2.3] --2025-09-12

- 添加 modern-gif 依赖库，用于 eatgif 插件
- hook 添加 Api.Message.deleteWithDelay，用于延迟删除消息

## [0.2.2] --2025-09-08

- 移除 download 依赖库
- alias 重定向时会检查原始命令是否存在

## [0.2.1] --2025-09-08

- 放宽命令校验：重定向命令允许不符合 `/^[a-z0-9_]+$/i`
- 文档：重写 `TELEBOX_AI_DEVELOPMENT_PROMPT.md`，并整体优化
- 基础设施：从内部引入 `axios`
- 通知/公告：通知消息改为纯文本格式；修复公告文案过长
- 提交总结：新增每日提交总结与脚本（含 `commit-summary.js`），使用 Gemini AI 生成；修正需扫描的目标仓库；移除多余冒号

## 插件

### acron

- 新增 `ls`、`la`
- 支持直接跳转到目标对话/消息，并支持话题
- 修复复制、备注解析与消息链接
- 优化取值与复制逻辑、格式调整去除多余换行
- 提供 `lowdb`/`cronManager`/`formatEntity` 使用示例
- 文案更新

### bf

- 支持 `to` 参数：单次备份到指定目标并显示对话名称
- 文案更新

### bulk_delete

- 支持数据库持久化存储
- `.bd on` 后可用 `.bd 数字` 删除自己和他人消息

### convert

- 新增视频转音频插件

### debug

- 新增 `echo`：原样回复一条消息
- `msg/entity` 过长时以文件形式发送

### eat

- 完善表情包头像配置
- 文案更新

### gemini

- 新增 Gemini 插件
- 支持提交/日报总结能力

### gif

- 新增 GIF 转贴纸插件

### gpt

- 数据文件规范化

### help

- 去除默认中文别名，支持通过 alias 自定义重定向

### his

- 新增：查看被回复者最近 30 条消息

### kitt

- 新增高级触发器（JavaScript 匹配 → 执行），逻辑自由
- 上下文增加 API
- 文案修复与更新

### music

- 重写 `music.ts` 以适配新架构并增强音频处理

### news

- 新增新闻插件
- 更新 `news.ts`

### QR

- 新增二维码插件

### rate

- 新增汇率查询计算能力
- 优化智能查询流程，优先识别法币
- 删除多余别名

### search

- 修复 bug

### shift

- 支持发送到话题

### speednext

- 别名由 `s` 调整为 `st`

### sudo

- 修复复制逻辑

### sure

- 修复复制逻辑

### tpm

- 区分“精简版/详细版”已安装记录
- 文案更新

### exit

- 新增 `exit` 指令：结束进程；如配置进程管理工具将自动重启，并在重启时展示耗时与成功提示

### pmcaptcha

- 暂时下架（待更新）

### pm2

- 插件删除（由 `exit` 指令可实现重启）

### 点兵点将

- 从最近的消息中随机抽取指定人数的用户

## [0.2.0] --2025-09-06

## 本体

- safeForwardMessage 支持发送至话题

- 支持从环境变量设置命令前缀

- 优化文档

- 补全依赖

- getCommandFromMessage 调整, 支持 Api.Message | string

- 调整前缀

- 增加消息序列化还原方法

## 插件

- 放弃了旧的 node-schedule 使用新的 cron

- 适配了新的插件系统

- 部分插件未完美适配

- 固定的定时任务, 应使用 cronTasks

- 动态的处理定时任务, 应使用 cronManager

- description 应包含明确的使用说明, 现已支持动态生成

- 应动态获取前缀, 而不是写死固定的字符串

- 如果涉及到 sudo 模式下, 获取或操作触发触发者的原始消息, 应使用 trigger

  - 例如 re 中, 尝试删除原始消息

  - 例如 eat 中, 表情包中的 `我` 应优先取 trigger, 这才是 sudo 模式下的触发者

- 展示时间, 可先统一格式 zh-CN, 时区 Asia/Shanghai

- 展示用户/频道/对话, 可参考 acron 的 formatEntity 和 sudo 的 buildDisplay

- 读写配置, 可使用 sqlite 或 lowdb

### acron, send_cron, forward_cron, pin_cron

- 定时发送/转发/复制/置顶/取消置顶/删除消息/执行命令, 取代了 send_cron, forward_cron, pin_cron

- 调整格式, 去除不必要的换行

- 支持直接跳转到目标对话/消息 支持话题

### eat

- 支持 sudo 模式下, trigger 为触发者的原始消息, 表情包的 `我` 为触发者

### gpt

- 数据文件规范化

### dbdj

- 新增点兵点将, 从最近的消息中随机抽取指定人数的用户

### npm, tpm

- npm -> tpm

- 优化显示和长消息

- 支持插件安装记录

- 支持一键更新

### re

- 示范在最后删除发送的原始消息

- 支持话题

### help

- 支持定时任务

- 描述支持动态生成

- 关闭链接预览

### debug, entity, msg, id

- 新增 entity, msg 方便调试

- 吸收了 id, 合并为 debug 插件: 获取 entity/msg 信息, 获取详细的用户、群组或频道信息

### sure

- 默认不 mention

- 2s 后自动删除原消息

- 修复类型判断

- 赋予其他用户使用 bot 身份发送消息(支持重定向)的权限

- 支持内置命令(操作 aban, 可实现额外管理员功能)

- 消息若以 \_command: 开头, 认为此消息是命令, 即 \_command:/sb 可匹配 /sb 和 /sb uid. 若设置了重定向为 /spam, 则会自动变成 /spam 和 /spam uid

### sudo

- 默认不 mention

- 传入 trigger 发送者的原始消息

- 修复类型判断

- 使用缓存, 支持频道马甲, 简化判断和展示逻辑, 支持使用固定 id 链接

- 调整对话/频道/用户判断逻辑

- add/del 支持回复目标用户的消息或带上 uid/@username

- 支持对话白名单

### sendLog

- 支持发送日志文件到收藏夹或自定义目标

### bf

- 简单修复下 bf 时区问题

### ping

- 修复 ping dc1~dc5 icmp avg 取值问题

### shift

- 支持发送到话题, 不用再设置多余的 all

### pmcaptcha

- 暂时下架 待更新

## [0.1.4] --2025-09-05

## Added

- 新的插件结构，完善子命令函数的结构，增加 cron 任务的统一管理，目前可以参考 [test](https://github.com/TeleBoxDev/TeleBox/blob/dev/src/plugin/test.ts)
- 很多插件目前没有符合新插件要求，静等开发

## [0.1.3] --2025-09-01

## Fixed

- pluginManager 修复对含有子命令的插件添加太多监听函数

## [0.1.2] --2025-08-31

## Fixed

- help 可查看所有指令前缀
- update 若失败会提示用 .update -f 来强制更新

## [0.1.1] --2025-08-26

## Added

- help 可查看当前版本
- 添加 id 插件
- .tpm search 可查看远程插件列表

## [0.1.0] --2025-08-25

## Added

- Plugin @property command 改成 string[]，满足一些多命令的插件，需要调整以前的插件结构

## [0.0.9] --2025-08-23

## Added

- alias set|del 相关命令后重启插件从而能无缝使用新命令来唤出插件
- alias del 会判断正确的删除提示，而不是每次都返回成功
- 增加对插件监听函数的捕捉错误，防止掉线

## [0.0.8] --2025-08-23

## Fixed

- 修复 sudo 监听事件偶尔监听不到消息来源会崩溃的问题

## [0.0.7] --2025-08-23

## Added

- 新增 sudo 用来分配权限给其他用户
- 新增 exec 用来运行 shell
- 新增 Plugin 监听函数，用来实现如 keyword 以及 sudo 等插件的主要监听部分
- Plugin 调整结构，处理命令行函数不再传入 NewMessageEvent，而是传入 Api.Message，需要调整下插件

## [0.0.6] -- 2025-08-15

## Added

- 新增 alias 重定向插件命令
- 新增 用 。 符号识别插件

## [0.0.5] -- 2025-08-15

## Added

- 新增 上传插件 .npm upload <Plugin>
- 新增 封装 converstation 用来与 bot 持续对话
- 添加 ytdl 依赖

## [0.0.4] -- 2025-08-14

### Fixed

- 修复无法强制更新问题

## [0.0.3] -- 2025-08-13

### Added

- 新增 npm_install，简单封装安装依赖功能，统一外部插件安装依赖方法
- 新增 远程安装插件以及删除插件功能

### Fixed

- 修复装相同插件缓存问题
- 完善 help 插件
