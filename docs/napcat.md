# NapCat 安装、扫码与后台

在 **设置 → 拾光 → QQ 连接** 操作。QQ 识图也在这个页面下方。

## 随插件安装（Windows x64）

安装拾光并重启 DSH 后，首次加载自动查询 NapCat 官方 `NapNeko/NapCatQQ` 的最新稳定 Release，下载 `NapCat.Shell.Windows.Node.zip`，按该 Release 的 SHA256 和大小校验，然后解压、启动。不会运行未经校验的安装脚本，不需要管理员权限，不替换桌面 QQ。DSH 安装插件时即使禁用了 npm 生命周期脚本，这条首次启动流程也会执行。

这是在线准备运行环境：插件 TGZ 不内嵌百余 MB 的 NapCat / QQ 二进制，首用需连接 GitHub；准备成功后复用本机文件，不会随着拾光每次升级重新下载 NapCat。自动安装只支持 Windows x64，其他系统可接已有 NapCat。

1. 等 QQ 页显示 NapCat 已就绪。下载失败时点安装 / 重试按钮。
2. 点击 **扫码登录 QQ**，用手机 QQ 扫码并确认。二维码在本机生成图片，不需要额外扫码服务，也不调用模型。
3. 托管模式扫码成功后自动配置正向 WebSocket、Array 消息格式与随机访问 Token。
4. 填写下方**主人 QQ 号**、白名单，开启 QQ 回复并保存。主人通常是另一个账号，不是扫码登录的机器人账号。
5. 点击检测连接，再用主人账号发消息验证。

后台默认 `http://127.0.0.1:6099`，OneBot 默认 `ws://127.0.0.1:3001`。更改端口前先保存设置。仅连接本机回环地址，托管的 OneBot 需要明确端口。端口被其他程序占用会停止启动，不覆盖对方配置。

默认运行目录为 `dataDir/napcat/runtime`，配置与 QQ 数据为 `dataDir/napcat/work`，本机日志为 `dataDir/napcat/napcat.log`。数据与 DSH 插件包分开，升级保留；退出 DSH 会停止它启动的实例。后台日志可能含登录信息，分享前请先清理。

## 打开 NapCat 后台

点击 **打开 NapCat 后台**，新窗口会进入本机 WebUI；已保存的 WebUI Token 会通过 NapCat 支持的登录链接传入，不需要再复制。请允许浏览器打开新窗口，勿分享带 Token 的地址。

若后台开启了双重验证，插件不会绕过；请在后台完成验证与 QQ 登录。手机要求的设备验证、滑块等也在官方界面处理。

## 已有 NapCat

旧版已启用 QQ 的配置，升级时默认选择“连接已有 NapCat”，不会自动覆盖现有安装或连接。

1. 选择“连接已有 NapCat”并保存。
2. 展开高级设置，填写本机后台地址，例如 `http://127.0.0.1:6099`；保存设置。
3. 填写控制台显示的 **NapCat WebUI Token**，点击“保存后台密钥”。密钥仅保存在本机，不回显给模型或常规状态请求。
4. 点击扫码或打开后台。外部实例的 OneBot 配置不会自动修改。
5. 在 NapCat 网络配置里新建正向 WebSocket 服务端：Host `127.0.0.1`、端口 `3001`、自己设置访问 Token、消息格式 `Array`，保存并启用。
6. 在拾光填写对应的 `ws://127.0.0.1:3001`、**OneBot Token**、主人 QQ 号和白名单，开启回复并保存。

WebUI Token 是后台登录密钥；OneBot Token 是消息连接密钥，两者不同。修改后台密码后可在高级设置更新 WebUI Token。更改托管后台监听地址后，请退出 DSH 再启动，以应用 NapCat 的监听配置。

## 常见问题

| 提示 | 处理 |
|---|---|
| GitHub 下载失败 | 确认 Windows 本机能访问官方 GitHub Release，再在面板重试；不影响已有记忆 |
| 缺少有效 SHA256 / 校验失败 | 本次不解压或启动，重新获取官方版本；不要绕过校验 |
| 后台端口被占用 | 改用已有 NapCat 模式，或换一个本机后台端口并重启 |
| 另一个 DSH 正在准备 | 等前一个实例结束；确定进程已退出后再处理本机安装锁，避免同时解压 |
| 启动失败 / 缺少 DLL | 查看本机 `napcat/napcat.log`；按 NapCat 官方说明安装微软 Visual C++ x64 运行库 |
| 双重验证 / 设备验证 | 打开 NapCat 后台完成，不在聊天里发送密码或验证码 |
| QQ 已登录但没有回复 | 填主人号、开启回复并保存，再检测 OneBot 连接和模型路由 |
| 新窗口无法打开 | 允许浏览器弹出本机 NapCat 窗口后重试 |

接口实现依据 [NapCat v4.18.42 WebUI 路由](https://github.com/NapNeko/NapCatQQ/tree/v4.18.42/packages/napcat-webui-backend/src/router)、[鉴权](https://github.com/NapNeko/NapCatQQ/blob/v4.18.42/packages/napcat-webui-backend/src/helper/SignToken.ts)、[便携启动入口](https://github.com/NapNeko/NapCatQQ/blob/v4.18.42/packages/napcat-develop/index.js) 与官方 Release。后续接口变化以实际版本为准。
