import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSettings } from '../src/config.js';
const raw = () => JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
test('配置拒绝缺失模型路由、无效时区、错误类型和明文 URL 凭据', () => {
  let value = raw(); value.model = 'a-model'; assert.throws(() => parseSettings(value, '/tmp/shiguang/config.json'), /同时/);
  value = raw(); value.timezone = 'not-a-timezone'; assert.throws(() => parseSettings(value, '/tmp/shiguang/config.json'));
  value = raw(); value.qq.wsUrl = 'ws://user:pass@127.0.0.1'; assert.throws(() => parseSettings(value, '/tmp/shiguang/config.json'), /凭据/);
  value = raw(); value.qq.enabled = true; assert.throws(() => parseSettings(value, '/tmp/shiguang/config.json'), /ownerQQ/);
  value = raw(); value.memory.searchLimit = 0; assert.throws(() => parseSettings(value, '/tmp/shiguang/config.json'), /searchLimit/);
});
