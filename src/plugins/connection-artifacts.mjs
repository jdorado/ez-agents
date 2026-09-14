import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

// Preserve CLI stdout as bytes without putting attachments into model context.
export async function commandArtifact(workspace,name,execute,{signal}={}) {
  if(typeof name!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(name))throw Error('Expected a simple output filename');
  const root=await fs.realpath(workspace),directory=path.join(root,'artifacts');
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  if(await fs.realpath(directory)!==directory)throw Error('Artifact directory must not be a symlink');
  const controller=new AbortController(),cancel=()=>controller.abort();
  signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)controller.abort();
  let bytes=0,overflow=false;const chunks=[];
  try {
    controller.signal.throwIfAborted();
    const result=await execute({signal:controller.signal,onStdout:chunk=>{
      bytes+=chunk.length;
      if(bytes>20*1024*1024){overflow=true;controller.abort();return;}
      if(!overflow)chunks.push(Buffer.from(chunk));
    }});
    if(overflow)throw Error('Artifact exceeds 20 MiB limit');
    controller.signal.throwIfAborted();
    if(result.code!==0)return result;
    const content=Buffer.concat(chunks),relative=path.join('artifacts',`${randomUUID()}_${name}`);
    // Check the parent again after the command, before writing its result.
    if(await fs.realpath(directory)!==directory)throw Error('Artifact directory changed');
    await fs.writeFile(path.join(root,relative),content,{mode:0o600,flag:'wx'});
    return {...result,stdout:'',artifact:{path:relative,bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')}};
  } finally {signal?.removeEventListener('abort',cancel);}
}
