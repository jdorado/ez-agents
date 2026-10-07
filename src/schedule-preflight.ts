import { createHash, randomUUID } from 'node:crypto'
import { callLocalSocket } from './delivery-socket-client.mjs'

export type Preflight = {on: 'eligible' | 'changed'; checks: {alias: string; args: string[]}[]}
export type PreflightReceipt = {eligible: boolean; fingerprint: string; observedAt: string; count: number}
export function validPreflight(v: unknown): v is Preflight {
 const p=v as Preflight
 return Boolean(p && !Array.isArray(p) && Object.keys(p).every(k=>['on','checks'].includes(k)) && ['eligible','changed'].includes(p.on) &&
 Array.isArray(p.checks) && p.checks.length>0 && p.checks.length<=8 && p.checks.every(c=>c && Object.keys(c).every(k=>['alias','args'].includes(k)) &&
 /^[a-z][a-z0-9-]{0,39}$/.test(c.alias) && Array.isArray(c.args) && c.args.length<=100 && c.args.every(a=>typeof a==='string' && !/[\0\r\n]/.test(a) && Buffer.byteLength(a)<=8192)))
}
export function combinePreflight(results: unknown[]): PreflightReceipt {
 const values=results as (PreflightReceipt & {schemaVersion:number})[]
 if(!values.length || values.some(v=>!v || v.schemaVersion!==1 || typeof v.eligible!=='boolean' || !/^[a-f0-9]{64}$/.test(v.fingerprint) ||
 !Number.isSafeInteger(v.count) || v.count<0 || typeof v.observedAt!=='string' || !Number.isFinite(Date.parse(v.observedAt)) || Date.parse(v.observedAt)>Date.now()+1000 || Date.now()-Date.parse(v.observedAt)>300000)) throw Error('Invalid or stale plugin preflight result')
 return {eligible:values.some(v=>v.eligible),fingerprint:createHash('sha256').update(JSON.stringify(values.map(v=>v.fingerprint))).digest('hex'),
 observedAt:new Date().toISOString(),count:values.reduce((n,v)=>n+v.count,0)}
}
export async function installedPreflight(scheduleId:string, revision:string): Promise<PreflightReceipt> {
 const socket=process.env.EZ_PLUGIN_BROKER_SOCKET
 if(!socket) throw Error('Scheduled preflight requires the bound plugin broker')
 return await callLocalSocket(socket,{version:1,id:randomUUID(),operation:'preflight',scheduleId,revision},120000) as PreflightReceipt
}
