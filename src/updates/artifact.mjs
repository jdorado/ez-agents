import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const digest = data => createHash('sha256').update(data).digest('hex');
export function version(value) {
  const m=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/.exec(value);
  if(!m) throw Error('Expected an exact SemVer version (no ranges or build metadata)');
  return {numbers:m.slice(1,4).map(Number),pre:m[4]};
}
export function newer(a,b) {
  const x=version(a),y=version(b);
  for(let i=0;i<3;i++)if(x.numbers[i]!==y.numbers[i])return x.numbers[i]>y.numbers[i];
  if(!x.pre||!y.pre)return Boolean(y.pre&&!x.pre);
  const p=x.pre.split('.'),q=y.pre.split('.');
  for(let i=0;i<Math.max(p.length,q.length);i++) {
    if(p[i]===q[i])continue;if(p[i]===undefined)return false;if(q[i]===undefined)return true;
    const pn=/^\d+$/.test(p[i]),qn=/^\d+$/.test(q[i]);
    return pn&&qn?Number(p[i])>Number(q[i]):pn!==qn?!pn:p[i]>q[i];
  }
  return false;
}
export function compatible(a,b) {
  const x=version(a).numbers,y=version(b).numbers;
  return x[0]===y[0]&&(x[0]!==0||x[1]===y[1]);
}
export function releaseContract(pkg, kind) {
  const r=pkg.ezRelease;
  if(!r||r.protocol!==1||r.kind!==kind||!Number.isInteger(r.stateSchema)||r.stateSchema<1||r.mainProtocol!==1)throw Error('Missing or incompatible ezRelease contract');
  version(pkg.version);
  return r;
}
// npm emits ustar regular files. Reject links, devices, extensions and traversal
// before writing anything; never hand an untrusted archive to tar extraction.
export async function extract(buffer,destination) {
  if(buffer.length>25*1024*1024)throw Error('Compressed package too large');
  const data=gunzipSync(buffer,{maxOutputLength:100*1024*1024});
  const files=[],seen=new Set();let ended=false;
  for(let offset=0;offset+512<=data.length;) {
    const h=data.subarray(offset,offset+512);offset+=512;
    if(h.every(b=>b===0)){ended=true;break;}
    const str=(a,b)=>h.subarray(a,b).toString('utf8').replace(/\0.*$/s,'');
    const oct=(a,b)=>{const s=str(a,b).trim();if(!/^[0-7]+$/.test(s))throw Error('Invalid tar number');return parseInt(s,8);};
    let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:h[i];
    if(sum!==oct(148,156))throw Error('Invalid tar checksum');
    const prefix=str(345,500),name=(prefix?prefix+'/':'')+str(0,100),type=str(156,157),size=oct(124,136);
    if(!['','0','5'].includes(type))throw Error('Only regular package files and directories are supported');
    if(!name.startsWith('package/')||/[\x00-\x1f\\]/.test(name))throw Error('Unsafe archive path');
    const relative=name.slice(8).replace(/\/$/,'');
    if(!relative&&type==='5')continue;
    if(!relative||relative.split('/').some(x=>!x||x==='.'||x==='..'||x==='node_modules'||x==='.git')||seen.has(relative))throw Error('Unsafe or duplicate archive path');
    seen.add(relative);
    if(size>20*1024*1024||offset+size>data.length||(type==='5'&&size))throw Error('Invalid archive size');
    files.push({relative,type,data:data.subarray(offset,offset+size),mode:oct(100,108)&0o111?0o755:0o644});
    offset+=Math.ceil(size/512)*512;
  }
  if(!ended||!files.some(f=>f.relative==='package.json'))throw Error('Incomplete npm archive');
  await fs.mkdir(destination,{recursive:true,mode:0o700});
  for(const f of files) {
    const dest=path.join(destination,f.relative);
    if(f.type==='5'){await fs.mkdir(dest,{recursive:true,mode:0o755});continue;}
    await fs.mkdir(path.dirname(dest),{recursive:true,mode:0o755});await fs.writeFile(dest,f.data,{flag:'wx',mode:f.mode});
  }
}
export async function registryVersion(name,tag='latest') {
  if(!/^@[a-z0-9_-]+\/[a-z0-9][a-z0-9._-]*$/.test(name))throw Error('A scoped npm package identity is required');
  if(!['latest','beta'].includes(tag))version(tag);
  const response=await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,{signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error(`npm metadata unavailable (${response.status})`);
  const pkg=await response.json();if(pkg.name!==name)throw Error('Registry identity mismatch');version(pkg.version);if(!['latest','beta'].includes(tag)&&pkg.version!==tag)throw Error('Registry version mismatch');return pkg;
}
export async function download(pkg) {
  const url=new URL(pkg.dist?.tarball);
  if(url.protocol!=='https:'||url.hostname!=='registry.npmjs.org'||url.username||url.password)throw Error('Untrusted package host');
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw Error(`Package download failed (${response.status})`);
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>25*1024*1024)throw Error('Package too large');chunks.push(chunk);}
  const data=Buffer.concat(chunks);
  if(pkg.dist.integrity!==`sha512-${createHash('sha512').update(data).digest('base64')}`)throw Error('Registry integrity mismatch');
  return data;
}
