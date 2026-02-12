# Script Conventions

Last updated: 2026-02-12

## Goals

- Keep local commands easy to remember.
- Keep workspace scripts consistent (`build`, `test`, `dev/start` where relevant).
- Keep root scripts as orchestration entry points.

## Recommended Standard

Per workspace package/extension/client:
- `build`: compile/package this workspace.
- `test`: run local tests for this workspace.
- `typecheck`: run local TS type checks (or explicit no-op for non-TS apps).
- `dev`: watch-mode local development (if applicable).
- `start`: run once (services/tools, if applicable).

Root scripts:
- `dev`: start gateway dev mode.
- `build`: build all workspaces that expose `build`.
- `test`: broad test runner.
- `test:unit`, `test:integration`, `test:smoke`, `test:e2e`: focused quality gates.
- `typecheck`: full repo typecheck via root `tsconfig.json`.
- `typecheck:all`: per-workspace typecheck scripts.
- `precommit`: `typecheck` + `lint-staged`.

## Current Notes

- Core packages/extensions/clients expose `build`/`test`/`typecheck` consistently.
- iOS and menubar clients keep explicit `typecheck` no-op scripts because they are non-TS (Xcode/Swift).
- Husky pre-commit hook runs root `typecheck` and then `lint-staged`.

## Suggested Next Cleanup

1. Add per-workspace `lint` only where config exists, then optional root `lint:all`.
2. Decide whether pre-commit should run full root `typecheck` (strict) or per-workspace `typecheck:all` (more granular).
