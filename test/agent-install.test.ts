import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { createAgent, listAgents, installationCli } from '../src/agent-install.js'

test('new agents receive independent projects, secrets and plugin bindings; duplicate names never overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(),'ez-agents-'))
  const base = {cli:'grok',root,hostRoot:'/private/agents',composeFile:'/opt/ez/compose.yaml',purpose:'Household shopper',token:'123456789:'+'a'.repeat(30)}
  try {
    const one=await createAgent({...base,name:'family',image:'ezenciel-agents:install-candidate'})
    const two=await createAgent({...base,cli:undefined,name:'work',token:'987654321:'+'b'.repeat(30)})
    assert.notEqual(one.project,two.project)
    assert.equal(two.executor,'grok')
    await assert.rejects(createAgent({...base,name:'different-cli',cli:'codex'}),/already selected/)
    const host=JSON.parse(await readFile(join(root,'family/host-executor.json'),'utf8'))
    assert.equal(host.cli,'grok')
    assert.equal(host.isolation,'host-capable')
    assert.equal(host.agents[0].workspace,'/private/agents/family/mind')
    assert.equal(host.agents[0].toolsHome,undefined)
    const a=parseEnv(await readFile(join(root,'family/docker.env'),'utf8'))
    const b=parseEnv(await readFile(join(root,'work/docker.env'),'utf8'))
    assert.equal(a.EZ_ISOLATION,'host-capable')
    assert.equal(a.EZ_EXECUTOR_TRANSPORT,'host')
    assert.equal(b.EZ_ISOLATION,'host-capable')
    assert.equal(b.EZ_EXECUTOR_TRANSPORT,'host')
    assert.equal(JSON.parse(await readFile(join(root,'family/agent.json'),'utf8')).isolation,'host-capable')
    assert.equal(a.EZ_RELAY_IMAGE,'ezenciel-agents:install-candidate')
    assert.equal(b.EZ_RELAY_IMAGE,'ezenciel-agents:local')
    // Host-capable agents publish an authenticated loopback ledger endpoint so
    // host CLIs can reach the relay on Docker Desktop/OrbStack.
    assert.match(a.EZ_DELIVERY_TCP_PORT!,/^2\d{4}$/)
    assert.equal(a.COMPOSE_FILE,`/opt/ez/compose.yaml:/private/agents/family/ledger.compose.yaml`)
    const overlay=await readFile(join(root,'family/ledger.compose.yaml'),'utf8')
    assert.match(overlay,/EZ_DELIVERY_TCP_PORT: \$\{EZ_DELIVERY_TCP_PORT:\?\}/)
    assert.match(overlay,/127\.0\.0\.1:\$\{EZ_DELIVERY_TCP_PORT:\?\}:\$\{EZ_DELIVERY_TCP_PORT:\?\}/)
    // Creation seeds the agent's mind once; the relay never writes it at start.
    assert.match(await readFile(join(root,'family/mind/AGENTS.md'),'utf8'),/## Purpose\n\nHousehold shopper/)
    assert.equal((await stat(join(root,'family/mind/AGENTS.md'))).mode & 0o777,0o644)
    await assert.rejects(createAgent({...base,name:'bad-image',image:"bad'\nINJECT=yes"}),/Invalid relay image/)
    for(const key of ['COMPOSE_PROJECT_NAME','EZ_RELAY_ENV_FILE','EZ_AGENT_PURPOSE_FILE','EZ_AGENT_WORKSPACE','EZ_CONTROL_DIR','EZ_WHATSAPP_IPC_VOLUME','EZ_WHATSAPP_CLIENT_VOLUME'])assert.notEqual(a[key],b[key])
    assert.equal((await stat(join(root,'family/relay.env'))).mode & 0o777,0o600)
    assert.equal((await stat(join(root,'family'))).mode & 0o777,0o700)
    assert.equal(JSON.stringify(await listAgents(root)).includes(base.token),false)
    await assert.rejects(createAgent({...base,name:'family'}),{code:'EEXIST'})
    assert.equal((await readFile(join(root,'family/relay.env'),'utf8')).includes(base.token),true)
    await assert.rejects(createAgent({...base,name:'../family'}),/agent name/)
    await assert.rejects(createAgent({...base,name:'bad-class',isolation:'seatbelt'}),/isolated or host-capable/)
    await assert.rejects(createAgent({...base,name:'unsupported-isolated',isolation:'isolated'}),/unavailable for grok/)
    const capable=await createAgent({...base,name:'capable',isolation:'host-capable'})
    assert.equal(capable.isolation,'host-capable')
    const capableEnv=parseEnv(await readFile(join(root,'capable/docker.env'),'utf8'))
    assert.equal(capableEnv.EZ_ISOLATION,'host-capable')
    assert.equal(capableEnv.EZ_EXECUTOR_TRANSPORT,'host')
    assert.equal(JSON.parse(await readFile(join(root,'capable/host-executor.json'),'utf8')).isolation,'host-capable')
    assert.equal(a.EZ_CODEX_SANDBOX,undefined)
    await assert.rejects(createAgent({...base,name:'bad',token:'do-not-echo'}),e=>!String(e).includes('do-not-echo'))
    await assert.rejects(createAgent({...base,name:'verbose',purpose:'x'.repeat(2001)}),/concise purpose/)
  } finally { await rm(root,{recursive:true,force:true}) }
})


test('package installer records its CLI before any agent exists; creation inherits it', async () => {
  const root=await mkdtemp(join(tmpdir(),'ez-installer-cli-'))
  try {
    await assert.rejects(installationCli(root), /no default is guessed/)
    assert.equal(await installationCli(root,'codex'),'codex')
    const agent=await createAgent({root,hostRoot:'/private/agents',composeFile:'/opt/ez/compose.yaml',name:'shopper',purpose:'Family shopping',token:'123456789:'+'a'.repeat(30)})
    assert.equal(agent.executor,'codex')
    assert.equal(agent.isolation,'isolated')
    const env=parseEnv(await readFile(join(root,'shopper/docker.env'),'utf8'))
    assert.equal(env.EZ_ISOLATION,'isolated')
    assert.equal(env.EZ_EXECUTOR_TRANSPORT,'local')
    assert.equal(env.EZ_CODEX_SANDBOX,'external')
    assert.equal(env.EZ_DELIVERY_TCP_PORT,undefined)
    assert.equal(env.COMPOSE_FILE,'/opt/ez/compose.yaml')
    assert.equal(JSON.parse(await readFile(join(root,'shopper/host-executor.json'),'utf8')).agents[0].toolsHome,'/private/agents/shopper/tools')
    assert.equal(await installationCli(root),'codex')
    await assert.rejects(installationCli(root,'grok'),/already selected/)
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('agent installation records an isolated Codex provider profile without its key', async () => {
  const root=await mkdtemp(join(tmpdir(),'ez-installer-provider-'))
  try {
    const codexProvider={id:'openrouter',name:'OpenRouter',baseUrl:'https://openrouter.ai/api/v1',envKey:'OPENROUTER_API_KEY',models:['google/gemini-3.8-flash','deepseek/deepseek-v4.1-flash']}
    const agent=await createAgent({root,hostRoot:'/private/agents',composeFile:'/opt/ez/compose.yaml',name:'coach',purpose:'Fitness coach',token:'123456789:'+'a'.repeat(30),cli:'codex',codexProvider})
    const host=JSON.parse(await readFile(join(root,'coach/host-executor.json'),'utf8'))
    assert.deepEqual(host.agents[0].codexProviders,[codexProvider])
    assert.equal(JSON.stringify(agent).includes('OPENROUTER_API_KEY'),false)
    assert.equal(JSON.stringify(host).includes('sk-'),false)
    await assert.rejects(createAgent({root,hostRoot:'/private/agents',composeFile:'/opt/ez/compose.yaml',name:'bad-provider',purpose:'x',token:'123456789:'+'b'.repeat(30),codexProvider:{...codexProvider,baseUrl:'http://openrouter.ai/api/v1'}}),/provider URL/)
  } finally { await rm(root,{recursive:true,force:true}) }
})
