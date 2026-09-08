import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomic } from '../plugins/manager.mjs';
import { read } from './control.mjs';

export async function bindUpdates(home,hostConfig,packageRoot=fileURLToPath(new URL('../../',import.meta.url))) {
  home=await fs.realpath(home);hostConfig=await fs.realpath(hostConfig);
  const config=await read(path.join(home,'config.json')),host=await read(hostConfig),deploymentDir=path.dirname(hostConfig);
  if(path.basename(hostConfig)!=='host-executor.json'||host.agents.length!==1||host.agents[0].toolsHome!==home||host.agents[0].workspace!==config.workspace)throw Error('Updates require this agent registry and its own single-deployment host config');
  if(await fs.realpath(path.join(deploymentDir,'mind'))!==config.workspace||await fs.realpath(path.join(deploymentDir,'control'))!==host.agents[0].controlDir)throw Error('Noncanonical deployment state paths');
  packageRoot=await fs.realpath(packageRoot);
  await fs.mkdir(path.join(home,'updates'),{recursive:true,mode:0o700});
  await atomic(path.join(home,'config.json'),{...config,packageRoot:packageRoot.replace(/\/$/,''),deploymentDir});
  const pkg=await read(path.join(packageRoot,'package.json')),bin=path.join(home,'bin');
  // Every invocation resolves the active root. Already-running workers retain
  // their old code; the next worker receives the new package after activation.
  const configFile=JSON.stringify(path.join(home,'config.json'));
  await fs.writeFile(path.join(bin,'ez'),`#!${process.execPath}\nimport fs from 'node:fs';import {pathToFileURL} from 'node:url';const c=JSON.parse(fs.readFileSync(${configFile}));const m=await import(pathToFileURL(c.packageRoot+'/src/plugins/manager.mjs'));m.main(['--home',${JSON.stringify(home)},...process.argv.slice(2)]).catch(e=>{console.error(e.message);process.exitCode=1});\n`,{mode:0o700});
  for(const [name,entry] of Object.entries(pkg.bin)) {
    const dest=path.join(bin,name);await fs.rm(dest,{force:true});
    await fs.writeFile(dest,`#!${process.execPath}\nimport fs from 'node:fs';import {spawn} from 'node:child_process';const c=JSON.parse(fs.readFileSync(${configFile}));const child=spawn(c.packageRoot+'/'+${JSON.stringify(entry)},process.argv.slice(2),{stdio:'inherit',env:{...process.env,EZ_DEPLOYMENT_DIR:c.deploymentDir}});for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>child.kill(s));child.on('error',e=>{console.error(e.message);process.exitCode=1});child.on('close',c=>process.exitCode=c??1);\n`,{mode:0o700});
  }
  const file=path.join(config.workspace,'TOOLS.md'),prior=await fs.readFile(file,'utf8');
  if(!prior.includes('## Software updates'))await fs.appendFile(file,'\n'+await fs.readFile(new URL('../../templates/updates.md',import.meta.url),'utf8'),{mode:0o600});
  return {ok:true,home,deploymentDir,packageRoot,policy:'Automatic compatible stable releases. Beta/local candidates require opt-in or an explicit owner request.'};
}
