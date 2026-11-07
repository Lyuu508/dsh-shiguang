# 拾光安装与使用指南

拾光，是把每天的聊天、见闻和记忆收集起来的 AI 伙伴。它是从零编写的独立 DeepSeek Harness（DSH）插件，没有依赖或复制 SurfCore。当前版本面向 Windows 本机运行。角色名和人格可自行修改。

仓库：`Lyuu508/dsh-shiguang`。源码 ZIP、预构建安装包及 SHA256 校验文件保存在 [downloads 目录](https://github.com/Lyuu508/dsh-shiguang/tree/main/downloads)，也可以从 [v0.1.6 预览版](https://github.com/Lyuu508/dsh-shiguang/releases/tag/v0.1.6) 页面进入下载。

## 在哪里打开面板

安装或升级插件后，**重启 DSH 并刷新页面 → 设置 → 拾光**。面板随插件启停，不需要另开浏览器端口。

- **角色与回复**：名字、人设、时区、模型选择、回复等待时间和字数。
- **语音**：火山复刻音色配置、试听、QQ 语音回复与独立字符用量，见 [语音指南](voice.md)。
- **QQ 连接**：NapCat 自动安装、QQ 扫码、后台入口、主人号、白名单、在线检测及 QQ 识图。
- **B 站账号**：二维码登录、评论权限、标签白黑名单、定时自主生活、文字动态及关键帧 / 字幕视频识别，见 [视频内容指南](bili-video.md)。
- **记忆**：读取预算、当天记录、历史搜索、分页原文、移入回收站与撤销。
- **Token 用量**：按日期分别查看 QQ 聊天、B 站任务、DSH 对话的模型用量，区分未缓存输入、缓存与输出，支持导出 JSON。
- **版本更新**：检查 GitHub Release、查看说明、下载并校验安装包，交给 DSH 安装。

**点击“保存设置”即可生效，无需重启 DSH。** 保存会等待正在处理的消息完成，再应用新的配置；QQ 连接参数更新时会重新连接。其他窗口同时修改配置时会提示冲突，保留当前编辑内容。

首次加载会自动生成默认配置，QQ 和 B 站互动默认关闭，可以直接在面板开始设置。

### 从旧版升级

0.1.1 及更早版本尚无更新按钮，请先下载 [0.1.6 安装包](https://github.com/Lyuu508/dsh-shiguang/blob/main/downloads/dsh-shiguang-0.1.6.tgz)，在文件页面点 **Download raw file**，然后执行：

```powershell
dsh plugin --profile web add "C:\你的下载目录\dsh-shiguang-0.1.6.tgz"
```

重启 DSH 并刷新页面。之后可在 **设置 → 拾光 → 版本更新** 点击“检查更新”和“下载并安装更新”。更新读取此仓库的已发布 Release（含预览版），下载对应 tag 下的预构建包，校验 SHA256 后调用 DSH 插件管理服务；不从 `main` 自动安装未发布的代码。安装时请等待；DSH 替换插件可能关闭设置页，重新打开本页即可查看保存的进度和结果，按提示重启。若 DSH 未启用插件管理服务，可继续手动安装。

配置、登录凭据和记忆存放在原来的本机目录，更新保留这些文件。数据库升级前会按原版本生成 `memory.sqlite.v1-backup`、`.v2-backup` 、`.v3-backup` 、`.v4-backup` 或 `.v5-backup`。校验失败会停止安装，网络或权限错误可重试；GitHub 仓库改为私有后，当前匿名检查方式需要改用手动安装。初次克隆源码后的本机配置和凭据不应上传仓库。

## Token 是多少个中文？

Token 是模型分词后的计量单位，不是字数。汉字、标点、英文和数字的分词因模型不同而变化，几百 Token 不能固定换成几百中文。输出上限限制模型生成预算，部分模型的思考也占用该预算；“单次回复最多字数”才限制文字字符。输入还包含发送的人设、限量上下文和工具结果。

语音合成另外按语音资源和字符等规则计费，语音页单独记录，不合并成聊天 Token。B 站关键帧识别归为“B 站视频识别”。

## 一天的 Token 怎么测

打开 **设置 → 拾光 → Token 用量**，选今天，点“刷新用量”。首次安装本版后开始记录，旧聊天不补算。

1. 选择固定模型，记下开始时的合计；用 QQ 做一组普通聊天，刷新查看增量。
2. 明确追问“上次聊的……”，再刷新，比较带历史检索时的增量。模型调用检索工具后还需继续生成，因此一次回复可能产生多次模型调用。
3. 用主人私聊要求读取指定 B 站视频，或在允许评论时按要求评论，再查看“B 站任务”增量。扫码、检测账号、B 站 HTTP 请求本身不会消耗模型 Token。
4. 正常运行一天后导出当天 JSON，与服务商相同时区的用量核对。建议用专用 API Key 或服务商项目，避免混入其他应用的调用。

**统计归属：** B 站操作可以由 QQ / DSH 对话或定时自主生活触发；自主思考单独归入“B 站自主生活”。一轮只要调用过 B 站工具，该轮所有模型请求归入“B 站任务”；媒体的单次模型调用独立归为“QQ 视频 / 动图”，其他轮次按“QQ 聊天”或“DSH 对话”归类，合计不重复。混合聊天与 B 站操作无法精确按主题拆分，整轮归类便于观察任务成本。

普通对话统计来自 DSH `assistant/message` 与 `assistant/attempt` 的实际 usage，媒体识别采集单次模型请求的 usage，包含工具步骤、重试和已结算的中断。未缓存输入、缓存读取、缓存写入、输出分别累加；推理 Token 作为输出明细，不再重复加入合计。无 usage 的调用标为“缺失”，已知合计不能当作完整账单。进程意外退出前尚未结算的请求可能未入账。只统计拾光创建的模型调用；DSH 主会话调用 `shiguang_chat` 前后的主会话消耗，以及其他插件不在本表内。每天按调用发生时配置的时区归档，修改时区不会重算旧记录。Token 数量不等于费用，缓存和不同模型的单价应以服务商为准。

### 每次会读完整上下文和全部记忆吗

不会读取全部历史档案。普通聊天每轮新建短会话，只带人设、工具说明、当天笔记（默认最多 2600 字符）、当前线程当天最近对话（默认 12 条且最多 4000 字符）和本次输入。明确提到旧事时，才允许搜索历史索引并按需展开少量原文。

**每次实际发送给模型的这些内容仍会计入输入 Token**；命中服务商缓存时按缓存用量统计。SQLite 查询本身不调用模型，不消耗模型 Token；模型选择检索工具、接收片段并继续回答会产生相应输入、输出。多步工具调用中，已有上下文和工具结果也可能再次发送。记忆预算按字符限制，不是精确的 Token 上限。

![拾光在真实 DSH 0.2.2-rc.1 设置中的入口与面板](settings-dsh-native.png)

## 已实现

- 通过 NapCat 的 OneBot 11 正向 WebSocket，接收个人 QQ 的白名单私聊、群聊并回复文本。主人私聊默认允许，群聊默认仅在被 @ 时回复。
- B 站手机扫码登录，在本机保存 Cookie；按要求读取视频标题、简介和作者，发表评论或回复已有评论。
- QQ 主人私聊、B 站操作和 DSH 的 `shiguang_chat` 共用同一角色的记忆。其他私人会话、各个群聊分别隔离。
- 正常聊天仅注入**当天重要笔记＋当前聊天最近 12 条消息**。分别限制为 2600 和 4000 字符，不加载整个历史档案。
- 明确追问旧事时，先查本地全文索引：最多 5 条、每条约 240 字符；不足时再按 ID 展开，每页最多 1600 字符。
- 按本机配置时区划分“今天”。过零点后昨天的内容不再自动注入，但仍可检索。
- 使用 DSH 自己的模型连接；插件不需要额外的模型 API Key。

尚未包含：无范围限制的推荐流浏览、原始音频转写、B 站私信、QQ 空间动态、QQ 语音、断线历史补拉、语义向量搜索。视频简介读取不等于观看或理解视频内容。

## 环境

- Node.js **24.9 或更新**，包含内置 SQLite / FTS5。
- 本版按 **DSH 0.2.2-rc.1** 的公开插件 API 编写、锁定对应依赖；其他版本需先适配，不能保证直接安装。
- Windows x64 首次启动会自动准备 [NapCat](https://napneko.github.io/) 官方便携运行包，插件内扫码；其他系统连接已有实例。详见 [NapCat 安装与后台](napcat.md)。
- B 站使用普通账号的 Web 会话接口，并非官方开放平台授权应用；这些接口可能调整，验证码和账号验证需要在官方客户端处理。

## Windows 安装

在源码文件夹打开 PowerShell。已安装且可运行的 `dsh` 命令应位于 PATH：

```powershell
node --version
dsh --version
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run setup
dsh plugin --profile web add (Get-Location).Path
```

也可以在查看脚本后执行 `scripts/Install-Windows.ps1 -Profile web`，完成依赖安装、构建、初始化配置和插件注册。脚本不代你登录账号，不会覆盖现有配置。

默认配置文件：`%USERPROFILE%\.dsh\shiguang\config.json`。

需要其他位置时，在启动 DSH 的同一终端设置：

```powershell
$env:DSH_SHIGUANG_CONFIG = "D:\ShiguangData\config.json"
```

面板保存会即时生效；如果手动修改 JSON，仍需重启 DSH。`dataDir` 的相对路径按**配置文件目录**解析，与打开终端的位置无关。不同角色如需完全独立的数据文件，可以使用不同配置和数据目录。

## 连接个人 QQ

推荐 Windows x64 使用 QQ 页的自动安装与扫码流程，见 [NapCat 安装与后台](napcat.md)。以下步骤适用于选择“连接已有 NapCat”的用户：

1. 在 NapCat 本机界面完成个人 QQ 扫码登录。
2. 在网络设置添加 **WebSocket 服务端（正向 WS）**，例如 `127.0.0.1:3001`，配置访问 Token，消息上报格式选择 **Array**，启用后保存。Token 不是 NapCat WebUI 密码。
3. 推荐在 **设置 → 拾光 → QQ 连接** 填写地址、Token、主人 QQ 号和白名单，开启 QQ 回复后保存。Token 存入本机 `dataDir/onebot.token`，不会回显到页面或发送给模型。

如果你更习惯手动配置，也可以编辑配置中的 `qq`：

```json
{
  "enabled": true,
  "wsUrl": "ws://127.0.0.1:3001",
  "tokenEnv": "SHIGUANG_ONEBOT_TOKEN",
  "ownerQQ": "你的主人QQ号",
  "allowedPrivate": [],
  "allowedGroups": [],
  "groupMentionOnly": true,
  "actionTimeoutMs": 15000,
  "reconnectMs": 3000
}
```

所有 QQ 号、群号都用**字符串**填写。`ownerQQ` 是向机器人发消息的主人账号，不是 NapCat 登录的机器人账号。其他允许私聊的人放入 `allowedPrivate`，群号放入 `allowedGroups`。

4. 如果已通过面板保存 Token，不必设置环境变量。沿用旧版环境变量方式时，在启动 DSH 的同一 PowerShell 窗口中设置：

```powershell
$env:SHIGUANG_ONEBOT_TOKEN = "你在NapCat设置的Token"
dsh web
```

面板保存的本机 Token 优先，未保存时才读取备用环境变量。使用 DSH Desktop 时也可以直接通过面板配置；如沿用环境变量，则需要给其启动进程配置同名变量，再退出并重新打开 Desktop。不要在聊天窗口粘贴 Token、密码或 Cookie。

### 模型路由

`provider` 和 `model` 可以同时留空。此时插件复用**第一个非 Shiguang 活跃 DSH 会话当前选择的模型路由**：先在 DSH 打开一个已选择模型的聊天，再在 QQ 发消息。

长期运行建议在配置中同时填写 DSH 实际的 `provider` 路由 ID 和 `model` ID，避免多个活跃会话选择不同模型时出现歧义。这两个值是模型路由标识，不是 API Key；不要照搬其他人的模型名。插件不会从账号设置猜测默认模型。

没有可用路由时会输出明确错误，不发送虚构回复，也不会消耗该 QQ 消息的去重记录。

## 连接 B 站

推荐在 **设置 → 拾光 → B 站账号** 点击“生成登录二维码”，用手机确认后启用 B 站工具并保存。想发表评论时，再开启“允许发表评论”并设置额度。

终端登录方式仍然保留，在**你的本机终端**执行：

```powershell
npm run bili:login
```

使用 B 站手机 App 扫描终端二维码并确认。Cookie 保存在 `dataDir/bilibili.cookies.json`，不会作为工具结果传给模型。数据目录继承 Windows 当前用户目录权限；不要把目录放进公共共享或公开仓库。

通过面板开启评论后保存即可生效；如果手动改 `bilibili.allowComments=true`，则重启 DSH。默认每日最多尝试 10 次、间隔至少 60 秒；成功与结果不明的请求都会占用额度。配额和去重记录保存在 SQLite 中，重启不会清空。

然后可在主人 QQ 私聊中说：

> 读取这个视频的标题和简介：https://www.bilibili.com/video/你的BV号

> 帮我在这个视频下面评论：“这段讲解很清楚。”

支持 BV 号、av 号和 `bilibili.com/video/...` 完整 HTTPS 链接；`b23.tv` 短链请先在浏览器展开。回复评论还需要根评论 ID 和目标评论 ID。

本版按主人的明确要求执行互动，没有自主浏览定时器。群聊和其他私人会话没有 B 站账号操作工具。网络超时、无评论回执或遇到验证码时，必须先在官方客户端核实，插件不自动重发。已成功执行的平台操作不会因本轮后续 AI 回复失败而撤销。

## 记忆如何读取

```text
日常消息
  → 读取今天的重要笔记、近期消息（固定预算）
  → DSH 生成回复
  → 新事实可记入当天短笔记；聊天记录完整存档

“上周我们聊的吉他是什么型号？”或“/回忆 吉他”
  → 在同一权限范围的历史索引中检索
  → 最多 5 条短片段
  → 片段不足时按 ID 分页读取原文
```

每次响应使用一个新的短 DSH 会话，并在完成后释放；不会通过续用几个月的 DSH 会话，绕过上述预算把全部聊天历史传给模型。重要事实由当前响应中的 `shiguang_note_today` 工具保存，不另开一次模型请求来总结每轮聊天。它不是无损的“全天全文常驻”，很早的当天细节可用 `today` 搜索补查。

“上次、之前、昨天、上周、记得”等明确回忆词会开放本轮历史检索。日常聊天即使模型误调用历史搜索，也会被代码拒绝。规则没识别出隐含的回忆意图时，使用 `/回忆 关键词`。用户更正的事实可另记，但本版尚未实现自动消除相互矛盾的旧事实。

只读查看本机主人的记忆：

```powershell
npm run memory:today
npm run memory:search -- 吉他
```

面板中的“移入回收站”会同时从正常聊天和检索结果中移除该记录；“撤销移除”可恢复原文与索引。回收站位于本机数据库中，移入回收站不等于物理擦除。默认不自动删除历史记录，也不永久记住每个过去事实。固定人格 `persona` 另行配置，不把过去的私人档案作为人格常驻注入。

## 验证与排错

运行完整测试前，请先安装 FFmpeg 与 FFprobe 并加入 PATH。

```powershell
npm run check
npm test
npx playwright install chromium
npm run test:ui
npm run benchmark
```

测试使用真实的 DSH AgentLoop 和 Connection 路由、模拟模型、本地 OneBot WebSocket、模拟 B 站 API，并用 Chromium 检查设置面板的实际交互；不会登录真实账号或发送真实消息。Windows、真实 QQ/B站账号以及真实模型网络仍需本机联调。压测只测数据库读取，不代表 AI 的总回复时间；结果见 `VALIDATION.md`。

常见情况：

| 现象 | 检查 |
|---|---|
| 插件拒绝安装 | DSH 版本是否满足 `engines.dsh`；本版依赖锁定 0.2.2-rc.1 |
| QQ 连不上 | 正向 WS 地址、Token 环境变量、NapCat 登录状态和服务是否启用 |
| QQ 连上却没反应 | Array 上报格式、主人号、私聊或群白名单、群里是否 @；查看 `[Shiguang]` 日志 |
| 没有模型路由 | 先打开一个已选择模型的 DSH 会话，或填写 provider/model |
| B站要求重新登录 | 执行 `npm run bili:login`；不要把登录 Cookie 发给 AI |
| AI 回复超时 | 检查模型速度与 `replyTimeoutMs`；已发出的评论需要另外核实 |
| QQ 发送结果不明 | 在 QQ 查看是否已发送；插件不会自动重复发送 |
| 消息重复后不处理 | 为避免重复评论，已接收事件跨重启去重；本版没有自动恢复未完成消息的机制 |

外部聊天只开放当前角色的记忆与授权平台工具，不向 QQ 群友开放 DSH 的终端或文件读取能力。模型输入属于你所配置模型服务的数据处理范围；本机存档不意味着模型调用离线。

## 旧数据库与回退

从旧版本升级沿用原 profile 和数据目录，步骤见上方“从旧版升级”。数据库版本升为 5，升级前先保存对应的 `.v1-backup`、`.v2-backup`、`.v3-backup` 、`.v4-backup` 或 `.v5-backup`，再添加缺失的表，不清空原记忆和评论账本。旧版插件无法直接打开新版数据库；回退前需停止插件、另外保留当前数据目录，并使用相应的旧库备份，避免丢失更新后的记录。首次保存 0.1.0 配置时会补入角色名字字段。

## 工程结构

| 文件 | 作用 |
|---|---|
| `src/plugin.ts` | 独立 DSH bundle 入口与生命周期 |
| `src/runtime.ts` | 消息队列、配置热应用、凭据与扫码会话 |
| `src/panel-api.ts` | DSH 认证保护下的设置面板接口 |
| `client/` | DSH 原生设置入口、七个页面与响应式布局 |
| `src/agent.ts` | 短会话、当天上下文和受限工具 |
| `src/memory.ts` | SQLite、中文双字检索、分页、操作账本 |
| `src/onebot.ts` | QQ 事件校验、WS 连接、发送回执 |
| `src/bilibili.ts` | 扫码登录、视频元信息、评论与回复 |
| `src/config.ts` | 配置校验和路径解析 |
| `src/usage.ts` | 模型 usage 采集、每日分类和模型汇总 |
| `src/updates.ts` | GitHub Release 检查、包校验、安装与进度保存 |
| `tests/` | 记忆、平台和真实 DSH 调用链测试 |

依赖的接口文档：[DSH 插件开发](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/)、[DSH 工具定义](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/tool)、[NapCat 连接设置](https://napneko.github.io/config/basic)、[B站扫码接口收集](https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/docs/login/login_action/QR.md)、[B站评论接口收集](https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/docs/comment/action.md)。

MIT 许可。第三方组件按各自许可使用。
