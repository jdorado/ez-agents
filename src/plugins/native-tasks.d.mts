export function nativeTaskBinding(home:string, environment?:NodeJS.ProcessEnv):Promise<{cwd:string;env:NodeJS.ProcessEnv}>;
import type {DeliveryContext} from '../delivery-context.mjs';
export function nativeCommands():{command:string;description:string;limitations?:string[]}[];
export function nativeTasks(home:string,args:string[],options?:{signal?:AbortSignal;command?:string;deliveryContext?:DeliveryContext}):Promise<{code:number;stdout:string;stderr:string}>;
