import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const validOwner=owner=>owner&&typeof owner==='object'&&Number.isSafeInteger(owner.telegramUserId)&&owner.telegramUserId>0&&Number.isSafeInteger(owner.telegramChatId)&&(owner.kind==='group'?owner.telegramChatId<0:owner.kind===undefined&&owner.telegramChatId>0)&&typeof owner.pairedAt==='string'&&Number.isFinite(Date.parse(owner.pairedAt))&&(owner.id===undefined||typeof owner.id==='string'&&/^[a-zA-Z0-9_:.-]{1,200}$/.test(owner.id))&&(owner.generation===undefined||typeof owner.generation==='string'&&/^[a-f0-9-]{36}$/.test(owner.generation))&&(owner.telegramLinkedAt===undefined||typeof owner.telegramLinkedAt==='string');
const ownerId=owner=>owner.id??`telegram:${owner.telegramUserId}:${owner.telegramChatId}`;
const ownerEpoch=owner=>owner.generation??owner.pairedAt;
const telegramEpoch=owner=>owner.telegramLinkedAt??owner.pairedAt;
const sameDeliveryOwner=(left,right)=>validOwner(left)&&validOwner(right)&&ownerId(left)===ownerId(right)&&ownerEpoch(left)===ownerEpoch(right)&&left.kind===right.kind&&left.telegramUserId===right.telegramUserId&&left.telegramChatId===right.telegramChatId&&telegramEpoch(left)===telegramEpoch(right);
export function authorizeDeliveryContext(context,owner) {
  if(!context||context.version!==1||typeof context.connectionId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(context.connectionId)||typeof context.plugin!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(context.plugin)||typeof context.revision!=='string'||!context.revision||!sameDeliveryOwner(context.owner,owner))throw Error('Owner delivery context is invalid or revoked');
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
