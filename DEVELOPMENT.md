# Development Guide

Last updated: 2026-02-20

## Overview

This repo is Bun-first across packages, extensions, and most clients.

- Package manager/runtime: `bun`
- TypeScript checking:
  - Fast local check: `tsgo` (TypeScript native preview)
  - Canonical check: `tsc`
- Linting: `oxlint`
- Formatting: `oxfmt`
- Git hooks: `husky`
- Staged-file tasks: `lint-staged`

## Prerequisites

- Bun installed
- macOS tools if working on iOS/menubar clients (`xcodebuild`, etc.)

Install dependencies:

```bash
bun install
```

## Common Commands

### Run app

```bash
bun run dev
```

### Build all workspaces

```bash
bun run build
```

### Typecheck

Fast (pre-commit oriented):

```bash
bun run typecheck:fast
```

Canonical (authoritative):

```bash
bun run typecheck
```

Per-workspace aggregate:

```bash
bun run typecheck:all
```

### Lint + format

```bash
bun run lint
bun run format
```

### Tests

```bash
bun run test:unit
bun run test:integration
bun run test:smoke
bun run test:e2e
bun run test:smoke-all
```

## Git Hooks

### Pre-commit

Runs:

1. `bun run typecheck:fast`
2. `lint-staged`

`lint-staged` tasks:

- `*.{ts,tsx,js,jsx,mjs,cjs}`
  1. `bunx oxfmt --write`
  2. `oxlint`
- `*.{json,md,css,html,yml,yaml}`
  1. `bunx oxfmt --write`

### Pre-push

Runs:

1. `bun run typecheck`
2. `bun run test:unit`

## Workspace Script Convention

Each workspace should expose these where applicable:

- `build`
- `test`
- `typecheck`
- optional `dev` and/or `start`

Non-TS clients (iOS/menubar) keep explicit no-op `typecheck` scripts for consistency.

## Notes

- Prefer explicit workspace/session IDs in API calls; avoid implicit active context.
- Keep API method schemas explicit (`inputSchema`) for gateway validation and CLI discoverability.
- Run `bun run test:smoke-all` before larger refactors.
