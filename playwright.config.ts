import {defineConfig} from '@playwright/test';
import {existsSync} from 'node:fs';
export default defineConfig({
 testDir:'tests/browser',testMatch:'*.spec.ts',workers:1,timeout:45000,
 use:{baseURL:'http://127.0.0.1:4178',headless:true,colorScheme:'light',viewport:{width:1180,height:1050},launchOptions:existsSync('/usr/bin/chromium')?{executablePath:'/usr/bin/chromium',args:['--no-sandbox']}:{}},
 webServer:{command:'node --import tsx tests/browser/server.ts',url:'http://127.0.0.1:4178',reuseExistingServer:false,timeout:20000},
 outputDir:'test-results',reporter:'list',
});
