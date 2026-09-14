import type {Owner} from './control-state.js';
export type DeliveryContext={version:1;connectionId:string;plugin:string;revision:string;owner:Owner};
export function authorizeDeliveryContext(context:unknown,owner:unknown):DeliveryContext;
export function currentDeliveryOwner(controlDir:string):Promise<Owner|null>;
export function captureDeliveryContext(controlDir:string,plugin:string,revision:string):Promise<DeliveryContext|undefined>;
