#!/usr/bin/env node
// Pull-to-push diagnostics bridge for LSP servers.
//
// Usage: node bridge.mjs <server-command> [server-args...]
//
// Some language servers (TypeScript 7 `tsc --lsp`, Roslyn) report per-document
// diagnostics only through pull (`textDocument/diagnostic`, LSP 3.17). Clients
// that consume only push (`textDocument/publishDiagnostics`), such as Claude Code,
// then never see them. This bridge forwards every message unchanged and, after
// each document open/change/save, pulls that document's diagnostics and
// republishes them as a push notification.

import { spawn } from 'node:child_process';

const PULL_DEBOUNCE_MS = 150;
const BRIDGE_ID_PREFIX = 'lsp-bridge-';

const [serverCommand, ...serverArgs] = process.argv.slice(2);
if (!serverCommand) {
  process.stderr.write('usage: node bridge.mjs <server-command> [server-args...]\n');
  process.exit(2);
}

const server = spawn(serverCommand, serverArgs, { stdio: ['pipe', 'pipe', 'inherit'] });

const openDocuments = new Set();
const pendingPullTimers = new Map();
const pullRequestUris = new Map();
let nextPullId = 0;

function write(stream, message) {
  const body = JSON.stringify(message);
  stream.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function createMessageReader(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const lengthMatch = /Content-Length: *(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'));
      if (!lengthMatch) throw new Error('LSP message without Content-Length header');
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number(lengthMatch[1]);
      if (buffer.length < bodyEnd) return;
      const raw = buffer.subarray(0, bodyEnd);
      const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString('utf8'));
      buffer = buffer.subarray(bodyEnd);
      onMessage(message, raw);
    }
  };
}

function schedulePull(uri) {
  clearTimeout(pendingPullTimers.get(uri));
  pendingPullTimers.set(uri, setTimeout(() => {
    pendingPullTimers.delete(uri);
    const id = BRIDGE_ID_PREFIX + nextPullId++;
    pullRequestUris.set(id, uri);
    write(server.stdin, { jsonrpc: '2.0', id, method: 'textDocument/diagnostic', params: { textDocument: { uri } } });
  }, PULL_DEBOUNCE_MS));
}

function publish(uri, diagnostics) {
  write(process.stdout, { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
}

function handleClientMessage(message, raw) {
  server.stdin.write(raw);
  const uri = message.params?.textDocument?.uri;
  switch (message.method) {
    case 'textDocument/didOpen':
      openDocuments.add(uri);
      schedulePull(uri);
      break;
    case 'textDocument/didChange':
    case 'textDocument/didSave':
      schedulePull(uri);
      break;
    case 'textDocument/didClose':
      openDocuments.delete(uri);
      clearTimeout(pendingPullTimers.get(uri));
      pendingPullTimers.delete(uri);
      publish(uri, []);
      break;
  }
}

function handleServerMessage(message, raw) {
  if (pullRequestUris.has(message.id)) {
    const uri = pullRequestUris.get(message.id);
    pullRequestUris.delete(message.id);
    // "unchanged" reports cannot occur: the bridge never sends previousResultId.
    if (message.result?.kind === 'full' && openDocuments.has(uri)) publish(uri, message.result.items);
    return;
  }
  if (message.method === 'workspace/diagnostic/refresh') {
    // The server asks the client to re-pull; the bridge is the pulling client.
    write(server.stdin, { jsonrpc: '2.0', id: message.id, result: null });
    openDocuments.forEach(schedulePull);
    return;
  }
  process.stdout.write(raw);
}

process.stdin.on('data', createMessageReader(handleClientMessage));
process.stdin.on('end', () => server.stdin.end());
server.stdout.on('data', createMessageReader(handleServerMessage));
server.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
server.on('error', (error) => {
  process.stderr.write(`lsp-bridge: failed to start ${serverCommand}: ${error.message}\n`);
  process.exit(1);
});
