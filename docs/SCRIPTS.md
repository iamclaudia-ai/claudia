# Script Conventions

Last updated: 2026-02-12

## Goals

- Keep local commands easy to remember.
- Keep workspace scripts consistent (`build`, `test`, `dev/start` where relevant).
- Keep root scripts as orchestration entry points.

## Recommended Standard

Per workspace package/extension:
- `build`: compile/package this workspace.
- `test`: run local tests for this workspace.
- `dev`: watch-mode local development (if applicable).
- `start`: run once (services/tools, if applicable).

Root scripts:
- `dev`: start gateway dev mode.
- `build`: build all workspaces that expose `build`.
- `test`: broad test runner.
- `test:unit`, `test:integration`, `test:smoke`, `test:e2e`: focused quality gates.

## Current Notes

- Core packages and extensions now expose `build`/`test` consistently.
- iOS workspace includes placeholder `build`/`test` scripts because builds happen via Xcode tooling.
- Typechecking is still intentionally selective until monorepo TS config is fully standardized.

## Suggested Next Cleanup

1. Add `typecheck` script to every TS workspace once shared TS config is stabilized.
2. Add root `typecheck:all` that runs per-workspace typechecks instead of one global `tsc`.
3. Add per-workspace `lint` only where config exists, then optional root `lint:all`.
