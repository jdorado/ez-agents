// The service points at this retained bootstrap; each restart loads active code.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
const deployment=process.argv[2];
if(!deployment||!path.isAbsolute(deployment))throw Error('Absolute deployment path required');
const host=JSON.parse(await readFile(path.join(deployment,'host-executor.json'),'utf8'));
if(host.agents.length!==1||!host.agents[0].toolsHome)throw Error('Initialize the deployment plugin registry first');
const config=JSON.parse(await readFile(path.join(host.agents[0].toolsHome,'config.json'),'utf8'));
if(config.deploymentDir!==deployment||!path.isAbsolute(config.packageRoot))throw Error('Invalid update binding');
const abort=new AbortController();for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>abort.abort());
const {supervise}=await import(pathToFileURL(path.join(config.packageRoot,'src/updates/supervisor.mjs')));
await supervise(deployment,abort.signal);
