// Smoke test: the bridge turns a pulled TS 7 diagnostic into a push notification.
// Requires TypeScript 7 `tsc` on PATH. Run: node test/smoke.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const bridge = fileURLToPath(new URL('../plugins/typescript7-lsp/bridge.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'lsp-bridge-smoke-'));
writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }));
const file = join(root, 'probe.ts');
const text = 'export const probe: number = "one";\n';
writeFileSync(file, text);
const rootUri = pathToFileURL(root).href;
const uri = pathToFileURL(file).href;

const child = spawn('node', [bridge, 'tsc', '--lsp', '--stdio'], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
const send = (message) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const finish = (passed, detail) => {
  console.log(passed ? `PASS ${detail}` : `FAIL ${detail}`);
  child.kill();
  rmSync(root, { recursive: true, force: true });
  process.exit(passed ? 0 : 1);
};

let buffer = Buffer.alloc(0);
child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const length = Number(/Content-Length: *(\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
    buffer = buffer.subarray(headerEnd + 4 + length);
    if (message.id === 1) {
      send({ method: 'initialized', params: {} });
      send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version: 1, text } } });
    } else if (message.method === 'textDocument/publishDiagnostics' && message.params.uri === uri) {
      const codes = message.params.diagnostics.map((diagnostic) => diagnostic.code);
      finish(codes.includes(2322), `pushed diagnostic codes: ${JSON.stringify(codes)}`);
    } else if (message.method && message.id !== undefined) {
      send({ id: message.id, result: null });
    }
  }
});

send({
  id: 1,
  method: 'initialize',
  params: { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'smoke' }], capabilities: { textDocument: { publishDiagnostics: {} } } },
});
setTimeout(() => finish(false, 'no push diagnostics for probe.ts within 20s'), 20000);
