# 内置媒体依赖

拾光自己的源码沿用仓库 MIT 许可证。媒体依赖由 DSH 包管理器按锁定版本单独安装，没有将其二进制合并进前端或改写其许可证。

| 依赖 | 版本 | 许可证与源码 |
|---|---|---|
| FFmpeg WebAssembly core | `@ffmpeg/core 0.12.10`，单线程核心 | [包声明 GPL-2.0-or-later](https://www.npmjs.com/package/@ffmpeg/core/v/0.12.10)；[上游源码与构建](https://github.com/ffmpegwasm/ffmpeg.wasm) |
| sharp | `0.35.5` | [Apache-2.0 与依赖说明](https://github.com/lovell/sharp/blob/main/LICENSE)；[源码](https://github.com/lovell/sharp) |
| libvips 及图片编解码库 | sharp 平台包所带版本 | 许可证见所安装 sharp / `@img` 包的 notices，主要图像引擎为 LGPL-2.1-or-later；[libvips 源码](https://github.com/libvips/libvips) |

FFmpeg 版权归其开发者。视频核心依然基于 FFmpeg，只是改为插件依赖中的 WebAssembly 库：不再调用本机的 FFmpeg / FFprobe exe，也不下载旧便携工具包。静态图片使用 DSH 附件服务，GIF / 动画 WebP 使用 sharp，APNG 与常见视频使用内置视频核心。依赖作为独立安装文件可单独替换；修改或重新分发依赖时应同时保留对应许可证、通知和源码获取信息。
