# Claudia Documentation

Detailed design docs for Claudia's architecture, APIs, and subsystems.

For a high-level overview, see the [project README](../README.md). For dev setup and tooling, see [DEVELOPMENT.md](../DEVELOPMENT.md).

## Architecture & Design

| Doc                                        | Description                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| [ARCHITECTURE.md](./ARCHITECTURE.md)       | Full system architecture — gateway, dual-engine runtime (CLI + SDK), data flow, session lifecycle, watchdog, file map |
| [GATEWAY.md](./GATEWAY.md)                 | Gateway internals — WebSocket protocol, method routing, event subscriptions, runtime connection, source routing       |
| [SESSION-CONTEXT.md](./SESSION-CONTEXT.md) | Session runtime deep-dive — engine comparison, architecture history, session ID management, event flow                |
| [EXTENSIONS.md](./EXTENSIONS.md)           | Extension system — authoring guide, lifecycle, method/event contracts, out-of-process hosting, HMR                    |

## API & Contracts

| Doc                                    | Description                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------- |
| [API-REFERENCE.md](./API-REFERENCE.md) | Complete WebSocket API — all methods, schemas, request/response examples    |
| [HEALTHCHECKS.md](./HEALTHCHECKS.md)   | Extension health check contract — response shape, status meanings, coverage |

## Operations & Testing

| Doc                          | Description                                                     |
| ---------------------------- | --------------------------------------------------------------- |
| [TESTING.md](./TESTING.md)   | Testing strategy — unit, smoke, E2E, and how to run them        |
| [SCRIPTS.md](./SCRIPTS.md)   | Script reference — smoke tests, E2E scripts, utility scripts    |
| [SECURITY.md](./SECURITY.md) | Security model — trust model, Tailscale networking, permissions |

## Subsystems

| Doc                                | Description                                                   |
| ---------------------------------- | ------------------------------------------------------------- |
| [MEMORY.md](./MEMORY.md)           | Memory system — MCP server, persistent memory architecture    |
| [DOMINATRIX.md](./DOMINATRIX.md)   | Browser control — Chrome extension bridge for page automation |
| [ENTITLEMENT.md](./ENTITLEMENT.md) | Entitlement system — capabilities and permission model        |
