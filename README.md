<div align="center">

# 拾光 Shiguang

**一个在 QQ 聊天、帮你处理 B 站互动，还记得今天发生了什么的 AI 伙伴。**

[![版本](https://img.shields.io/github/v/release/Lyuu508/dsh-shiguang?include_prereleases&label=Release)](https://github.com/Lyuu508/dsh-shiguang/releases)
![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-386a51)
![Node](https://img.shields.io/badge/Node.js-%E2%89%A524.9-386a51)
![License](https://img.shields.io/badge/License-MIT-blue)

[下载安装](https://github.com/Lyuu508/dsh-shiguang/releases/tag/v0.1.3) · [使用指南](docs/guide.md) · [QQ 视频与动图](docs/qq-media.md) · [更新记录](CHANGELOG.md)

</div>

拾光是独立的 DeepSeek Harness 插件，面向 Windows 本机使用。名字、人设、模型和连接都可以在 DSH 设置里调整，QQ 主人私聊、B 站操作与 DSH 对话共用一份记忆。

## 它能做什么

| 功能 | 已实现的能力 |
|---|---|
| QQ 聊天 | 通过 NapCat 登录个人 QQ，回复白名单私聊和群聊；支持仅被 @ 时回复 |
| QQ 视频与动图 | 识别短视频、GIF 和图片的主要画面；支持附文字或引用媒体提问，可随时关闭 |
| B 站互动 | 手机扫码登录，读取视频标题、简介和作者，按主人要求发表评论或回复评论 |
| 共享记忆 | 记住今天的重要事实；明确追问旧事时才检索历史短片段 |
| 角色设置 | 修改名字、人设、模型和回复限制，保存后即时生效 |
| 记忆管理 | 查看某天记录、搜索往事、展开原文、移入回收站和撤销 |
| 用量统计 | 按天查看 QQ 聊天、QQ 媒体、B 站任务和 DSH 对话的真实 Token 用量，支持导出 |
| 版本更新 | 检查本仓库 Release，查看说明、校验安装包并交给 DSH 安装 |

QQ 视频与动图识别、B 站评论默认关闭。B 站目前读取的是视频元信息，画面识别用于你在 QQ 里发来的媒体。

## 本次更新 · 0.1.3

- **新增 QQ 识图页面**：开关视频、GIF、图片识别，支持“看看”按需触发、引用媒体提问和自动识别。
- **减少视觉调用用量**：本机抽帧去重，默认最多 3 帧拼为一张小图；一次调用完成摘要和回答，重复媒体优先复用文字摘要。
- **增加预算控制**：关键帧数、拼图尺寸、输出 Token、当天背景和每日调用次数均可调整；媒体用量单独统计。
- **整理展示**：README 介绍能做什么与本次重点，安装细节和完整历史移到独立文档。

[查看完整更新记录 →](CHANGELOG.md)

## 在 DSH 中调整

安装后重启 DSH 并刷新页面，打开 **设置 → 拾光**。

角色与回复 · QQ 连接 · B 站账号 · 记忆 · Token 用量 · 版本更新 · QQ 识图

<details>
<summary>展开 QQ 识图设置预览</summary>

![拾光 QQ 识图设置面板](docs/settings-media.png)

</details>

设置保存后生效。版本安装完成后，按提示刷新或重启 DSH；配置和记忆保留在原目录。

## 看视频，怎样尽量省 Token

默认使用按需模式：**发送媒体并附上“看看”，或引用媒体消息说“看看”。**

1. FFmpeg 在本机抽取候选画面，筛掉相近内容，最多保留 3 个关键帧。
2. 拼成一张最长边不超过 512 像素的小图，只调用一次视觉模型。
3. 返回简短回答，把客观画面摘要记入当前会话；后续聊天不重复发送视频或拼图。
4. 同一会话再次遇到相同媒体时，优先复用摘要，进行一次简短文字回答。

本机下载、抽帧和筛选不调用模型。图像计费由你选择的模型决定，实际消耗可以在 **Token 用量 → QQ 视频 / 动图** 查看。需要字幕细节时可切换清晰预设，用更多 Token 换取更清楚的输入。

这是关键帧画面识别，暂不识别音频；快速动作、闪现字幕和未抽到的场景可能遗漏。[配置与使用边界 →](docs/qq-media.md)

## 快速开始

需要 **DSH 0.2.2-rc.1、Node.js 24.9+**。QQ 连接还需要 [NapCat](https://napneko.github.io/)；QQ 识图另需 **FFmpeg / FFprobe** 和 DSH 中已配置的**视觉模型**。

已安装 0.1.2：在 **设置 → 拾光 → 版本更新** 更新即可。

首次安装或使用更早版本：从 [Release](https://github.com/Lyuu508/dsh-shiguang/releases/tag/v0.1.3) 打开 `dsh-shiguang-0.1.3.tgz`，点击 **Download raw file**，然后在 PowerShell 执行：

```powershell
dsh plugin --profile web add "C:\你的下载目录\dsh-shiguang-0.1.3.tgz"
```

重启后在面板连接 QQ、扫码登录 B 站。要识别媒体，再打开 QQ 识图，选择支持图片的模型并检测媒体工具。

- [安装、连接与常见问题](docs/guide.md)
- [视频与动图配置、预算和限制](docs/qq-media.md)
- [验证记录](VALIDATION.md)
- [源码与安装包](downloads/)

尚未实现：自主刷 B 站推荐、定时自主评论、B 站私信或动态、QQ 语音理解。Windows 与真实账号仍需本机联调；验证范围见验证记录。

MIT License · [反馈问题](https://github.com/Lyuu508/dsh-shiguang/issues)
