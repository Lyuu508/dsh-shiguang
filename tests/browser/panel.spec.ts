import {test,expect} from '@playwright/test';
import {mkdirSync} from 'node:fs';

test('角色保存、QQ 连接、B站扫码、记忆检索和撤销移除',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');await expect(page.getByRole('heading',{name:/拾光/}).first()).toBeVisible();
 mkdirSync('docs',{recursive:true});await page.screenshot({path:'docs/settings-panel.png',fullPage:true});
 await page.getByLabel('角色名字').fill('');await page.getByRole('button',{name:'保存设置'}).click();await expect(page.getByRole('alert')).toContainText('角色名称');
 await page.getByLabel('角色名字').fill('小拾');await page.getByLabel('性格与人设').fill('你是安静温柔的伙伴，喜欢听我分享日常。');
 await page.getByRole('button',{name:'保存设置'}).click();await expect(page.getByRole('status')).toContainText('已保存并生效');
 await page.reload();await expect(page.getByLabel('角色名字')).toHaveValue('小拾');
 await page.getByRole('tab',{name:'QQ 连接'}).click();await page.getByLabel('OneBot Token',{exact:true}).fill('panel-test-token');await page.getByLabel('启用 QQ 回复',{exact:true}).check();
 await page.getByLabel('其他允许私聊的 QQ 号').fill('10003,10004');await page.getByLabel('允许加入的群号').fill('20001\n20002');
 await page.getByRole('button',{name:'保存设置'}).click();await expect(page.getByRole('status')).toContainText('已保存并生效');await expect(page.getByLabel('OneBot Token',{exact:true})).toHaveValue('');
 await expect(page.getByText('OneBot 桥接已连接',{exact:true})).toBeVisible({timeout:10000});await page.getByRole('button',{name:'检测已保存的连接'}).click();await expect(page.getByRole('status')).toContainText('模拟QQ伙伴');
 await page.getByRole('tab',{name:'B 站账号'}).click();await page.getByRole('button',{name:'生成登录二维码'}).click();await expect(page.getByRole('img',{name:/扫描登录二维码/})).toBeVisible();
 await expect(page.getByRole('status')).toContainText('B 站登录成功',{timeout:10000});await page.getByRole('button',{name:'检查登录状态'}).click();await expect(page.getByRole('status')).toContainText('测试B站伙伴');
 await page.getByRole('button',{name:'停用本机登录'}).click();await expect(page.getByRole('status')).toContainText('已停用本机 B 站登录凭据');
 await page.getByRole('tab',{name:'记忆',exact:true}).click();await expect(page.getByText('今天练习 C 和弦',{exact:true})).toBeVisible();
 await page.getByLabel('历史搜索最多返回条数').fill('3');await page.getByRole('button',{name:'保存设置'}).click();await expect(page.getByRole('status').first()).toContainText('已保存并生效');
 await page.getByLabel('搜索历史记忆').fill('吉他');await page.getByRole('button',{name:'搜索往事'}).click();await expect(page.getByText('上周选了雅马哈吉他',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'展开原文'}).click();await expect(page.locator('pre')).toContainText('雅马哈吉他');
 await page.getByRole('button',{name:'移入回收站'}).click();await expect(page.getByText('已移入回收站，不再用于聊天。',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'撤销移除'}).click();await page.getByRole('button',{name:'搜索往事'}).click();await expect(page.getByText('上周选了雅马哈吉他',{exact:true})).toBeVisible();
 await page.screenshot({path:'docs/settings-memory.png',fullPage:true});
 await page.reload();await page.getByRole('tab',{name:'记忆',exact:true}).click();await expect(page.getByLabel('历史搜索最多返回条数')).toHaveValue('3');
 await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:'docs/settings-mobile.png',fullPage:true});expect(errors).toEqual([]);
});
