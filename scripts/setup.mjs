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
console.log('请编辑 ownerQQ、启用开关和所需选项；OneBot Token 使用环境变量，不要发到聊天里。');
console.log('timezone=system 使用本机时区；也可以填写明确的 IANA 时区，例如 Asia/Shanghai。');
