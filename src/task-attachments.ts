import {mkdir,lstat,open,rm,readdir} from 'node:fs/promises'
import {constants} from 'node:fs'
import {join,basename} from 'node:path'
import {createHash} from 'node:crypto'

export const attachmentLimit = 20 * 1024 * 1024
export type TaskAttachment = {runId:string;id:string;filename:string;bytes:number;sha256:string}
const hash = (data:Buffer) => createHash('sha256').update(data).digest('hex')
function directory(control:string,runId:string) {
  if(!/^[a-zA-Z0-9_-]{1,160}$/.test(runId))throw Error('Invalid attachment run')
  return join(control,'task-files',runId)
}
function validate(file:TaskAttachment) {
  if(!file || !/^[a-f0-9-]{36}$/.test(file.id) || typeof file.filename!=='string' || !file.filename || file.filename!==basename(file.filename) || /[\\\x00-\x1f\x7f]/.test(file.filename) || file.filename.length>200 ||
    !Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>attachmentLimit||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Invalid task attachment')
}
async function safeDirectory(control:string,runId:string,create=false) {
  const dir=directory(control,runId)
  for(const entry of [join(control,'task-files'),dir]) {
    if(create)await mkdir(entry,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e})
    const stat=await lstat(entry);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe attachment directory')
  }
  return dir
}
export async function stageTaskAttachment(control:string,runId:string,id:string,input:string,data:Buffer):Promise<TaskAttachment> {
  const file={runId,id,filename:basename(input),bytes:data.length,sha256:hash(data)};validate(file)
  const dir=await safeDirectory(control,runId,true)
  // The task broker serializes its calls; bound the entire run, including unsent files.
  let total=0
  for(const entry of await readdir(dir)) {
    const stat=await lstat(join(dir,entry))
    if(!stat.isFile()||stat.isSymbolicLink())throw Error('Unsafe staged attachment')
    if(entry!==id)total+=stat.size
  }
  if(total+data.length>attachmentLimit)throw Error('Task attachments exceed the 20 MiB run limit')
  const fd=await open(join(dir,id),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600).catch(async error=>{
    if(error.code!=='EEXIST')throw error
    await readTaskAttachment(control,file);return null
  })
  if(!fd)return file
  try{await fd.writeFile(data)}finally{await fd.close()}
  return file
}
export async function readTaskAttachment(control:string,file:TaskAttachment) {
  validate(file)
  const dir=await safeDirectory(control,file.runId)
  const fd=await open(join(dir,file.id),constants.O_RDONLY|constants.O_NOFOLLOW)
  try {
    const stat=await fd.stat();if(!stat.isFile()||stat.size!==file.bytes)throw Error('Attachment changed')
    const data=await fd.readFile();if(hash(data)!==file.sha256)throw Error('Attachment changed')
    return data
  }finally{await fd.close()}
}
export async function removeTaskAttachments(control:string,runId:string) {
  await rm(directory(control,runId),{recursive:true,force:true})
}
