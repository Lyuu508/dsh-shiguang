import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const file = resolve(process.env.DSH_SHIGUANG_CONFIG || resolve(homedir(), '.dsh', 'shiguang', 'config.json'));
if (existsSync(file)) {
  console.log(`配置已存在，保留原文件：${file}`);
} else {
  const template = fileURLToPath(new URL('../config.example.json', import.meta.url));
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, readFileSync(template), { flag: 'wx', mode: 0o600 });
  console.log(`已生成配置：${file}`);
}
console.log('重启 DSH 后进入设置 → 拾光 → QQ 连接，Windows x64 会自动准备 NapCat；扫码后填写主人 QQ 号并开启回复。已有 NapCat 可选择手动连接，密钥不要发到聊天里。');
console.log('timezone=system 使用本机时区；也可以填写明确的 IANA 时区，例如 Asia/Shanghai。');
