# Testing Strategy

Last updated: 2026-02-12

## Goals

- Catch contract regressions early (required params, method schemas, routing).
- Keep tests fast and local-first via Bun test runner.
- Provide one manual end-to-end smoke check against a real model.

## Commands

- `bun run test:unit`
- `bun run test:integration`
- `bun run test:smoke`
- `bun run test:e2e`
- `bun run test:smoke-all`

## Phases

1. Unit tests (fast, pure logic)

- CLI argument parsing/coercion.
- CLI JSON Schema `$ref` resolution.
- CLI required param/type validation.
- Extension manager method validation and source routing.

2. Integration tests (in-process components)

- Extension event subscription + wildcard routing behavior.
- Gateway extension manager with multiple extensions.

3. End-to-end smoke (manual, low-cost)

- Connect to running gateway.
- Create workspace + session explicitly.
- Send one cheap prompt and assert stream completes.

## Smoke scripts

### Quick smoke (no model call)

`bun run test:smoke`

Checks:

- `GET /health`
- `method.list` over gateway WebSocket

Env:

- `CLAUDIA_GATEWAY_HTTP` (default `http://localhost:30086`)
- `CLAUDIA_GATEWAY_WS` (default `ws://localhost:30086/ws`)

### E2E smoke (uses model)

`bun run test:e2e`

Checks:

- `workspace.getOrCreate`
- `workspace.createSession`
- `session.prompt` streaming completion + expected output marker

Env:

- `CLAUDIA_GATEWAY_WS` (default `ws://localhost:30086/ws`)
- `CLAUDIA_SMOKE_MODEL` (default `claude-3-5-haiku-latest`)
- `CLAUDIA_SMOKE_THINKING` (default `false`)
- `CLAUDIA_SMOKE_EFFORT` (default `low`)
- `CLAUDIA_SMOKE_TIMEOUT_MS` (default `60000`)

## Notes

- E2E smoke intentionally uses explicit `workspaceId/sessionId/model/thinking/effort` APIs.
- For local development, run `bun run test:smoke-all` before big refactors.
- Add new tests next to changed packages (`*.test.ts` for unit, `*.integration.test.ts` for integration).
