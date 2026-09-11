// Read-only package boundary check; no credentials or provider access.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
assert.equal(readFileSync('docker/pnpm-lock.yaml','utf8'),readFileSync('pnpm-lock.yaml','utf8'),'Refresh docker/pnpm-lock.yaml after dependency changes');
const p=JSON.parse(readFileSync('package.json','utf8'));
const compose=readFileSync('compose.yaml','utf8');
assert.match(compose,/healthcheck:\s+test: \[CMD, node, \/app\/docker\/healthcheck\.mjs\][\s\S]*?interval: 10s[\s\S]*?start_period: 60s[\s\S]*?retries: 3/,'Relay health grace must cover grammY default long polling');
const [pack]=JSON.parse(execFileSync('npm',['pack','--dry-run','--ignore-scripts','--json'],{encoding:'utf8'}));
const names=pack.files.map(f=>f.path);
for(const required of ['LICENSE','README.md','SECURITY.md','CONTRIBUTING.md','CHANGELOG.md','THIRD_PARTY_NOTICES.md','Dockerfile','.dockerignore','docker/pnpm-lock.yaml']) assert(names.includes(required),`Missing ${required}`);
for(const name of names) assert(!/^agent\//.test(name) && !/(^|\/)(node_modules|\.git|\.private|todo\.md|principles\.md|backlog\.md|sprints\.md)(\/|$)|(^|\/)\.env$|\.(tgz|log)$|(^|\/)(qa|plugin-manager-qa|spec-benchmark)\.md$/.test(name),`Private/internal package entry: ${name}`);
for(const entry of p.files) assert(names.some(name=>name===entry || name.startsWith(entry+'/')),`Declared package entry missing: ${entry}`);
for(const bin of Object.values(p.bin||{})) assert(names.includes(bin),`Missing binary ${bin}`);
if(names.includes('ez-plugin.json')) assert.equal(JSON.parse(readFileSync('ez-plugin.json')).version,p.version);
console.log(JSON.stringify({name:p.name,version:p.version,files:names,unpackedSize:pack.unpackedSize},null,2));
