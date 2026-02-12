# Extension Health Checks

Last updated: 2026-02-12

## Contract

Every extension should expose a `{extensionId}.health-check` method with:

- `inputSchema`: `z.object({})`
- Output shape: `HealthCheckResponse` from `@claudia/shared`

```ts
interface HealthCheckResponse {
  ok: boolean;
  status: string; // healthy | degraded | disconnected | error
  label: string;
  metrics?: Array<{ label: string; value: string | number }>;
  actions?: Array<...>; // optional UI actions
  items?: Array<...>;   // optional managed resources
}
```

Notes:

- `ok` is a binary readiness signal.
- `status` is a UI-facing state string.
- `label` should be stable and human-readable.
- `metrics/actions/items` are optional and extension-specific.

## Current Extension Coverage

| Extension         | Method                         | Status      |
| ----------------- | ------------------------------ | ----------- |
| `chat`            | `chat.health-check`            | implemented |
| `voice`           | `voice.health-check`           | implemented |
| `imessage`        | `imessage.health-check`        | implemented |
| `mission-control` | `mission-control.health-check` | implemented |

## Recommended Status Meanings

- `healthy`: extension is available and core dependency is connected.
- `degraded`: extension is partially available.
- `disconnected`: extension dependency is offline/unavailable.
- `error`: extension is in a hard failure state.

## Mission Control Consumption

Mission Control should prefer calling `{id}.health-check` for display data, and use `extension.health()` only as a lightweight fallback for server diagnostics.
