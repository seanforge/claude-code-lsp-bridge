# claude-code-lsp-bridge

TypeScript 7 code intelligence for Claude Code: navigation and post-edit diagnostics.

## Why

- The official `typescript-lsp` plugin wraps `tsserver.js`, which TypeScript 7 removed.
- TypeScript 7's own server, `tsc --lsp`, reports per-file errors only on request (pull).
  Claude Code only listens for errors the server sends on its own (push).

## Bridge

`bridge.mjs` forwards all LSP traffic unchanged. After each file open, change or save,
it requests that file's errors from the server and sends them to Claude Code as push.

```
Claude Code ◀─push── bridge ──pull─▶ tsc --lsp
```

## Install

Requires Node.js and TypeScript 7 as the first `tsc` on `PATH` (`npm i -g typescript@7`).

```sh
claude plugin marketplace add seanforge/claude-code-lsp-bridge
claude plugin install typescript7-lsp@lsp-bridge
claude plugin disable typescript-lsp@claude-plugins-official
```

Restart Claude Code.

## Verify

Ask Claude to add a type error to a `.ts` file. Expect
`Found 1 new diagnostic issue in 1 file`, possibly under the step after the edit.

Smoke test: `node test/smoke.mjs`

## License

MIT
