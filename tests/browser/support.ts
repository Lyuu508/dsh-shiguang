import {expect,type Page} from '@playwright/test';
export async function expandSettings(page:Page){const button=page.getByRole('button',{name:'展开本页全部设置',exact:true});await expect(button).toBeVisible();await button.click();}
export async function openPage(page:Page){await page.goto('/');await expandSettings(page);}
export async function openTab(page:Page,name:string){await page.getByRole('tab',{name,exact:true}).click();await expandSettings(page);}
export async function reloadExpanded(page:Page){await page.reload();await expandSettings(page);}
