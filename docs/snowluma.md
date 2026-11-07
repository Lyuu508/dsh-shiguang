# SnowLuma、QQ 原生扫码与后台

拾光通过 SnowLuma 的 OneBot v11 正向 WebSocket 收发 QQ 消息。Windows 使用腾讯官方桌面 QQ（NTQQ），扫码发生在桌面 QQ 原生窗口。

## 首次安装

1. 安装并打开官方桌面 QQ。SnowLuma 与 QQ 使用同一 Windows 用户和权限。
2. 从 [官方 Release](https://github.com/SnowLuma/SnowLuma/releases) 下载 `win-x64` 完整版，解压到固定目录；精简版需自己准备 Node 22+，拾光自身要求 Node 24.9+。
3. 首次建议双击官方 `launcher.bat`，打开 `http://127.0.0.1:5099/`，按控制台初始管理员密码进入后台。QQ 版本需在 SnowLuma 支持范围。
4. 在桌面 QQ 使用手机扫码。SnowLuma 默认会发现 QQ 并加载官方 hook，登录后进入工作状态。
5. 后台为该 QQ 账号开启 OneBot v11 正向 WebSocket，地址 `127.0.0.1:3001`，设置访问 Token，消息上报格式 Array。
6. 拾光 QQ 页填写 SnowLuma 安装目录（含 `index.mjs`）、OneBot 地址 / Token、主人 QQ 号与白名单，启用 QQ 回复并保存，检测连接。

首次官方程序安装由你完成。[SnowLuma EULA §5.4](https://github.com/SnowLuma/SnowLuma/blob/main/EULA.md) 对将专有组件整合进第三方安装器或自动部署有授权要求，拾光不打包或自动下载这些组件，仅启动、连接本机已安装实例。

## 从拾光启动与扫码

目录保存后，点“启动 SnowLuma 并打开 QQ 扫码”。插件按官方入口运行本机 `index.mjs`，使用安装包里的 Node（存在时），否则使用 DSH 所在 Node。QQ 路径留空时检测常见安装位置，找不到就手填 `QQ.exe` 或手动打开 QQ。

启动请求成功不代表 QQ 已登录；请在 QQ 原生窗口扫码，再用“检测已保存的连接”确认。也可开启“随拾光启动已安装的 SnowLuma”。已有官方实例可直接连接，不必再点启动。

插件启动的进程日志位于 `dataDir/snowluma/runtime.log`，首次后台密码可能在其中，请勿公开。退出拾光只停止它自己启动的 SnowLuma，不关闭桌面 QQ。直接用官方启动器运行的实例由你管理。

## 后台入口

“打开 SnowLuma 后台”使用真实链接打开，默认端口 5099；不把旧版后台鉴权接口用于 SnowLuma。还有复制地址与当前页入口，Desktop 无法打开外部窗口时可把地址粘贴进系统浏览器。

WebUI 管理员密码与 OneBot Token 分开。插件不替你修改后台密码，也不回显 OneBot Token。QQ 与 DSH 不同机时可手动连接已有 OneBot 地址，但本机启动按钮仅用于 Windows，本地表情收藏需要同机文件路径。

## 迁移旧连接

升级保留记忆及账号配置，不会删除之前的第三方运行目录。先停止占用 3001 端口的旧 QQ 桥接实例，再按上方安装 SnowLuma 并在两边设置相同的 OneBot Token。新版本界面及运行时不再启动旧桥接程序，不会迁移其专属后台密码或扫码票据。

## 常见问题

| 现象 | 处理 |
|---|---|
| 没有 QQ 扫码图 | 打开桌面 QQ 窗口扫码；SnowLuma 原生 Windows 不提供旧后台扫码接口 |
| QQ 已打开仍未连接 | 核对 QQ 版本、同一用户与权限、hook 状态及 OneBot 服务端是否启用 |
| 3001 / 5099 被占用 | 停止重复实例，或在官方配置改端口后同步拾光 |
| 找不到 QQ.exe | 填官方桌面 QQ 的实际安装路径 |
| 启动失败 | 核对目录内 `index.mjs`、Node 和官方日志，先手动运行官方启动器 |
| 页面打不开后台 | 使用当前页链接或复制地址到系统浏览器，确认官方服务在运行 |

依据：[官方 Windows 部署](https://snowluma.github.io/zh/docs/guide/deploy/windows)、[配置参考](https://snowluma.github.io/zh/docs/guide/configuration)、[收藏表情接口](https://snowluma.github.io/zh/docs/api/extended/add_custom_face)。真实 Windows 与 QQ 账号仍需本机联调。
