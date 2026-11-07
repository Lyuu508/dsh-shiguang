# 火山复刻语音

入口：**设置 → 拾光 → 语音**，位于“角色与回复”右侧。默认关闭。

## 配置已有复刻音色

1. 先在火山引擎语音控制台开通声音复刻，完成音色训练并取得音色 ID，例如 `S_……`。本版调用已有复刻音色，不上传录音训练。
2. 选择 **APPID + Access Token**，填 APPID、语音服务的 Access Token（请求头名称为 Access Key），点击“保存语音密钥”。这是语音控制台的令牌，不是火山账号 IAM 的 AK / SK。
3. 填复刻音色 ID，选择与音色匹配的 `seed-icl-2.0` 或 `seed-icl-1.0`。新控制台只有 API Key 时可切换 API Key 鉴权方式。
4. 开启火山复刻语音，点击页面底部“保存设置”。再输入试听文字，点击“生成试听”，在页面播放。
5. QQ 私聊中说“用语音回复我……”或“读给我听”。也可以切成自动模式；默认同时发送文字，群聊语音需要另行开启。

只有朗读文本会发送到语音服务，不发送记忆库、聊天上下文、人设或其他账号凭据。密钥单独存放在本机 `dataDir/voice.access-key`，常规设置和状态不回显，不进入模型请求。音色 ID 与 APPID 保存在本机配置中。

## 长度、成本与失败处理

- 默认每条最多朗读 200 字，每日最多尝试 30 次；试听也计入次数。文字回复超过上限时只朗读前面部分，完整文字可以同时保留。
- 语速 0 为原速，100 为 2 倍速，-50 为 0.5 倍速。
- 同一会话、同一音色与文本，优先复用一小时内的内存音频缓存；保存设置或重启后缓存会清空。次数账本跨重启保留。
- 已知语音调用与提交字符数在语音页单独展示；服务端返回计费字符时另外记录。失败或网络结果未知也占用尝试次数，避免自动重复收费。
- 语音服务按照火山实际资源和字符等规则计费，不能与聊天 Token 直接换算；把已有文字合成为语音不额外调用聊天模型。
- 合成失败时保留或回退为文字。QQ 已开始发送但回执未知时不自动重发；双份文字和语音不是一个事务，应以各条平台回执为准。

生成的是 MP3，QQ 语音消息通过 SnowLuma 发送和转换。SnowLuma 的语音转码能力或 FFmpeg 不可用时，应先在本机修复转换环境。当前不识别用户发来的语音，也不提供通话。

## 接口与验证范围

使用火山官方 `POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`，支持 APPID / Access Token 和 API Key 两种鉴权。按流式 JSON 合并有效音频，拒绝业务错误、无效编码、截断和超限响应，不播放半成品。

参考：[火山 HTTP 语音合成](https://docs.volcengine.com/docs/doubao-voice/unidirectional-streaming-text-to-speech-http?lang=zh)、[APPID 与 Access Token 鉴权](https://docs.volcengine.com/docs/doubao-voice/old-version-console-authentication-reference-example?lang=zh)、[控制台说明](https://docs.volcengine.com/docs/doubao-voice/console-guidance?lang=zh)。

测试使用生成的 MP3、模拟火山响应和真实本机 QQ WebSocket，没有配置真实火山账号或产生语音服务费用。音色效果、资源权限、实际计费与真实 QQ 转码需在本机验证。
