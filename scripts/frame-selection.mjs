/** Select different frames while retaining a changing beginning and ending. */
export function pickFrames(pixels,max){
 const size=16*16*3,count=Math.floor(pixels.length/size);if(!count)return [];
 const selected=[max===1?Math.floor(count/2):0];
 const distance=(a,b)=>{let sum=0;for(let p=0;p<size;p++)sum+=Math.abs(pixels[a*size+p]-pixels[b*size+p]);return sum/size;};
 if(max>1&&count>1&&distance(0,count-1)>=2)selected.push(count-1);
 while(selected.length<Math.min(max,count)){let best=-1,score=0;for(let i=0;i<count;i++){if(selected.includes(i))continue;const d=Math.min(...selected.map(j=>distance(i,j)));if(d>score){best=i;score=d;}}if(best<0||score<2)break;selected.push(best);}return selected.sort((a,b)=>a-b);
}
