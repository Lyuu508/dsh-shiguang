export interface ScheduledTimer {clear():void;unref():void}
/** Keep long user budgets from wrapping through Node's signed 32-bit timer. */
export function scheduleTimeout(callback:()=>void,milliseconds:number):ScheduledTimer{
 if(!Number.isFinite(milliseconds)||milliseconds<0)throw new Error('等待时间应为非负数');
 let left=milliseconds,cancelled=false,unreferenced=false,timer:NodeJS.Timeout;
 const next=()=>{const interval=Math.min(left,2147483647);timer=setTimeout(()=>{if(cancelled)return;left-=interval;if(left>0)next();else callback();},interval);if(unreferenced)timer.unref();};next();
 return {clear(){cancelled=true;clearTimeout(timer);},unref(){unreferenced=true;timer.unref();}};
}
export function timeoutSignal(milliseconds:number):AbortSignal{
 if(milliseconds<=2147483647)return AbortSignal.timeout(Math.floor(milliseconds));
 const controller=new AbortController(),timer=scheduleTimeout(()=>controller.abort(new DOMException('等待时间已到','TimeoutError')),milliseconds);timer.unref();return controller.signal;
}
export function repeatEvery(callback:()=>void,milliseconds:number):ScheduledTimer{
 let stopped=false,unreferenced=false,timer:ScheduledTimer;const next=()=>{timer=scheduleTimeout(()=>{if(stopped)return;callback();if(!stopped)next();},milliseconds);if(unreferenced)timer.unref();};next();return {clear(){stopped=true;timer.clear();},unref(){unreferenced=true;timer.unref();}};
}
