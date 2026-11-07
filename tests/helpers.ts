import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSettings } from '../src/config.js';
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'shiguang-test-'));
  const value = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  value.dataDir = dir;
  const settings = parseSettings(value, join(dir, 'config.json'));
  return { dir, settings, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
