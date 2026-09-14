import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const validOwner=owner=>owner&&Number.isSafeInteger(owner.telegramUserId)&&owner.telegramUserId>0&&Number.isSafeInteger(owner.telegramChatId)&&(owner.kind==='group'?owner.telegramChatId<0:owner.kind===undefined&&owner.telegramChatId>0)&&typeof owner.pairedAt==='string'&&Number.isFinite(Date.parse(owner.pairedAt));
export function authorizeDeliveryContext(context,owner) {
  if(!context||context.version!==1||typeof context.connectionId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(context.connectionId)||typeof context.plugin!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(context.plugin)||typeof context.revision!=='string'||!context.revision||!validOwner(context.owner)||!validOwner(owner)||['kind','telegramUserId','telegramChatId','pairedAt'].some(k=>context.owner[k]!==owner[k]))throw Error('Owner delivery context is invalid or revoked');
  return context;
}
export async function currentDeliveryOwner(controlDir) {
  const state=JSON.parse(await readFile(path.join(controlDir,'control-state.json'),'utf8'));
  if(state.version!==1)throw Error('Invalid owner control state');
  return state.owner;
}
export async function captureDeliveryContext(controlDir,plugin,revision) {
  const owner=await currentDeliveryOwner(controlDir).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!owner)return undefined;
  return authorizeDeliveryContext({version:1,connectionId:randomUUID(),plugin,revision,owner},owner);
}
