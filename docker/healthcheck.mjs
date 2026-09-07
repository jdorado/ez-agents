import { readFileSync } from 'node:fs';
const value = JSON.parse(readFileSync('/state/control/heartbeat.json', 'utf8'));
if (!value.polling || Date.now() - value.at > 20000) process.exit(1);

if (process.env.EZ_EXECUTOR_TRANSPORT === 'host') {
  const host = JSON.parse(readFileSync(process.env.EZ_CONTROL_DIR + '/host-executor/heartbeat.json', 'utf8'));
  if (Date.now() - host.at > 15000) process.exit(1);
}
