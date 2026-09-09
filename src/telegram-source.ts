import { createServer, type Server } from 'node:http'
import { mkdir, readFile, readdir, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { atomicTaskFile } from './tasks.js'
import { EventSources, type SourceEvent } from './event-sources.js'
import type { Owner } from './control-state.js'
import type { Message, User } from 'grammy/types'

// Provider transport only. The existing Tasks grant remains the execution and
// disclosure authority, exactly as for a registered WhatsApp source.
export class TelegramSource {
  readonly socketPath: string
  private server?: Server
  private pending?: Promise<void>
  private serial: Promise<unknown> = Promise.resolve()
  constructor(private controlDir: string, private accountId: string, private send: (chatId: number, text: string) => Promise<number[]>) {
    this.socketPath = join(tmpdir(), `ez-tg-${createHash('sha256').update(`${controlDir}:${accountId}`).digest('hex').slice(0,16)}.sock`)
  }
  private get directory() { return join(this.controlDir, 'telegram-source', createHash('sha256').update(this.accountId).digest('hex')) }
  private async read(name: string, fallback: any): Promise<any> {
    try { return JSON.parse(await readFile(join(this.directory,name),'utf8')) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw e }
  }
  async start(owner: Owner) {
    if (!this.pending) this.pending = (async () => {
      await mkdir(this.directory,{recursive:true,mode:0o700})
      await rm(this.socketPath,{force:true})
      this.server = createServer(async (req,res) => {
        try {
          let body = ''; for await(const chunk of req) { body += chunk; if (body.length>20000) throw new Error('Request too large') }
          const {command,args={}}=JSON.parse(body)
          const work=this.serial.then(()=>this.call(command,args)); this.serial=work.catch(()=>{})
          const data=await work; res.end(JSON.stringify({ok:true,data}))
        } catch { res.statusCode=400; res.end(JSON.stringify({ok:false})) }
      })
      await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(this.socketPath,resolve)})
      this.server.unref()
      await chmod(this.socketPath,0o600)
    })().catch(e=>{this.pending=undefined;throw e})
    await this.pending
    await new EventSources(this.controlDir).register('telegram',this.socketPath,owner)
  }
  async stop() { if(this.server) await new Promise<void>(resolve=>this.server!.close(()=>resolve())); await rm(this.socketPath,{force:true}) }
  capture(updateId: number, message: Message.TextMessage, sender: User): Promise<boolean> {
    const work=this.serial.then(()=>this.captureMessage(updateId,message,sender));this.serial=work.catch(()=>{});return work
  }
  private async captureMessage(updateId: number, message: Message.TextMessage, sender: User): Promise<boolean> {
    const watches=await this.read('watches.json',{})
    if (!(watches[String(message.chat.id)]>Date.now())) return false
    const event: SourceEvent={id:`tg_${String(message.chat.id).replace('-','n')}_${message.message_id}`,conversationId:String(message.chat.id),receivedAt:message.date*1000,
      text:JSON.stringify({updateId,senderId:sender.id,senderName:sender.first_name,messageId:message.message_id,text:message.text})}
    if (!await this.read(`${event.id}.json`,null)) {
      const cursor=(await this.read('cursor.json',0))+1
      if(!Number.isSafeInteger(cursor)||cursor<1)throw new Error('Invalid event cursor')
      await atomicTaskFile(join(this.directory,'cursor.json'),cursor)
      await atomicTaskFile(join(this.directory,`${event.id}.json`),{...event,cursor})
    }
    return true
  }
  async call(command: string,args: Record<string,any>) {
    if(command==='events-head') return {cursor:0,accountId:this.accountId,taskProtocol:'message-v1',persistentWatch:true}
    if(command==='events' || command==='events-check') {
      const files=(await readdir(this.directory)).filter(f=>/^tg_n\d+_\d+\.json$/.test(f))
      const events=(await Promise.all(files.map(f=>this.read(f,null)))).sort((a,b)=>a.cursor-b.cursor)
      if(command==='events-check') {
        if(!Array.isArray(args.ids)||args.ids.length>10)throw new Error('Invalid IDs')
        return {events:events.filter(e=>args.ids.includes(e.id))}
      }
      if(!Number.isSafeInteger(args.after)||args.after<0)throw new Error('Invalid cursor')
      const batch=events.filter(e=>e.cursor>args.after).slice(0,10)
      return {events:batch,cursor:batch.at(-1)?.cursor??args.after}
    }
    if(args.accountId!==this.accountId || typeof args.conversationId!=='string' || !/^-\d+$/.test(args.conversationId) || !Number.isSafeInteger(Number(args.conversationId))) throw new Error('Invalid Telegram binding')
    if(command==='task-unwatch') {
      const watches=await this.read('watches.json',{});delete watches[args.conversationId]
      await atomicTaskFile(join(this.directory,'watches.json'),watches);return {watching:false}
    }
    if(command==='task-watch') {
      if(!Number.isFinite(args.expiresAt)||args.expiresAt<=Date.now())throw new Error('Invalid expiry')
      const watches=await this.read('watches.json',{});watches[args.conversationId]=args.expiresAt
      await atomicTaskFile(join(this.directory,'watches.json'),watches);return {watching:true}
    }
    if(command!=='task-send'||typeof args.text!=='string'||!args.text.trim()||args.text.length>4096||typeof args.key!=='string'||!/^[a-zA-Z0-9_-]{1,240}$/.test(args.key))throw new Error('Invalid send')
    const watches=await this.read('watches.json',{});if(!(watches[args.conversationId]>Date.now()))throw new Error('Watch expired')
    const file=`send_${args.key}.json`,prior=await this.read(file,null)
    if(prior) {if(prior.text!==args.text||prior.conversationId!==args.conversationId)throw new Error('Key reused');return prior}
    const receipt={accountId:this.accountId,conversationId:args.conversationId,key:args.key,text:args.text,state:'uncertain',receiptId:[] as number[]}
    await atomicTaskFile(join(this.directory,file),receipt)
    receipt.receiptId=await this.send(Number(args.conversationId),args.text);receipt.state='accepted'
    await atomicTaskFile(join(this.directory,file),receipt);return receipt
  }
}
