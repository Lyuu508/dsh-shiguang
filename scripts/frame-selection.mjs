/** Select different frames while retaining a changing beginning and ending. */
export function pickFrames(pixels,max,mode='different'){
 const size=16*16*3,count=Math.floor(pixels.length/size);if(!count)return [];
 if(mode==='uniform'){const n=Math.min(max,count);return Array.from({length:n},(_,i)=>n===1?Math.floor(count/2):Math.round(i*(count-1)/(n-1)));}
 const selected=[max===1?Math.floor(count/2):0];
 const distance=(a,b)=>{let sum=0;for(let p=0;p<size;p++)sum+=Math.abs(pixels[a*size+p]-pixels[b*size+p]);return sum/size;};
 if(max>1&&count>1&&distance(0,count-1)>=2)selected.push(count-1);
 while(selected.length<Math.min(max,count)){let best=-1,score=0;for(let i=0;i<count;i++){if(selected.includes(i))continue;const d=Math.min(...selected.map(j=>distance(i,j)));if(d>score){best=i;score=d;}}if(best<0||score<2)break;selected.push(best);}return selected.sort((a,b)=>a-b);
}

/** Ordered temporal anchors plus local-motion moments, including small foreground actions. */
export function pickActionFrames(pixels,max,times=[],size=16*16*3){
 const count=Math.floor(pixels.length/size),n=Math.min(max,count);if(!n)return [];if(n===1)return [Math.floor((count-1)/2)];
 const selected=new Set([0,count-1]),anchors=Math.min(n,Math.max(2,Math.ceil(n/2))),end=times.at(-1)||count-1;
 for(let k=1;k<anchors-1;k++){const target=k*end/(anchors-1);let best=0;for(let i=1;i<count;i++)if(Math.abs((times[i]??i)-target)<Math.abs((times[best]??best)-target))best=i;selected.add(best);}
 const distance=(a,b)=>{let changed=0,sum=0;for(let p=0;p<size;p+=3){const d=(Math.abs(pixels[a*size+p]-pixels[b*size+p])+Math.abs(pixels[a*size+p+1]-pixels[b*size+p+1])+Math.abs(pixels[a*size+p+2]-pixels[b*size+p+2]))/3;if(d>3){changed++;sum+=d;}}return changed?sum/Math.sqrt(changed):0;};
 while(selected.size<n){let best=-1,score=-1;for(let i=0;i<count;i++){if(selected.has(i))continue;const novelty=Math.min(...[...selected].map(j=>distance(i,j))),motion=(i?distance(i,i-1):0)+(i+1<count?distance(i,i+1):0),spacing=Math.min(...[...selected].map(j=>Math.abs(i-j)));const value=novelty+motion*.4+spacing/count;if(value>score){best=i;score=value;}}if(best<0)break;selected.add(best);}return [...selected].sort((a,b)=>a-b);
}
