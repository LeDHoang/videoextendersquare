(()=>{const R=window.__p3={done:false,out:[]};(async()=>{
const U="https://media.echomultiverse.com/pairs/12827489_fast.mp4";
const rd=async(u,h)=>{const r=await fetch(u,{cache:"no-store",headers:h||{}});const x=r.body.getReader();let n=0;for(;;){const {done,value}=await x.read();if(done)break;n+=value.length;}return n};
const time=async(label,f)=>{const t0=performance.now();const n=await f();const s=(performance.now()-t0)/1000;R.out.push({label,MB:+(n/1e6).toFixed(1),s:+s.toFixed(1),Mbps:+(n*8/1e6/s).toFixed(1)})};
const len=+(await fetch(U,{method:"HEAD",cache:"no-store"})).headers.get("content-length");
await time("single",()=>rd(U));
for(const k of [4,8]){const step=Math.ceil(len/k);await time("par"+k,async()=>(await Promise.all([...Array(k)].map((_,i)=>rd(U,{Range:`bytes=${i*step}-${Math.min(len,(i+1)*step)-1}`})))).reduce((a,b)=>a+b,0));}
await time("single2",()=>rd(U));
R.done=true})().catch(e=>{R.err=String(e);R.done=true})})();true
