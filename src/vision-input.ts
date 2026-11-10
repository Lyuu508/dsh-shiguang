import type {Context} from '@deepseek-ai/cordis';
import type {ImageAttachmentRef} from '@deepseek-ai/dsh-attachment';
import {longEdgeDimensions} from '@deepseek-ai/dsh-attachment';
import sharp from 'sharp';

/** A bounded preview of the actual attachments, made locally without a model call. */
export async function inspectVisionInput(ctx:Context,images:ImageAttachmentRef[],signal:AbortSignal){
 const attachments=ctx.get('attachments');if(!attachments)throw Error('当前 DSH 缺少图片附件服务');
 const previews:string[]=[],facts:{width:number;height:number;previewBytes:number;nearlyBlank:boolean}[]=[];
 for(const image of images){signal.throwIfAborted();const size=longEdgeDimensions(image.width,image.height,640),request=await attachments.readImageRequest(image,{...size,maxBytes:300000},signal);
  const bytes=await sharp(request.data).flatten({background:'#ffffff'}).resize({width:640,height:640,fit:'inside',withoutEnlargement:true}).jpeg({quality:70}).toBuffer(),stats=await sharp(bytes).stats();signal.throwIfAborted();
  const nearlyBlank=stats.channels.slice(0,3).every(c=>c.stdev<2)&&(stats.channels.slice(0,3).every(c=>c.mean>248)||stats.channels.slice(0,3).every(c=>c.mean<7));previews.push('data:image/jpeg;base64,'+bytes.toString('base64'));facts.push({width:image.width,height:image.height,previewBytes:bytes.length,nearlyBlank});
 }
 return {previews,facts,nonBlank:facts.some(f=>!f.nearlyBlank)};
}
export function visionHasNoInput(text:string,nonBlank=true){
 return /看不(?:到|见).{0,8}(?:图片|图像|画面|图).{0,8}(?:内容|东西)|(?:图片|图像|画面).{0,4}(?:是|为).{0,4}空白|(?:没有|未|没|无法|不能|看不到|看不见).{0,8}(?:收到|提供|获取|看到|看见|访问|读取|查看).{0,10}(?:图片|图像|画面)|(?:未提供|没有收到|未收到|没有上传).{0,8}(?:图片|图像)|(?:只能|只).{0,6}(?:看到|收到).{0,8}(?:文字|文本|发了图片|发送了图片)|(?:请|能否|可以).{0,6}(?:描述|告诉我).{0,8}(?:图片|图像).{0,6}(?:内容|有什么)|(?:图片|图像|画面).{0,8}(?:未附上|不可见|加载失败)/.test(text)||nonBlank&&/(?:全是|只有|完全|就是|一片|全都|全).{0,5}空白|空白一片|图片是空的|图像为空|没有任何(?:图像|画面|图片)内容/.test(text);
}
