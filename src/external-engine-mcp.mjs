import { openExternalEnvironment, ExternalEngineError } from './external-engine.mjs';
import { StringDecoder } from 'node:string_decoder';
import { once } from 'node:events';

const MAX_FRAME = 65_536;
const versions = ['2025-06-18', '2025-03-26', '2024-11-05'];

// Stdio only: its launcher/operator is the local authority. Remote authentication
// belongs to the separately approved transport (for example Secure MCP Tunnel).
export async function serveExternalEngine(input, output, engine) {
  let buffer = '', initialized = false, ready = false;
  const decoder = new StringDecoder('utf8');
  const send = async value => {
    if (!output.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')) await once(output, 'drain');
  };
  for await (const chunk of input) {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let request, id = null;
      try {
        if (Buffer.byteLength(line) > MAX_FRAME) throw Error();
        request = JSON.parse(line);
        if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
            Object.keys(request).some(key => !['jsonrpc','id','method','params'].includes(key))) throw Error();
        if (Object.hasOwn(request, 'id')) {
          if (!(typeof request.id === 'string' && request.id.length <= 80 || Number.isSafeInteger(request.id))) throw Error();
          id = request.id;
        }
        if (!Object.hasOwn(request, 'id')) {
          if (request.method === 'notifications/initialized' && initialized) ready = true;
          continue;
        }
        let result;
        if (request.method === 'initialize' && !initialized) {
          initialized = true;
          result = { protocolVersion: versions.includes(request.params?.protocolVersion) ? request.params.protocolVersion : versions[0],
            capabilities: { tools: {} }, serverInfo: { name: 'ez-external-engine', version: '1' } };
        } else if (request.method === 'ping') result = {};
        else if (!ready) throw new ExternalEngineError('NOT_INITIALIZED');
        else if (request.method === 'tools/list') {
          if (request.params !== undefined && (!request.params || Array.isArray(request.params) ||
            Object.keys(request.params).some(key => key !== '_meta'))) throw new ExternalEngineError('INVALID_ARGUMENTS');
          result = { tools: await engine.listTools() };
        }
        else if (request.method === 'tools/call') {
          const params = request.params;
          if (!params || Array.isArray(params) || typeof params.name !== 'string' ||
              Object.keys(params).some(key => !['name','arguments','_meta'].includes(key))) throw new ExternalEngineError('INVALID_ARGUMENTS');
          try {
            const value = await engine.callTool(params.name, Object.hasOwn(params, 'arguments') ? params.arguments : {});
            result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
          } catch (error) {
            const code = error instanceof ExternalEngineError ? error.code : 'EXTERNAL_READ_FAILED';
            result = { isError: true, content: [{ type: 'text', text: code }] };
          }
        } else throw new ExternalEngineError('UNSUPPORTED_METHOD');
        await send({ id, result });
      } catch (error) {
        await send({ id, error: { code: error instanceof ExternalEngineError ? -32602 : -32600,
          message: error instanceof ExternalEngineError ? error.code : 'INVALID_REQUEST' } });
      }
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME) { await send({ id: null, error: { code: -32600, message: 'FRAME_TOO_LARGE' } }); return; }
  }
}

export async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('ezenciel-agents-external-engine --binding /absolute/host-owned/grant.json\nRead-only stdio MCP. Empty exposure by default; no model, relay, writes or remote authentication setup.');
    return;
  }
  if (args.length !== 2 || args[0] !== '--binding') throw new ExternalEngineError('INVALID_BINDING');
  await serveExternalEngine(process.stdin, process.stdout, await openExternalEnvironment(args[1]));
}
