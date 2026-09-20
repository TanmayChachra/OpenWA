# 34 - Fork touchpoints and upstream sync checklist

This fork carries two feature modules (Client Mapping and the GBrain export) on top of OpenWA. This page
lists every place they touch core files, so an upstream sync is a checklist instead of a surprise.

## Why not a plugin

The plugin runtime cannot host these features. A plugin has no REST routes, no database tables, no
dashboard pages (only one config iframe), and its network calls are SSRF-blocked to private addresses, so
it cannot reach `identity-hub` on the Docker network or this API on localhost. See
[19 - Plugin Architecture](./19-plugin-architecture.md) and [30 - Plugin Sandboxing](./30-plugin-sandboxing.md).
So the modules stay in this repo, but isolated: runtime coupling goes through the hook bus, and the
remaining core edits are the small, additive list below.

## Fork-owned (upstream never edits these, no conflicts expected)

- `src/modules/client-mapping/`, `src/modules/gbrain-export/`
- `src/database/migrations/1786500000000` to `1786800000000` fork migrations and their `__tests__`
- `dashboard/src/fork/` (API client and query hooks), `dashboard/src/pages/ClientMappings.*`
- `docs/32`, `docs/33`, this page, `scripts/preview-client-mapping-merge.ts`

## Runtime coupling: the hook bus

`ClientMappingAutoTagService` registers a `message:persisted` handler (owner id `unbundl-client-mapping`)
in `onModuleInit`. Core's session module does not import or call it. The hook fires only for a newly
persisted row and also for phone-composed sends, so the handler filters on `direction === 'incoming'`.
The one behavioural difference from a direct call: a message whose insert failed transiently is not
auto-tagged (the next message from that chat tags it).

## Core files with fork edits (all additive)

| File                                                                                    | Edit                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/app.module.ts`                                                                     | import and list the two modules, two entity globs                                          |
| `src/database/data-source.ts`                                                           | two entity globs for the migration CLI                                                     |
| `src/config/configuration.ts`, `src/config/env-precedence.ts`                           | `clientMapping.*` and `gbrainExport.*` config, env names                                   |
| `src/modules/infra/export-tables.ts`, `table-importers.ts`, `migration-tables.types.ts` | backup registry, importers and row types for `client_mappings` and `gbrain_export_state`   |
| `src/modules/infra/dto/infra-response.dto.ts`, `infra-data.service.ts`                  | response DTO keys, restore-time table clears                                               |
| `src/modules/infra/export-tables.parity.spec.ts`, `infra-data.controller.spec.ts`       | classify fork entity roots, add the two entities to the test DataSources                   |
| `src/database/postgres-utc.pg.spec.ts`                                                  | add the two entities to its DataSource                                                     |
| `dashboard/src/App.tsx`, `components/Layout.tsx`                                        | Client Mappings route and nav entry                                                        |
| `dashboard/src/pages/Chats.tsx`, `components/chats/ChatThread.tsx`, `pages/Chats.css`   | Tag-as-Client button, mapped badges, per-sender tag button                                 |
| `dashboard/src/services/api.ts`                                                         | one word: `request` is exported so `src/fork/` can use it                                  |
| `dashboard/src/utils/chatMessages.ts`, `timezones.ts` (+ tests)                         | `@mention` name resolution, timezone list                                                  |
| `src/engine/adapters/wwebjs-messaging.ts` (+ spec)                                      | history sender via `getContact()` (also proposed upstream as #1675; drop ours once merged) |
| `.env.example`, `docker-compose.yml`, `docker-compose.dev.yml`                          | env passthrough                                                                            |
| `docs/06`, `07`, `14`, `18`, `openapi.json`, `sdk/README.md`                            | docs and contract for the fork routes, migration examples, SDK exclusions                  |

## Sync checklist

1. `git fetch origin`, merge `origin/main` on a branch (never straight onto `main`).
2. Conflicts are almost always in `package.json`, the lockfile, `App.tsx`, `Chats.tsx`, `ChatThread.tsx`.
   Take upstream's `package.json` and lockfile, then re-add the fork lines in the others (both sides are
   additive, keep both).
3. New upstream guards can reference tables or entities: run the whole gate below, not only the tests you
   expect to break. Past catches: docs migration examples must list every table; the Postgres UTC spec
   builds its own DataSource.
4. Gate: `npx tsc --noEmit`, `npm run lint`, `npm run format:check`, `npm run test:docs`,
   `npm run check:sdk-coverage`, `npm run openapi:export` (commit the diff), dashboard `npm test`,
   and the Postgres specs with `TZ=Asia/Jakarta` against a real Postgres 16 (see `.github/workflows/ci.yml`),
   plus `npm run build && npm run test:pg-smoke`.
5. `openapi.json` path order follows module registration order, so a change to which module imports which can reorder it without changing content. `npm run openapi:check` is a text diff: regenerate with `npm run openapi:export` and commit.
6. Windows only: `npm install` can drop `@emnapi/*` from `package-lock.json` and break Linux `npm ci`.
   Diff the lockfile for removed `node_modules/` entries before pushing. Known local-only failures
   (storage and permission specs, `docs-ci-jobs` on CRLF) also fail on pristine upstream.
7. Push to the fork, wait for CI green, then merge.
