// A minimal `codex app-server --stdio` executable for executor tests. `turn` is
// JavaScript run when a turn starts, with `prompt`, `params` (thread start or
// resume params), `args` (argv), `steered` (resolves with the first steered
// text), `fs`, `path` and `spawnSync` in scope; a throw fails the turn.
export const fakeCodex = ({ turn = '', threadId = 'fake-thread' }: { turn?: string; threadId?: string } = {}) => `#!${process.execPath}
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process'),args=process.argv.slice(2)
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n')
// Only the app-server is faked; other subcommands (catalog probes) answer nothing.
if(args[0]!=='app-server'){console.log('{}');process.exit(0)}
let thread=${JSON.stringify(threadId)},params
let onSteer;const steered=new Promise(resolve=>{onSteer=resolve})
require('readline').createInterface({input:process.stdin}).on('line',async line=>{
  const m=JSON.parse(line);if(m.id===undefined)return
  if(m.method==='thread/start'||m.method==='thread/resume'){params=m.params;if(m.params.threadId)thread=m.params.threadId;send({id:m.id,result:{thread:{id:thread},model:m.params.model}});return}
  if(m.method==='turn/start'){
    send({id:m.id,result:{turn:{id:'t1'}}});send({method:'turn/started',params:{threadId:thread,turn:{id:'t1'}}})
    const prompt=m.params.input.map(i=>i.text).join('')
    let error
    try{await (async()=>{${turn}})()}catch(e){error=String(e&&e.message||e)}
    send({method:'item/started',params:{threadId:thread,item:{type:'agentMessage',id:'i1'}}})
    send({method:'turn/completed',params:{threadId:thread,turn:{id:'t1',status:error?'failed':'completed',...(error?{error:{message:error}}:{})}}});return
  }
  if(m.method==='turn/steer'){send({id:m.id,result:{turnId:m.params.expectedTurnId}});onSteer(m.params.input.map(i=>i.text).join(''));return}
  if(m.method==='thread/goal/get'){send({id:m.id,result:{goal:null}});return}
  send({id:m.id,result:{}})
})
`

// Puts the fake first on PATH as the host `codex`; the returned function restores PATH.
export const installFakeCodex = async (directory: string, options: Parameters<typeof fakeCodex>[0] = {}): Promise<() => void> => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const path = await import('node:path')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'codex'), fakeCodex(options), { mode: 0o700 })
  const prior = process.env.PATH
  process.env.PATH = directory + path.delimiter + (prior ?? '')
  return () => { if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior }
}
