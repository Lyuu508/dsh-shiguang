// This worker only receives already-authorized bytes. It never opens a media URL
// or a host media path. The separate WASM dependency supplies the video codecs.
import {parentPort,workerData} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {pickFrames,pickActionFrames} from './frame-selection.mjs';
let stage='初始化内置解码引擎',logs=[];
const FORMATS='mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,flv,avi,asf,ogg,mpeg,mpegvideo,mpegts,gif,apng,jpeg_pipe,png_pipe,webp_pipe';
const log=message=>{if(message!=='Aborted()'){logs.push(message);if(logs.length>18)logs.shift();}};
async function core(){
 // The upstream browser build needs self.location. All paths use URL conversion
 // (including Windows drive letters, Unicode, and spaces); no fetch is needed.
 globalThis.self={location:{href:import.meta.resolve('@ffmpeg/core')}};
 const {default:create}=await import('@ffmpeg/core');
 const instance=await create({wasmBinary:await readFile(fileURLToPath(import.meta.resolve('@ffmpeg/core/wasm')))});
 instance.setLogger(({message})=>log(message));return instance;
}
function dimensions(w,h){if(!Number.isFinite(w)||!Number.isFinite(h)||w<1||h<1||w>4096||h>4096)throw Error('媒体尺寸无效或超过 4096 像素，请先压缩');}
function durationLimit(duration,c){if(!Number.isFinite(duration)||duration<0||duration>c.maxDurationSeconds)throw Error(`媒体超过 ${c.maxDurationSeconds} 秒或无法确认时长，请先剪短`);}
function apngDuration(bytes){
 if(bytes.subarray(1,4).toString()!=='PNG')return;
 let duration=0,animated=false;
 for(let p=8;p+12<=bytes.length;){const len=bytes.readUInt32BE(p);if(p+len+12>bytes.length)throw Error('PNG 动画数据不完整');const kind=bytes.toString('ascii',p+4,p+8);if(kind==='acTL')animated=true;if(kind==='fcTL'&&len>=26)duration+=bytes.readUInt16BE(p+28)/(bytes.readUInt16BE(p+30)||100);p+=12+len;}
 return animated?duration:undefined;
}
// A tiny vector number font keeps frame stamps independent of OS font installs.
function stamp(text,x,y){const glyphs={'0':['111','101','101','101','111'],'1':['010','110','010','010','111'],'2':['111','001','111','100','111'],'3':['111','001','111','001','111'],'4':['101','101','111','001','001'],'5':['111','100','111','001','111'],'6':['111','100','111','101','111'],'7':['111','001','010','010','010'],'8':['111','101','111','101','111'],'9':['111','101','111','001','111'],'#':['101','111','101','111','101'],'s':['111','100','111','001','111'],'.':['0','0','0','0','1'],' ':['0','0','0','0','0']};let cursor=x,result='';for(const char of text){const glyph=glyphs[char]||glyphs[' '];glyph.forEach((row,r)=>[...row].forEach((pixel,c)=>{if(pixel==='1')result+=`<rect x="${cursor+c*2}" y="${y+r*2}" width="2" height="2" fill="white"/>`;}));cursor+=glyph[0].length*2+2;}return result;}
async function compose(tiles,c,duration,times,sampling){
 if(sampling.mode==='action'){
  const count=Math.min(c.animationImages,Math.ceil(tiles.length/6)),per=Math.ceil(tiles.length/count),panels=[];
  for(let i=0;i<tiles.length;i+=per){const part=tiles.slice(i,i+per),partTimes=times.slice(i,i+per);const panel=await compose(part,{...c,sheetSize:Math.max(1,c.sheetSize-18*Math.ceil(Math.sqrt(part.length))),animationImages:1},duration,partTimes,{...sampling,mode:'uniform'});const cols=panel.sampling.columns,rows=panel.sampling.rows,cell=panel.width/cols;
   const labels=partTimes.map((t,k)=>stamp(`#${i+k+1} ${t.toFixed(2)}s`,k%cols*cell+3,Math.floor(k/cols)*(cell+18)+4)).join('');
   const strips=await Promise.all(Array.from({length:rows},async(_,r)=>({input:await sharp(panel.bytes).extract({left:0,top:r*cell,width:panel.width,height:cell}).toBuffer(),left:0,top:r*(cell+18)+18})));
   const bytes=await sharp({create:{width:panel.width,height:rows*(cell+18),channels:3,background:'#151515'}}).composite([...strips,{input:Buffer.from(`<svg width="${panel.width}" height="${rows*(cell+18)}">${labels}</svg>`),top:0,left:0}]).jpeg({quality:85}).toBuffer();
   if(Math.max(panel.width,rows*(cell+18))>c.sheetSize)throw Error('动作分图尺寸预算不足，请增大拼图尺寸或分图数');panels.push({...panel,bytes,height:rows*(cell+18),times:partTimes});
  }
  if(panels.reduce((sum,p)=>sum+p.bytes.length,0)>c.maxFileMB*1048576)throw Error('动作分图超过设置的媒体大小预算');
  return {...panels[0],times,duration,panels:panels.map(({bytes,width,height,times})=>({bytes,width,height,times})),sampling:{...sampling,selected:tiles.length,columns:panels[0].sampling.columns,rows:panels[0].sampling.rows,imageCount:panels.length}};
 }

 stage='生成拼图';const cols=Math.ceil(Math.sqrt(tiles.length)),rows=Math.ceil(tiles.length/cols),sizes=await Promise.all(tiles.map(t=>sharp(t).metadata())),natural=Math.max(...sizes.map(s=>Math.max(s.width,s.height))),cell=Math.max(1,Math.min(natural,Math.floor(c.sheetSize/Math.max(cols,rows))));
 const overlays=await Promise.all(tiles.map(async(tile,i)=>({input:await sharp(tile).flatten({background:'#000'}).resize(cell,cell,{fit:'contain',background:'#000',withoutEnlargement:true}).jpeg({quality:65}).toBuffer(),left:(i%cols)*cell,top:Math.floor(i/cols)*cell})));
 const bytes=await sharp({create:{width:cols*cell,height:rows*cell,channels:3,background:'#000'}}).composite(overlays).jpeg({quality:65}).toBuffer();
 if(bytes.length>c.maxFileMB*1048576)throw Error('拼图超过设置的媒体大小预算，请提高大小预算或降低拼图尺寸');
 return {bytes,duration,times,width:cols*cell,height:rows*cell,sampling:{...sampling,selected:tiles.length,columns:cols,rows}};
}
async function imageSheet(bytes,c,meta){
 stage='读取动画画面';const pages=meta.pages||1,width=meta.width,height=meta.pageHeight||meta.height;dimensions(width,height);
 const delays=Array.from({length:pages},(_,i)=>Math.max(10,meta.delay?.[i]||100)),duration=pages>1?delays.reduce((a,b)=>a+b,0)/1000:0;durationLimit(duration,c);
 const action=pages>1&&c.animationUnderstanding,max=pages>1?c.animationFrames:c.frames,count=Math.min(pages,max*(action?6:3)),indices=Array.from({length:count},(_,i)=>count===1?Math.floor((pages-1)/2):Math.round(i*(pages-1)/(count-1)));
 const options=i=>({page:i,pages:1,limitInputPixels:4096*4096});
 const thumb=action?48:16,small=[];for(const i of indices)small.push(await sharp(bytes,options(i)).flatten({background:'#000'}).resize(thumb,thumb,{fit:'fill'}).removeAlpha().raw().toBuffer());
 const candidateTimes=indices.map(i=>delays.slice(0,i).reduce((a,b)=>a+b,0)/1000);const selected=action?pickActionFrames(Buffer.concat(small),max,candidateTimes,thumb*thumb*3):pickFrames(Buffer.concat(small),max,c.frameSelection),tiles=[],times=[];
 for(const pick of selected){const i=indices[pick];tiles.push(await sharp(bytes,options(i)).png().toBuffer());times.push(delays.slice(0,i).reduce((a,b)=>a+b,0)/1000);}
 if(!tiles.length)throw Error('动画没有可读取的画面');return compose(tiles,c,duration,times,{kind:pages>1?'animation':'static',mode:action?'action':c.frameSelection||'different',limit:max,sourceFrames:pages,candidates:indices.length,sourceWidth:width,sourceHeight:height,reason:action?'按时间顺序保留前后与局部动作，编号分图仍属于一次模型调用。':pages<max?'原文件帧数少于上限。':c.frameSelection==='uniform'?'均匀保留抽样候选，不按相似度删除。':selected.length<Math.min(max,indices.length)?'相近画面已去重，上限不是必须凑够的数量。':'已按上限选择差异画面。'});
}
async function videoSheet(bytes,c,range,apng){
 const ff=await core();ff.FS.writeFile('input',bytes);
 const run=(args,output,probe=false)=>{logs=[];ff.reset();if(ff.FS.analyzePath(output).exists)ff.FS.unlink(output);const code=probe?ff.ffprobe(...args):ff.exec(...args);if(!probe&&code!==0)throw Error('内置解码器未能读取这个媒体文件');
  // The pinned core's ffprobe wrapper leaves ret=-1 on ordinary C returns.
  // A fresh, validated JSON output is required; stale output is removed above.
  try{return Buffer.from(ff.FS.readFile(output));}catch{throw Error(probe?'内置解码器没有取得有效媒体信息':'内置解码器没有取得画面');}};
 stage='检测视频流';let probe;try{probe=JSON.parse(run(['-v','error','-protocol_whitelist','file,pipe','-format_whitelist',FORMATS,'-show_streams','-show_format','-of','json','-o','probe.json','input'],'probe.json',true).toString());}catch(e){throw Error('没有取得有效的视频流信息：'+e.message);}
 const video=probe.streams?.find(s=>s.codec_type==='video');dimensions(Number(video?.width),Number(video?.height));
 const fullDuration=apng??Number(video.duration??probe.format?.duration??0),duration=range?Math.min(range.duration,fullDuration-range.start):fullDuration;
 if(range&&(!Number.isFinite(range.start)||range.start<0||!Number.isFinite(range.duration)||range.duration<=0||range.start>=fullDuration))throw Error('视频分段范围无效或超出实际时长');durationLimit(duration,c);
 if(!duration&&Number(video.nb_frames)>1)throw Error('无法确认动画时长，本次不假装已读取完整动图');
 const action=apng!==undefined&&c.animationUnderstanding,edge=action?48:16,frames=apng!==undefined?c.animationFrames:c.frames,candidates=duration>0?frames*(action?6:3):1;
 const base=['-hide_banner','-loglevel','error','-threads','1','-filter_threads','1','-protocol_whitelist','file,pipe','-format_whitelist',FORMATS,...(range?['-ss',String(range.start)]:[]),'-i','input',...(range?['-t',String(duration)]:[])];
 const fps=duration>0?`fps=${candidates/duration}:start_time=0,`:'';
 stage='筛选候选画面';const raw=run([...base,'-an','-sn','-dn','-vf',fps+`scale=${edge}:${edge},format=rgb24`,'-frames:v',String(candidates),'-pix_fmt','rgb24','-f','rawvideo','-y','candidate.rgb'],'candidate.rgb');
 const indices=action?pickActionFrames(raw,frames,[],edge*edge*3):pickFrames(raw,frames,c.frameSelection);if(!indices.length)throw Error('媒体没有可读取的画面');
 const times=indices.map(i=>duration>0?i*duration/candidates:0),selection=indices.map(i=>`eq(n,${i})`).join('+');const columns=Math.ceil(Math.sqrt(indices.length)),rows=Math.ceil(indices.length/columns),cell=Math.max(1,Math.floor(c.sheetSize/Math.max(columns,rows)));
 stage='提取画面';run([...base,'-an','-sn','-dn','-vf',fps+`select='${selection}',scale='min(${cell},iw)':'min(${cell},ih)':force_original_aspect_ratio=decrease`,'-vsync','vfr','-frames:v',String(indices.length),'-q:v','5','-start_number','0','-y','frame-%d.jpg'],'frame-0.jpg');
 const tiles=indices.map((_,i)=>{try{return Buffer.from(ff.FS.readFile(`frame-${i}.jpg`));}catch{throw Error('选定画面未完整提取');}});return compose(tiles,c,duration,times,{kind:apng!==undefined?'animation':'video',mode:action?'action':c.frameSelection||'different',limit:frames,...(Number.isSafeInteger(Number(video.nb_frames))&&Number(video.nb_frames)>0?{sourceFrames:Number(video.nb_frames)}:{}),candidates:Math.floor(raw.length/(edge*edge*3)),sourceWidth:Number(video.width),sourceHeight:Number(video.height),reason:action?'按时间顺序保留前后与局部动作，并编号分图。':c.frameSelection==='uniform'?'均匀保留抽样时刻，不按相似度删除。':indices.length<frames?'相近画面已去重，或候选少于上限。':'已按上限选择差异画面。'});
}
try{
 let result;
 if(workerData.op==='check'){const ff=await core();ff.reset();if(ff.exec('-version')!==0)throw Error('内置视频引擎不能启动');await sharp({create:{width:1,height:1,channels:3,background:'#000'}}).png().toBuffer();result={ready:true,message:'内置动图与视频引擎可用，无需本机 FFmpeg / FFprobe'};}
 else {const bytes=Buffer.from(workerData.bytes),c=workerData.config,apng=apngDuration(bytes);let meta;try{meta=await sharp(bytes,{limitInputPixels:4096*4096}).metadata();}catch{}
  result=meta&&['gif','webp','png','jpeg'].includes(meta.format)&&apng===undefined?await imageSheet(bytes,c,meta):await videoSheet(bytes,c,workerData.range,apng);}
 parentPort.postMessage({ok:true,result});
}catch(error){const detail=logs.join('\n').slice(-1400);parentPort.postMessage({ok:false,message:stage+'失败：'+(error instanceof Error?error.message:'解码失败'),diagnostic:detail||'内置解码阶段：'+stage});}
