import { readFileSync } from 'node:fs';
const relayControl = process.env.EZ_HEALTH_RELAY_CONTROL_DIR || '/state/control';
const fail = code => { process.stderr.write(`EZ_HEALTH_${code}\n`); process.exit(1); };
let value;
try { value = JSON.parse(readFileSync(relayControl + '/heartbeat.json', 'utf8')); }
catch { fail('RELAY_UNREADABLE'); }
if (!value.polling) fail('RELAY_NOT_POLLING');
if (!Number.isFinite(value.at) || Date.now() - value.at > 20000) fail('RELAY_STALE');

if (process.env.EZ_EXECUTOR_TRANSPORT === 'host') {
  let host;
  try { host = JSON.parse(readFileSync(process.env.EZ_CONTROL_DIR + '/host-executor/heartbeat.json', 'utf8')); }
  catch { fail('HOST_UNREADABLE'); }
  if (!Number.isFinite(host.at) || Date.now() - host.at > 15000) fail('HOST_STALE');
}
