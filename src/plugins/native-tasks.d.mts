export function nativeTaskBinding(home:string, environment?:NodeJS.ProcessEnv):Promise<{cwd:string;env:NodeJS.ProcessEnv}>;
export function nativeTasks(home:string,args:string[],options?:{signal?:AbortSignal}):Promise<{code:number;stdout:string;stderr:string}>;
