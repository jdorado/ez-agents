import { main } from './external-engine-mcp.mjs';
main(process.argv.slice(2)).catch(() => { console.error('EXTERNAL_ENGINE_UNAVAILABLE'); process.exitCode = 1; });
