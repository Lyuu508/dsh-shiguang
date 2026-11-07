import { join } from 'node:path';
import QRCode from 'qrcode';
import { configFile, loadSettings } from './config.js';
import { MemoryStore } from './memory.js';
import { BilibiliClient } from './bilibili.js';

async function main(): Promise<void> {
  const settings = loadSettings();
  const memory = new MemoryStore(join(settings.dataDir, 'memory.sqlite'), settings.roleId, settings.timezone, settings.memory);
  try {
    switch (process.argv[2]) {
      case 'login': {
        const bili = new BilibiliClient(settings, memory);
        const login = await bili.startLogin();
        console.log('用 B 站手机 App 扫描二维码，并在手机上确认登录。不要把这个二维码发给别人。');
        console.log(await QRCode.toString(login.url, { type: 'terminal', small: true }));
        const deadline = Date.now() + 180000;
        let last = '';
        while (Date.now() < deadline) {
          const status = await bili.pollLogin(login.key);
          if (status === 'success') { console.log('B 站登录成功，Cookie 已保存到本机私有数据目录。'); return; }
          if (status === 'expired') throw new Error('二维码已失效，请重新运行登录命令');
          if (status !== last) console.log(status === 'scanned' ? '已扫码，请在手机确认。' : '等待扫码…');
          last = status;
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        throw new Error('扫码超时，请重新运行登录命令');
      }
      case 'today': console.log(JSON.stringify(memory.fastContext('owner', 'qq:private:' + settings.qq.ownerQQ), null, 2)); break;
      case 'search': console.log(JSON.stringify(memory.search('owner', process.argv.slice(3).join(' ')), null, 2)); break;
      default: console.log(`配置文件：${configFile()}\n命令：npm run bili:login / npm run memory:today / npm run memory:search -- 关键词`);
    }
  } finally { memory.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : '操作失败'); process.exitCode = 1; });
