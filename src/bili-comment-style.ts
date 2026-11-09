import type {Settings} from './config.js';
export const DEFAULT_BILI_COMMENT_STYLE='像正常刷视频时随手留一句，围绕画面或评论里的一个具体点，通常一两句；可以有情绪、语气词和合适的梗，不硬玩梗，不写正式总结或夸奖模板。';
/** A generation instruction only. Never rewrites the owner's explicit quote. */
export function biliCommentStyle(settings:Settings){
 return `B站公开评论口吻：${settings.bilibili.commentStyle} 保留你的角色个性，先接住一个真实细节或观点，不复述标题，不默认分点、总结、上价值，也不例行写“感谢UP分享、受益匪浅、值得收藏”。没什么想说可以不发，不用凑句数或互动次数。不要编造看完、实测、经历或私人关系，不带入私聊内容。只调整评论和评论区推荐的表达；主人已指定要发送的原文时，按原文发送，不自行润色。`;
}
