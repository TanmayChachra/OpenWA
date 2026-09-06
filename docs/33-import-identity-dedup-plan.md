# 33 — Import Identity De-Duplication Plan

**Status: Phase A done (commit 1eed7550), Phase B done (commit be8bada8). Phase C/D not started.**

Phase B shipped a variant of its original endpoint sketch: `POST
/client-mappings/resolve-and-upsert` dedupes by phone using the entity's
existing (non-unique) `phone` column directly — no `alias_jids`/unique-index
schema change was needed for the app-layer dedup to work correctly, so that
part of Phase C is now optional hardening (a DB-level backstop) rather than a
prerequisite. `ClientMappingIdentityService` resolves `@lid` -> phone via the
same `EngineRegistry` + `LidMappingStoreService` the inbound message path
already uses (see session-lid-resolver.service.ts) — so a lid resolved once
anywhere in the app (a message, an import, this endpoint) is cached for every
other caller too, not just within one import run.


Bug root: Lakshye Kapoor two rows, `919999367045@c.us` + `30378471473326@lid`. WA
own contact store hold two models same real jid, diff `number` field. Group
participant list hand raw unresolved `@lid` jid, never c.us form. 3 separate
code path (auto-tag, top-level import, group-member import) each own dedup
logic, keyed on raw `jid` only — no phone-based merge. Fix one path leave
other two exposed. Need one shared identity layer, not three patches.

## Root cause, one line

Dedup key = `jid`. Same human, two jid (lid + c.us). Key wrong. Must dedup by
**resolved phone**, jid only fallback when phone unresolvable.

## Phase A — stop bleeding (small, ship now)

Target: group-member import path only (`ClientMappings.tsx` `handleImport`,
line ~374), since that's confirmed source of this bug.

1. Before create for group participant: if `participant.id` ends `@lid`,
   call `contactApi.resolvePhone(sessionId, participant.id)` (same call
   `handleTagSender` in Chats.tsx already use — proven works).
2. Resolved phone → check `existingKeys`-style map keyed by **phone**, not
   jid, across `allMappings` already loaded. Match → skip create, bump
   `skipped` counter. No match → create as before.
3. Reuse existing `createWithRetry` for the resolvePhone call too — same
   429 risk as create calls, same backoff.
4. Unresolvable lid (resolvePhone → null): create anyway (today's
   behavior), log a `console.warn`-visible skip reason so a future "why 2
   rows again" has evidence, not inference.

Cost: 1 extra network call per group participant whose id is `@lid` AND not
already phone-matched. Bounded by group size, backoff absorbs 429.

Verify: re-run Import from Chats live, confirm Lakshye-shaped case (person
known both via lid group membership and c.us 1:1 contact) produces exactly
one row. Check via direct API query same way prior fix verified — never
trust UI glance alone.

## Phase B — kill the 3-copies-of-dedup-logic problem (structural)

Current: auto-tag (backend, `client-mapping-auto-tag.service.ts`), import
(frontend, `ClientMappings.tsx`), manual tag button (frontend, `Chats.tsx`)
each decide independently whether a row already exists. Phase A only patches
one. Next bug same shape lands in a 4th path nobody thought of.

Move identity resolution + upsert into ONE backend endpoint:

```
POST /client-mappings/resolve-and-upsert
body: { sessionId, jid, kind, nameHint?, phoneHint? }
```

Server does, in order:
1. If `kind === 'contact'` and jid is `@lid`: call engine `resolveContactPhone`
   server-side (already exists, `wwebjs-contacts.ts:173`) — one round trip,
   not per-caller reimplementation.
2. Look up existing mapping by **phone** first (new indexed column, see
   Phase C), fall back to `(sessionId, jid, kind)` only when phone unknown.
3. Match on phone, different jid → this IS the alias case. Do not create
   second row. Instead: append jid to row's alias set (Phase C schema),
   return existing row untouched otherwise.
4. No match anywhere → create, same as today.

All three call sites (auto-tag, import, manual tag) call this ONE endpoint
instead of each reimplementing "does this exist" + "resolve phone" +
"create". Bug fixed once, fixed everywhere, permanently.

## Phase C — schema: phone is the identity, jid is an alias

```sql
ALTER TABLE client_mappings ADD COLUMN alias_jids TEXT; -- JSON array
CREATE UNIQUE INDEX idx_client_mapping_session_phone
  ON client_mappings (session_id, phone) WHERE phone IS NOT NULL;
```

- `jid` stays primary contact point (unchanged, no migration risk to
  existing single-jid rows).
- `alias_jids` collects every OTHER jid WhatsApp has used for same phone
  (lid seen in group N, lid seen in group M, etc) — informational, lets
  future group-import matching skip the resolvePhone call entirely once an
  alias is already known for that lid.
- Partial unique index on phone (`WHERE phone IS NOT NULL`) stops a second
  contact row for a resolved phone at the DB layer — belt + suspenders under
  the app-layer check in Phase B, catches any path someone adds later that
  forgets to call the shared endpoint.
- Groups (`kind = 'group'`) have no phone — index `WHERE phone IS NOT NULL`
  correctly excludes them, existing `(sessionId, jid, kind)` unique index
  still governs those.

Migration: standard `migrations/` file per this repo's TypeORM convention +
matching `data-source.ts` entity update — same pattern as original
`ClientMapping` entity add. Backfill: existing duplicate rows (same phone,
different jid, both currently legal under old schema) need one-time merge
BEFORE the unique index can apply — see Phase D.

## Phase D — one-time backfill + ongoing reconciliation

1. One-off script (`scripts/merge-duplicate-client-mappings.ts`, run once,
   throwaway): group existing rows by `(sessionId, phone)` where phone not
   null, count > 1 → keep the row with more filled fields (company/team/role
   non-Unknown wins), move loser's jid into winner's `alias_jids`, delete
   loser. Log every merge (id kept, id deleted, jids merged) — evidence, not
   inference, matching the lesson from the Athar/Isha incident.
2. Ongoing: Phase C's unique index makes new duplicates impossible to insert
   (DB throws, `isUniqueViolation` catch already exists in auto-tag service,
   same catch pattern reusable in the new shared endpoint) — so no cron job
   needed, the constraint IS the ongoing reconciliation.

## Test coverage (what "regression test" means here — no unit-test harness
exists yet for ClientMappings.tsx, per this session; do NOT skip verification,
substitute live-API verification same rigor as a unit test would give)

- Backend: `client-mapping.service.spec.ts` — new tests for
  `resolve-and-upsert`: (a) same phone two calls two different jid → one row,
  `alias_jids` has both; (b) unresolvable lid → creates row keyed on lid,
  no crash; (c) unique-violation race on phone index → caught, no 500.
- Live verification (Phase A ships first, before B/C exist): re-run Import
  from Chats against the `unbundl` session, direct `curl` the
  `/api/client-mappings` endpoint (not the UI) grouped by phone, assert max
  count 1 per phone — same method used to verify Srishti/Rohit fix.

## Sequencing

A now (contains today's exact bug class). B+C+D next session as one unit —
splitting them risks a half-migrated schema (alias_jids column with no
unique index yet enforcing it is a false sense of safety).

## Non-goals

Not attempting: resolving `@lid` name display generally (separate concern,
already solved for messages via mention-name resolution earlier this
session), or a UI for manually merging mappings (Phase D script + unique
index makes manual merge unnecessary going forward).
