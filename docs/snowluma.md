# QQ 快速开始与后台凭据

## 一次安装，以后一键启动

1. 安装官方桌面 QQ（NTQQ），与 SnowLuma 使用同一 Windows 用户和权限。
2. 在拾光 QQ 页点击“下载 SnowLuma Windows 完整版 ZIP”，下载后右键全部解压。当前核对版本为官方 v2.4.2；[其他发行版](https://github.com/SnowLuma/SnowLuma/releases)。完整版包含 Node。
3. 填主人 QQ 号，开启 QQ 回复并保存。主人是向伙伴发消息的另一个账号。
4. 点击“一键启动 QQ”：快速定位常用目录 → 准备 / 读取本机连接配置 → 启动 SnowLuma 和桌面 QQ → 后台就绪后打开系统浏览器。
5. 在 QQ 原生窗口手机扫码，完成 SnowLuma 官方首次协议与账号验证，等待插件显示已连接。

压缩包必须先解压；特殊目录可在高级设置填写含 `index.mjs` 的文件夹。自动定位查找桌面、下载、常见安装目录、PATH / QQ 注册信息和插件数据目录，限制目录深度与时间，不扫描整块硬盘。未找到时不会随便执行其他程序。

按 [SnowLuma EULA §5.4](https://github.com/SnowLuma/SnowLuma/blob/main/EULA.md)，第三方捆绑专有组件或自动部署有授权要求；拾光仅提供官方浏览器下载链接，下载和解压由你完成，其余连接操作由插件处理。

## 后台令牌 / 密码在哪里

“后台登录凭据”区域提供“显示”和“复制”。只有主人的 DSH 设置接口能取回；常规状态、模型上下文、共享记忆不包含明文。它是 SnowLuma 网页要求的登录凭据，与消息 Token 分开。

- **全新数据目录**：用官方支持的 `SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD` 环境变量设置强随机凭据，私有保存到 `dataDir/snowluma/webui-secret.json`，不需要去黑窗口找。
- **旧版拾光启动的实例**：从本机私有 `snowluma/runtime.log` 识别首次凭据，并与当前 `config/webui.json` 的哈希匹配后取回。新启动日志会隐藏初始凭据明文。
- **你已经修改过密码**：插件不覆盖、不重置密码。只保存哈希的密码无法反推，请使用你设定的密码。
- **跳过了首次改密且没有旧日志**：先关闭外部启动的 SnowLuma，再从拾光启动；官方会重新生成尚未完成改密的初始凭据，插件会捕获并私有保存。不会停止不属于拾光的进程。

后台网页默认 `http://127.0.0.1:5099/`。直接链接、当前页和系统浏览器入口均保留，避免弹窗句柄导致误报。

## 为什么不用填消息地址和 Token

这些值仍然用于 OneBot v11 正向 WebSocket，只是由程序处理。插件读取本机 `config/onebot.json` 和 `onebot_<QQ号>.json`，按官方快照 / 覆盖规则合并，从启用的 Universal WS 服务同步地址与访问 Token。不会为省步骤关闭鉴权。

新目录没有 OneBot 配置时创建仅绑定本机的带随机 Token 服务；已有配置不覆盖。只接受可用于收发的本机服务与非空密钥。多个已登录账号时，在高级选项选择“SnowLuma 收发消息 QQ 号”，避免连错账号。

同步密钥写入本机 `onebot.token`，不放进普通配置或状态。扫码后连接配置变化会再次同步，界面无未保存编辑时自动刷新；你正在输入的设置会保留。

## 常见问题

| 现象 | 处理 |
|---|---|
| 找不到程序 | 确认 ZIP 已全部解压；点自动定位，仍找不到再填写高级目录 |
| 打开后台却没有凭据 | 在插件点显示 / 复制；已改密时使用自己的密码 |
| QQ 已扫码仍等待连接 | 核对官方 hook 状态、QQ 兼容版本及启用的 Universal 正向 WS；可再点一键启动同步 |
| 多个 QQ 账号 | 在高级选项选择负责收发的账号，主人号仍填自己的另一个账号 |
| 没有弹出网页 | 点系统浏览器入口，或使用直接 / 当前页链接 |
| 目录没有写入权限 | 将 SnowLuma 完整包解压到自己可写的目录后重新定位 |

退出插件只停止它自己启动的 SnowLuma，不关闭 QQ。实际 Windows hook、扫码和真实账号仍需在你的电脑联调。

依据：[官方 Windows 部署](https://snowluma.github.io/zh/docs/guide/deploy/windows)、[v2.4.2 后台鉴权](https://github.com/SnowLuma/SnowLuma/blob/v2.4.2/packages/core/src/webui/auth.ts)、[OneBot 配置](https://github.com/SnowLuma/SnowLuma/blob/v2.4.2/packages/onebot/src/config.ts)。
