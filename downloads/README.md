# 下载拾光 Shiguang v0.1.10

适配 DSH 0.2.2-rc.1、Node.js 24.9+。本版简化 QQ 一键启动、补齐后台凭据入口，修复 FFmpeg 仓库迁移导致的下载失败，并统一最新 DeepSeek Flash。

- [预构建 TGZ](dsh-shiguang-0.1.10.tgz)：交给 DSH 插件管理安装。
- [源码与预构建 ZIP](dsh-shiguang-0.1.10.zip)：含完整源码、中文说明与脚本。
- [SHA256SUMS-0.1.10.txt](SHA256SUMS-0.1.10.txt)：安装前核对摘要。

点击文件后选 **Download raw file / 下载原始文件**，也可从 [版本页](https://github.com/Lyuu508/dsh-shiguang/releases/tag/v0.1.10) 进入。

安装后重启 DSH 并刷新页面 → 设置 → 拾光。QQ 页填主人号、开回复并保存，再点一键启动；消息地址与 Token 自动同步。后台登录凭据可在插件显示或复制，不会重置你已经修改的密码。

SnowLuma 官方 ZIP 由你下载并解压，插件提供已核对的 Windows 完整版链接及定位按钮，不捆绑专有组件。FFmpeg / FFprobe 优先定位已有程序，缺失时校验下载；支持 Windows 系统网络备用方式。模型无需手选，但仍需在 DSH 登录 DeepSeek 或配置官方 API 连接。

已有配置、角色与记忆保留。真实 Windows / QQ 账号、系统代理和 hook 仍需本机联调；本次使用模拟平台和模型验证，见 [验证记录](../VALIDATION.md)。
