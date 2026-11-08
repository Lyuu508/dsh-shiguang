export class BiliBlockedError extends Error {
 constructor(readonly code:number,readonly stage:string,readonly retryAt:number){super(`B 站暂时限制了${stage}（${code}），请在官方客户端（B站App）检查账号与验证提示；本次停止请求，冷却后再由你发起尝试`);}
}
export function biliStage(url:string){const path=new URL(url).pathname;return path.includes('/search/')?'视频搜索':path.includes('/reply/add')?'推荐评论发送':path.includes('/reply/')?'评论读取':path.includes('/playurl')?'播放地址读取':path.includes('/player/')?'字幕读取':path.includes('/view')?'视频信息读取':path.includes('/tags')?'视频标签读取':path.includes('/history/')?'观看历史读取':path.includes('/nav')?'账号检查':path.includes('/spi')?'浏览会话准备':path.includes('/msg')||path.includes('/session')?'消息读取':'接口请求';}
export function blockedBrowseReply(error:unknown):string|undefined {
 if(!(error instanceof BiliBlockedError))return;
 return `B站这次暂时限制了${error.stage}，这轮浏览没完成，也没有拿到推荐评论的成功回执。你可以先在B站App看看账号是否需要验证，之后再让我试一次。`;
}
