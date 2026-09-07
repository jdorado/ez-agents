#!/usr/bin/env node
import { main } from '../src/plugins/manager.mjs';
main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ok:false,error:error.message})); process.exitCode=1; });
