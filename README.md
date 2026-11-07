# 拾光 Shiguang：个人 QQ × B 站 × 当天优先记忆

拾光，是把每天的聊天、见闻和记忆收集起来的 AI 伙伴。它是从零编写的独立 DeepSeek Harness（DSH）插件，没有依赖或复制 SurfCore。第一版面向 Windows 本机运行。角色名和人格可自行修改。

仓库：`Lyuu508/dsh-shiguang`。源码 ZIP、预构建安装包及 SHA256 校验文件保存在 [downloads 目录](https://github.com/Lyuu508/dsh-shiguang/tree/main/downloads)，也可以从 [v0.1.0 预览版](https://github.com/Lyuu508/dsh-shiguang/releases/tag/v0.1.0) 页面进入下载。访问私有仓库及下载文件需要登录获授权的 GitHub 账号。

## 已实现

- 通过 NapCat 的 OneBot 11 正向 WebSocket，接收个人 QQ 的白名单私聊、群聊并回复文本。主人私聊默认允许，群聊默认仅在被 @ 时回复。
- B 站手机扫码登录，在本机保存 Cookie；按要求读取视频标题、简介和作者，发表评论或回复已有评论。
- QQ 主人私聊、B 站操作和 DSH 的 `shiguang_chat` 共用同一角色的记忆。其他私人会话、各个群聊分别隔离。
- 正常聊天仅注入**当天重要笔记＋当前聊天最近 12 条消息**。分别限制为 2600 和 4000 字符，不加载整个历史档案。
- 明确追问旧事时，先查本地全文索引：最多 5 条、每条约 240 字符；不足时再按 ID 展开，每页最多 1600 字符。
- 按本机配置时区划分“今天”。过零点后昨天的内容不再自动注入，但仍可检索。
- 使用 DSH 自己的模型连接；插件不需要额外的模型 API Key。

首版未包含：自主刷推荐流、定时自主评论、视频画面/音频理解、B 站私信或动态、QQ 图片语音、断线历史补拉、图形设置面板、语义向量搜索。视频简介读取不等于观看或理解视频内容。

## 环境

- Node.js **24.9 或更新**，包含内置 SQLite / FTS5。
- 本版按 **DSH 0.2.2-rc.1** 的公开插件 API 编写、锁定对应依赖；其他版本需先适配，不能保证直接安装。
- QQ 接入需要另行安装并登录 [NapCat](https://napneko.github.io/)。插件本身不实现 QQ 登录协议，也不分发 QQ 运行时。
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

修改 JSON 后重启 DSH。`dataDir` 的相对路径按**配置文件目录**解析，与打开终端的位置无关。不同角色如需完全独立的数据文件，可以使用不同配置和数据目录。

## 连接个人 QQ

1. 在 NapCat 本机界面完成个人 QQ 扫码登录。
2. 在网络设置添加 **WebSocket 服务端（正向 WS）**，例如 `127.0.0.1:3001`，配置访问 Token，消息上报格式选择 **Array**，启用后保存。Token 不是 NapCat WebUI 密码。
3. 编辑 Shiguang 配置中的 `qq`：

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

4. 启动 DSH 的同一 PowerShell 窗口中设置访问 Token：

```powershell
$env:SHIGUANG_ONEBOT_TOKEN = "你在NapCat设置的Token"
dsh web
```

如果使用 DSH Desktop，需要给其启动进程配置同名环境变量，再退出并重新打开 Desktop。不要在聊天窗口粘贴 Token、密码或 Cookie。

### 模型路由

`provider` 和 `model` 可以同时留空。此时插件复用**第一个非 Shiguang 活跃 DSH 会话当前选择的模型路由**：先在 DSH 打开一个已选择模型的聊天，再在 QQ 发消息。

长期运行建议在配置中同时填写 DSH 实际的 `provider` 路由 ID 和 `model` ID，避免多个活跃会话选择不同模型时出现歧义。这两个值是模型路由标识，不是 API Key；不要照搬其他人的模型名。插件不会从账号设置猜测默认模型。

没有可用路由时会输出明确错误，不发送虚构回复，也不会消耗该 QQ 消息的去重记录。

## 连接 B 站

先在配置中将 `bilibili.enabled` 设为 `true`，再在**你的本机终端**执行：

```powershell
npm run bili:login
```

使用 B 站手机 App 扫描终端二维码并确认。Cookie 保存在 `dataDir/bilibili.cookies.json`，不会作为工具结果传给模型。数据目录继承 Windows 当前用户目录权限；不要把目录放进公共共享或公开仓库。

需要发表评论时，设 `bilibili.allowComments=true`，重启 DSH。默认每日最多尝试 10 次、间隔至少 60 秒；成功与结果不明的请求都会占用额度。配额和去重记录保存在 SQLite 中，重启不会清空。

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

默认不自动删除历史记录，也不永久记住每个过去事实。固定人格 `persona` 另行配置，不把过去的私人档案作为人格常驻注入。

## 验证与排错

```powershell
npm run check
npm test
npm run benchmark
```

测试使用真实的 DSH AgentLoop 和模拟模型、本地 OneBot WebSocket、模拟 B 站 API；不会登录真实账号或发送真实消息。Windows、真实 QQ/B站账号以及真实模型网络仍需本机联调。压测只测数据库读取，不代表 AI 的总回复时间；结果见 `VALIDATION.md`。

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

## 工程结构

| 文件 | 作用 |
|---|---|
| `src/plugin.ts` | 独立 DSH bundle 入口、生命周期、消息队列 |
| `src/agent.ts` | 短会话、当天上下文和受限工具 |
| `src/memory.ts` | SQLite、中文双字检索、分页、操作账本 |
| `src/onebot.ts` | QQ 事件校验、WS 连接、发送回执 |
| `src/bilibili.ts` | 扫码登录、视频元信息、评论与回复 |
| `src/config.ts` | 配置校验和路径解析 |
| `tests/` | 记忆、平台和真实 DSH 调用链测试 |

依赖的接口文档：[DSH 插件开发](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/)、[DSH 工具定义](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/tool)、[NapCat 连接设置](https://napneko.github.io/config/basic)、[B站扫码接口收集](https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/docs/login/login_action/QR.md)、[B站评论接口收集](https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/docs/comment/action.md)。

MIT 许可。第三方组件按各自许可使用。
