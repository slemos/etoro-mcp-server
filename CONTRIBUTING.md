# Contributing

Thanks for helping. This server touches real brokerage accounts, so the bar for write-capable changes is deliberately high.

## Setup

```bash
npm ci
npm run typecheck && npm test
```

The test suite uses a mocked eToro API and an in-memory MCP client/server pair: no network and no keys are needed. Please never put real keys, account ids or live response data in issues, tests or commits.

## Ground rules

1. **Every eToro route lives in `src/endpoints.ts`** with the right `kind` (`read` or `write`). The HTTP client refuses anything not described there. Link the eToro reference page in your PR; if a path is inferred rather than documented, mark it `inferred`.
2. **Read and write are separate tools.** A read tool must never change state. (POST queries that only compute, such as cost and eligibility checks, are reads.)
3. **Anything that moves money or changes positions goes through preview → `etoro_confirm_action`**, with a cap check at preview time and an audit event. Do not add tools that execute orders directly.
4. **Annotations are required** on every tool: `title`, `readOnlyHint`, `destructiveHint`, plus `idempotentHint`/`openWorldHint`.
5. **Tool descriptions are factual.** They say what the tool does, what it returns and what it does *not* do. They must not tell the model how to behave ("always…", "you must…").
6. **Tight schemas.** Use zod constraints and `.describe()` on parameters; cross-field rules are validated in the handler with a helpful error.
7. **No secrets anywhere.** Keys must not appear in tool inputs, results, errors, logs or tests (use obvious dummy values).
8. Add tests for new behavior, including the failure and blocked paths.

## Pull requests

- Keep changes focused; update `README.md`, `docs/TOOLS.md` and `CHANGELOG.md` when behavior changes.
- `npm run typecheck`, `npm test` and `npm run build` must pass; for packaging changes also run `npm run mcpb:validate`.
- Bump `VERSION` in `src/version.ts` together with `package.json` and `manifest.json` only in release PRs (a test checks they match).
