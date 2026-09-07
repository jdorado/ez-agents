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
    const one=await createAgent({...base,name:'family'})
    const two=await createAgent({...base,cli:undefined,name:'work',token:'987654321:'+'b'.repeat(30)})
    assert.notEqual(one.project,two.project)
    assert.equal(two.executor,'grok')
    await assert.rejects(createAgent({...base,name:'different-cli',cli:'codex'}),/already selected/)
    const host=JSON.parse(await readFile(join(root,'family/host-executor.json'),'utf8'))
    assert.equal(host.cli,'grok')
    assert.equal(host.agents[0].workspace,'/private/agents/family/mind')
    const a=parseEnv(await readFile(join(root,'family/docker.env'),'utf8'))
    const b=parseEnv(await readFile(join(root,'work/docker.env'),'utf8'))
    for(const key of ['COMPOSE_PROJECT_NAME','EZ_RELAY_ENV_FILE','EZ_AGENT_PURPOSE_FILE','EZ_AGENT_WORKSPACE','EZ_CONTROL_DIR','EZ_WHATSAPP_IPC_VOLUME','EZ_WHATSAPP_CLIENT_VOLUME'])assert.notEqual(a[key],b[key])
    assert.equal((await stat(join(root,'family/relay.env'))).mode & 0o777,0o600)
    assert.equal((await stat(join(root,'family'))).mode & 0o777,0o700)
    assert.equal(JSON.stringify(await listAgents(root)).includes(base.token),false)
    await assert.rejects(createAgent({...base,name:'family'}),{code:'EEXIST'})
    assert.equal((await readFile(join(root,'family/relay.env'),'utf8')).includes(base.token),true)
    await assert.rejects(createAgent({...base,name:'../family'}),/agent name/)
    await assert.rejects(createAgent({...base,name:'bad',token:'do-not-echo'}),e=>!String(e).includes('do-not-echo'))
  } finally { await rm(root,{recursive:true,force:true}) }
})


test('package installer records its CLI before any agent exists; creation inherits it', async () => {
  const root=await mkdtemp(join(tmpdir(),'ez-installer-cli-'))
  try {
    await assert.rejects(installationCli(root), /no default is guessed/)
    assert.equal(await installationCli(root,'codex'),'codex')
    const agent=await createAgent({root,hostRoot:'/private/agents',composeFile:'/opt/ez/compose.yaml',name:'shopper',purpose:'Family shopping',token:'123456789:'+'a'.repeat(30)})
    assert.equal(agent.executor,'codex')
    assert.equal(await installationCli(root),'codex')
    await assert.rejects(installationCli(root,'grok'),/already selected/)
  } finally { await rm(root,{recursive:true,force:true}) }
})
