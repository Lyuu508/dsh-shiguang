// Background tool installation may change paths while the user edits another field.
// Merge only independent edits; keep conflicts explicit instead of discarding a draft.
export function mergeSettings<T>(base:T,draft:T,incoming:T):{value:T;conflicts:string[]} {
 const conflicts:string[]=[];
 const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
 const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
 function merge(a:unknown,b:unknown,c:unknown,path:string):unknown {
  if(equal(a,b))return c;
  if(equal(a,c)||equal(b,c))return b;
  if(object(a)&&object(b)&&object(c))return Object.fromEntries([...new Set([...Object.keys(a),...Object.keys(b),...Object.keys(c)])].map(k=>[k,merge(a[k],b[k],c[k],path?path+'.'+k:k)]));
  conflicts.push(path);return b;
 }
 return {value:merge(base,draft,incoming,'') as T,conflicts};
}
