# G Brain Client Mapping & SLA Escalation Monitoring — Phased Plan

Status: DRAFT — awaiting approval
Owner: team@unbundl.com
Restore point: see bottom of this doc

## Goal

Two independent capabilities layered onto OpenWA, each phase additive and independently
rollback-able:

1. **Identity mapping for G Brain** — label WhatsApp contacts/groups/teammates against
   client names, then hand that mapping (plus conversation context) to the G Brain stack
   as ingestible context.
2. **SLA escalation monitoring** — when a client flags something important and it goes
   unanswered past a deadline, fire an outbound notification out-of-band (destination
   TBD: email, Google Chat, or via n8n) — never another WhatsApp message. Later extended
   with per-group sentiment trend monitoring, surfaced directly on the OpenWA dashboard.

## What already exists (reuse, don't rebuild)

- `src/modules/label` — existing label CRUD, currently scoped to WhatsApp-native labels.
- `src/modules/webhook` — durable outbound delivery: outbox + reconciler + retry, this is
  the pattern Phase 2 and Phase 3 notifications reuse rather than inventing new delivery
  infra.
- `src/modules/integration` — ingress/egress fabric: signature verification, retention,
  reconciler, redrive controller. This is the reference architecture for the G Brain
  export job (Phase 2).
- `src/modules/queue` (BullMQ, `QUEUE_NAMES.WEBHOOK` / `INGRESS`) — background job
  pattern with existing processors; SLA checking and export jobs add a new queue name
  here rather than a new job runner.
- `docs/22-n8n-integration.md` — n8n webhook integration already documented. There is
  **no SMTP/email sending and no task-list/Chat-posting integration anywhere in the
  codebase.** Rather than build any of that from scratch, Phase 3 fires a single generic
  outbound webhook through the existing `webhook` fabric; whatever sits on the other end
  (n8n, a Google Chat incoming webhook, a mail API) owns "send email" / "post to Chat" /
  "create task." The destination itself is an explicit open item, not decided here.

## Explicitly NOT in scope (this plan)

- Building an in-house SMTP/email sending service — routed through webhook→n8n instead.
- Building a native task-list/ticketing feature — same, routed externally.
- Real-time G Brain push — Phase 2 ships as a scheduled export (per your answer); a
  webhook-push mode can be a later phase if G Brain's ingestion contract becomes
  real-time.
- Any ML model training for sentiment — Phase 4 uses an off-the-shelf sentiment
  classifier (library or hosted API), not a custom model.

## Rollback strategy (applies to every phase)

Each phase is: one migration (additive, has a clean `down()`), one new module (not
imported by any existing module — existing message/session flow is untouched), and one
config flag that defaults a phase to inert. To roll back a phase:

```bash
# 1. flip the feature flag off (stops new behavior immediately, no deploy needed if flag is env-driven)
# 2. if a full revert is needed: revert the phase's merge commit
git revert -m 1 <phase-merge-commit>
# 3. run the down migration if the table itself needs to go
npm run migration:revert
```

Because phases don't import each other's modules except where explicitly noted (Phase 3
depends on Phase 1's mapping table for "who owns this chat"; Phase 4 depends on Phase 3's
escalation pipeline), rolling back Phase N only requires re-verifying N+1 if N+1 declared
that dependency.

---

## Phase 1 — Client/Teammate/Group Identity Mapping

**Ships:** a `client_mapping` table + CRUD API. Maps a WhatsApp JID (contact, group, or
teammate) to the fields below.

- New entity `ClientMapping` (`src/modules/client-mapping/entities/client-mapping.entity.ts`):

  | Field                    | Notes                                                                                                                                                                                                                                      |
  | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `id`                     | UUID, primary key                                                                                                                                                                                                                          |
  | `jid`                    | WhatsApp contact/group JID, or teammate identifier for `kind='teammate'`                                                                                                                                                                   |
  | `kind`                   | `'contact' \| 'group' \| 'teammate'`                                                                                                                                                                                                       |
  | `name`                   | display name                                                                                                                                                                                                                               |
  | `phone`                  | nullable — groups don't have one                                                                                                                                                                                                           |
  | `company`                | `'Unbundl'` or a client company name — this is the field G Brain uses to group context by client                                                                                                                                           |
  | `team`                   | nullable — `Performance`, `Design`, etc.; applies to teammates, and optionally to which internal team owns a client group                                                                                                                  |
  | `role`                   | _(recommended addition)_ nullable job title/function within `team` (e.g. `Account Manager`, `Designer`) — `team` is the department, `role` is the seat, and Phase 3's escalation payload reads better with both                            |
  | `timezone`               | _(recommended addition)_ nullable IANA tz — Phase 3's SLA deadline should account for the owning teammate's or client's working hours, otherwise a flag at 6pm their time breaches a "2 hour SLA" overnight for no reason                  |
  | `status`                 | _(recommended addition)_ `'active' \| 'inactive'`, default `active` — an offboarded teammate or paused client stops being a valid SLA owner/export target without deleting history                                                         |
  | `backupOwnerId`          | _(recommended addition)_ nullable, self-referencing FK to another `ClientMapping` row — who Phase 3 escalates to if the primary owner doesn't respond either; without this, "notify the team" has no second address to try                 |
  | `sentimentTracking`      | _(recommended addition)_ boolean, default `true`, group-kind only — lets a client opt out of Phase 4 sentiment monitoring per your mapping-level opt-out requirement                                                                       |
  | `notes`                  | _(recommended addition)_ free text — this is the field that makes the G Brain export actually useful "as context for people," not just a name lookup (e.g. "prefers async updates," "escalate anything about billing directly to founder") |
  | `createdAt`, `updatedAt` | standard                                                                                                                                                                                                                                   |

- New module `client-mapping` with controller (CRUD) + service, following the exact
  shape of `src/modules/label`.
- Admin UI: a simple table view in `dashboard/` (list, add, edit, delete) — no new UI
  framework, reuse whatever the dashboard already uses for the label/contact screens.
- Migration: new table only. No changes to `contact`, `group`, or `session` schemas.

**Rollback:** drop the module import from `app.module.ts`, revert the migration. Nothing
else in the system reads this table yet, so this phase is fully inert until Phase 2 or 3
consumes it.

**Exit criteria:** can label a real contact/group/teammate through the API with the full
field set and see it persisted; covered by unit tests mirroring `label.service.spec.ts`.

---

## Phase 2 — G Brain Scheduled Export — Implemented

**GBrain's actual ingestion contract** (pulled from github.com/garrytan/gbrain — this
resolves the open item from the first draft): GBrain is a markdown-native memory system.
It ingests via:

- CLI: `gbrain capture "text"`, `gbrain capture --file <path>`, or `echo "..." | gbrain capture --stdin`
- Webhook: `POST https://your-brain/ingest` with `Authorization: Bearer $TOKEN` and
  `Content-Type: text/markdown`
- It has a first-class **entity** concept (one of its seven memory verbs: `recall`,
  `remember`, `entity`, `synthesize`, `forget`, `context_pack`, `delta`) — this is exactly
  the shape for "people and clients as context," so Phase 1's `ClientMapping` rows map
  naturally onto GBrain entities rather than generic notes.
- It runs on your own hardware/DB ("your hardware, your DB, your keys"), storing markdown
  files in a git repo — so the deployment assumption to confirm is whether GBrain runs
  on the same host/network as OpenWA (CLI path) or is only reachable over the network
  (webhook `/ingest` path).

**Shipped:** new module `src/modules/gbrain-export/` that renders each active `contact`
`ClientMapping` row plus its message delta as one markdown document, and hands it to
GBrain via whichever transport the deployment configures (CLI or webhook — both implement
the same `GBrainSink` interface, so switching is a config change, not a code change).

- **No BullMQ, no cron.** This codebase has no repeatable-job/cron infrastructure
  anywhere — every periodic sweep (`IngressReconcilerService`, `IntegrationRetentionService`,
  `PendingMessageReaperService`, the webhook reconciler) is a plain `setInterval(...).unref()`
  started in `OnModuleInit` and cleared in `OnModuleDestroy`, overlap-guarded with a boolean
  flag. `GbrainExportSchedulerService` follows that exact shape instead of introducing a
  cron dependency for this one feature. `GBRAIN_EXPORT_INTERVAL_MS` (default 24h) is the
  cadence directly — there is no cron expression. A calendar-aware schedule ("the first of
  the month") is future scope if it's ever needed, not this one.
- **Files:** `gbrain-export.module.ts`, `gbrain-export.service.ts` (the `run()`/`exportOne()`
  orchestration — query mappings, query the message delta, render, deliver, checkpoint),
  `gbrain-export-render.ts` (pure markdown renderer, front matter carries `entityId`, `kind`,
  `name`, `company`, `team`, `role`, `phone`, `timezone` — the same Phase 1 fields — plus
  `sessionId`/`jid`/`exportedAt`/`sinceTimestamp`/`messageCount`), `gbrain-sink.interface.ts`,
  `gbrain-sink-cli.service.ts` (Node `spawn`, never a shell, piping markdown to
  `gbrain capture --stdin`), `gbrain-sink-webhook.service.ts` (global `fetch`, no new HTTP
  dependency), `gbrain-export.controller.ts` (`POST /api/gbrain-export/run`, ADMIN +
  unscoped-key gated, same fence as `ClientMappingController`), `gbrain-export-scheduler.service.ts`,
  and `entities/gbrain-export-state.entity.ts` + its migration.
- **Cadence:** one scheduled profile, no separate weekly/monthly split.
  - Default: every `GBRAIN_EXPORT_INTERVAL_MS` (24h), exports the delta since each mapped
    contact's last successfully delivered export (new messages only; a metadata-only edit
    like a corrected team/role still reaches GBrain on the next run since a document is
    rendered — and its front matter always reflects current mapping fields — for every
    mapped contact every run, even one with zero new messages).
  - **Backfill / manual trigger:** `POST /api/gbrain-export/run` takes optional `sessionId`
    (scope to one session), `lookbackDays` (override the checkpoint — e.g. "export this new
    client's whole onboarding history" or "catch up after the scheduler was off for a
    while"), and `dryRun` (render every document, hit neither the sink nor the checkpoint —
    a side-effect-free preview of exactly what a real run would send).
  - Set `GBRAIN_EXPORT_INTERVAL_MS=0` to disable the schedule while keeping the manual
    trigger available (manual calls always work regardless of `GBRAIN_EXPORT_ENABLED`,
    which only gates the _scheduler_, not the controller).
- **Checkpointing, not the full reconciler pattern.** The original plan called for reusing
  the integration module's retention/reconciler pattern (`ingress_events`' pending →
  dispatched → failed state machine with DLQ/redrive). That machinery exists to make inbound
  webhook delivery crash-safe; a nightly batch export doesn't carry the same risk profile —
  a failed or skipped run is retried wholesale next cycle. So Phase 2 ships a much simpler
  `gbrain_export_state` table instead: one row per `(sessionId, jid)` holding
  `lastExportedMessageTimestamp`, advanced only after a confirmed delivery (never on
  `dryRun`, never on a failed send). Documents are capped at `MAX_MESSAGES_PER_DOCUMENT`
  (500) per run per contact; the checkpoint advances only to the newest message actually
  included, so an over-cap chat is retried from exactly where it left off on the next run.
- **Env vars** (see `.env.example`): `GBRAIN_EXPORT_ENABLED`, `GBRAIN_EXPORT_SINK`
  (`cli` | `webhook`), `GBRAIN_CLI_PATH`, `GBRAIN_WEBHOOK_URL`, `GBRAIN_WEBHOOK_TOKEN`,
  `GBRAIN_WEBHOOK_TIMEOUT_MS`, `GBRAIN_EXPORT_DEFAULT_LOOKBACK_DAYS` (window for a
  contact's first-ever export, no checkpoint yet), `GBRAIN_EXPORT_INTERVAL_MS`.

**Rollback:** `GBRAIN_EXPORT_ENABLED=false` (or `GBRAIN_EXPORT_INTERVAL_MS=0`) stops the
schedule immediately, no deploy needed; the export path never writes to any table another
feature reads from (`gbrain_export_state` is private to this feature), so no downstream
cleanup is needed either way.

**Exit criteria — verified:** manually triggered `POST /api/gbrain-export/run` against a
seeded contact and confirmed the rendered markdown carries correct `company`/`team`/`role`
front-matter and the full message delta; confirmed `dryRun: true` renders without touching
the sink or the checkpoint; confirmed a second real run only re-sends messages after the
first run's checkpoint; confirmed an explicit `lookbackDays` overrides an existing
checkpoint for a manual backfill; confirmed a failed delivery leaves the checkpoint
untouched so the same window is retried; confirmed the 500-message cap advances the
checkpoint only to the newest included message. See `gbrain-export.service.spec.ts`,
`gbrain-export-render.spec.ts`, `gbrain-sink-cli.service.spec.ts`,
`gbrain-sink-webhook.service.spec.ts`, and `gbrain-export-scheduler.service.spec.ts`.

---

## Phase 3 — SLA Escalation on Flagged Messages

**Hard rule for this phase:** OpenWA never sends an outbound WhatsApp message as part of
escalation — it only _observes_ the inbound stream and fires an outbound webhook. No new
automated WhatsApp sends of any kind. The `automation-rules` autoreply feature already in
this repo is unaffected and untouched by this phase.

**Ships:** clients flag a message as important via a reaction/keyword OpenWA already
sees in the inbound message stream (per your answer — deterministic, no ML). An SLA
clock starts; if unanswered by the deadline, escalate by firing one outbound webhook.
**The final destination is intentionally left undecided** — email vs. Google Chat vs.
n8n vs. something else — the webhook payload is destination-agnostic and the URL is an
unset config value by default. Whichever tool ends up on the other end (n8n, a Google
Chat incoming webhook, a mail-sending service) owns "send email" / "post to Chat" /
"create task"; none of that is built here.

- New entity `SlaWatch`: `id, chatId, sessionId, flaggedMessageId, flaggedAt,
deadlineAt, resolvedAt (nullable), escalatedAt (nullable), ownerJid (from Phase 1
mapping)`.
- Inbound hook: a read-only listener on the existing message-received path (same shape
  as `automation-rules.service.ts`'s inbound evaluation, but it does not reply — it only
  detects the flag pattern and writes an `SlaWatch` row). This does not touch the
  send/reply path at all, so it can't introduce autoreply regressions.
  "Resolved" = a **human teammate** sends a reply in that chat before the deadline. This
  must exclude messages sent by `automation-rules` (bot autoreplies) — otherwise a client
  flags something important, the existing autoreply bot answers it automatically, the
  watch gets marked resolved, and the escalation that the whole feature exists for never
  fires. Outbound messages already carry enough provenance to distinguish the two
  (automation-rule sends go through a distinct code path from `MessageService`); the SLA
  resolver checks that provenance, not just "was there any outbound message."
- New queue processor (`QUEUE_NAMES.SLA_CHECK`, periodic sweep) that finds
  `SlaWatch` rows past `deadlineAt` with no `resolvedAt`, and fires one webhook event per
  breach through the existing `webhook` outbox (durable, retried, reconciled — no new
  delivery code). The webhook payload carries chat, client name + owner + backup owner
  (via Phase 1 mapping), flagged message, and elapsed time, tagged `reason: sla_breach`
  — generic enough for any receiving automation to route on.
- Config: SLA deadline duration and which "important" markers count, both configurable
  per session/team, default OFF until a destination is picked and configured.
- **Testable with zero external destination configured:** ship a `sla-escalation.e2e-spec.ts`
  that flags a test message, fast-forwards the deadline, and asserts against the
  `webhook` module's own outbox record (payload shape, `reason: sla_breach`, correct
  mapping fields) — the same way `webhook-outbox.service.spec.ts` already asserts
  delivery attempts without a live receiver. Additionally add a `dryRun` config mode
  that logs the fully-rendered payload instead of enqueuing a delivery, so you can flag a
  real test message in a real chat and see exactly what _would_ have been sent, before
  any URL, auth, or n8n/Chat/email wiring exists on the other end.

**Depends on:** Phase 1 (for `ownerJid`/client name in the escalation payload). Not
required for the core flag→deadline→escalate logic, which works even with an
unmapped chat (falls back to raw JID).

**Rollback:** disable the sweep job via config flag; `SlaWatch` rows stop being created/
checked but existing rows are harmless (never read by anything else).

**Exit criteria:** flag a test message, confirm a `SlaWatch` row appears, confirm a
**human** reply before deadline marks it resolved, confirm an **automation-rule
autoreply does NOT mark it resolved** and the watch still escalates on breach, confirm a
breach produces exactly one correctly-shaped outbox record (via the e2e spec, no live
destination needed), confirm `dryRun` mode logs the payload instead of delivering,
confirm zero WhatsApp messages are sent by this phase under any condition, confirm the
flag is idempotent (re-flagging the same message doesn't create duplicate watches).

---

## Phase 4 — Sentiment-Based Group Health Monitoring

**Ships:** per-group rolling sentiment tracking. When a group/client's overall sentiment
trend is falling, flag that group for senior-team attention through the same escalation
pipeline built in Phase 3 (same webhook→n8n target, different trigger reason).

- New entity `GroupSentimentSnapshot`: `id, chatId, windowStart, windowEnd, avgScore,
messageCount`. Computed periodically (queue job) over a rolling window (e.g. last 50
  messages or last 24h, whichever is smaller) using an existing sentiment
  library/hosted API — no custom model training.
- Trend detection: compare the last N snapshots; a sustained decline (configurable
  threshold, e.g. 3 consecutive falling snapshots) fires the same webhook escalation
  path from Phase 3, tagged `reason: sentiment_decline` instead of `reason: sla_breach`,
  so n8n/senior-team routing can branch on `reason`.
- This phase is opt-in per group/client (uses the `sentimentTracking` flag added to
  `ClientMapping` in Phase 1).
- **Dashboard visual:** the existing group/chat list (`dashboard/src/components/chats/ChatSidebar.tsx`,
  `dashboard/src/pages/Chats.tsx`) gets two additions per row, sourced from the latest
  `GroupSentimentSnapshot`: a numeric score out of 10 badge (always shown), and a color
  shift on the row/indicator (e.g. amber→red) specifically when the trend is declining —
  not a static color scale, so a group that's merely "low but stable" doesn't look as
  alarming as one that's actively getting worse. Read-only: a new `GET
/client-mapping/:id/sentiment` (or embedded in the existing chat list response) feeds
  it; no new websocket channel needed since the dashboard already polls/refetches chats.

**Depends on:** Phase 3 (reuses its escalation/webhook payload shape and delivery path).

**Rollback:** disable via config flag; sentiment snapshots stop being computed. No other
phase reads `GroupSentimentSnapshot`.

**Exit criteria:** synthetic test conversation with declining sentiment triggers exactly
one escalation event tagged `sentiment_decline`; a stable/improving conversation never
fires one; opting a client out via the mapping flag suppresses tracking entirely for
that group; the dashboard row shows the correct 0-10 score and only shifts color on an
actual declining trend, verified against a fixture with known snapshot sequences (rising,
flat, falling).

---

## Open items

**Resolved this round:**

- ~~G Brain's actual ingestion contract~~ — pulled from github.com/garrytan/gbrain (see
  Phase 2): CLI `capture` commands, a markdown `POST /ingest` webhook, and a first-class
  `entity` verb that Phase 1's mapping fields map onto directly. Remaining unknown: which
  transport (CLI vs. webhook) is actually reachable from wherever OpenWA is deployed —
  confirm before Phase 2 build starts, it decides which `GBrainSink` ships first.

**Still open:**

- Final Phase 3/4 escalation destination — email vs. Google Chat vs. n8n vs. other, left
  undecided by design. Phase 3 ships fully testable without this decision (dry-run mode +
  e2e spec against the webhook outbox); only the last step — pointing the config URL at a
  real destination and matching its exact payload expectations — waits on this call.
- Sentiment analysis: **hosted API vs. local library**, for Phase 4:

  |          | Hosted API (e.g. a cloud NLP/sentiment endpoint)                                      | Local library (e.g. an npm sentiment/VADER-style package)                                              |
  | -------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
  | Accuracy | Generally higher, handles nuance/sarcasm/multi-language better                        | Lower, especially on informal chat text and non-English messages                                       |
  | Latency  | Network round-trip per call — batch to control this                                   | In-process, near-instant                                                                               |
  | Cost     | Per-call pricing, scales with message volume across all groups                        | Free after install, no marginal cost                                                                   |
  | Privacy  | Client message content leaves the deployment boundary                                 | Client message content never leaves the OpenWA host — relevant since this text is client conversations |
  | Ops      | Another external dependency/API key to manage, another failure mode for the sweep job | One more npm dependency, fails the same way the rest of the app does                                   |

  Given client conversation content is the input, the privacy column is the one most
  worth weighing over raw accuracy; benchmark a local library against a sample of real
  (anonymized) group history before defaulting to a hosted API. Decide when Phase 4
  starts — Phase 4 is built against a small internal `SentimentScorer` interface either
  way, so this choice doesn't block Phase 1-3.

## Decision log

| #   | Decision                                                                                                                                                              | Rationale                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Client mapping stored in new DB table + admin UI, not a config file                                                                                                   | Editable without redeploys; queryable by Phase 3/4 for owner lookup                                                                                                                                                                            |
| 2   | G Brain sync is a scheduled export, not real-time webhook push                                                                                                        | Simpler, resilient to G Brain downtime; matches your stated preference                                                                                                                                                                         |
| 3   | Escalation notifications route through existing webhook fabric to n8n, not new SMTP/task-list code                                                                    | Reuse over build; no email/task infra exists in this repo today                                                                                                                                                                                |
| 4   | Sentiment-based group flagging is Phase 4, built after Phase 3's escalation pipeline exists                                                                           | Reuses the same delivery path; avoids building a second notification mechanism                                                                                                                                                                 |
| 5   | SLA "resolved" check excludes `automation-rules` bot autoreplies, human reply only                                                                                    | Found in eng review: an existing autoreply bot answering a flagged message would otherwise silently suppress the escalation the feature exists to guarantee                                                                                    |
| 6   | Phase 3 escalation destination left undecided (email vs. Google Chat vs. n8n); payload generic + `dryRun` mode + e2e spec against the webhook outbox ships regardless | Your explicit instruction — decide later; the phase must be verifiable without that decision blocking it                                                                                                                                       |
| 7   | Phase 3 never sends an outbound WhatsApp message under any condition                                                                                                  | Your explicit hard constraint — this phase only observes inbound messages and fires an external webhook                                                                                                                                        |
| 8   | `ClientMapping` gets `role`, `timezone`, `status`, `backupOwnerId`, `sentimentTracking`, `notes` beyond the requested name/phone/company/team                         | Recommended additions: timezone makes SLA deadlines meaningful across working hours, backupOwnerId gives escalation a second address, notes is what makes the G Brain export actually useful as "context for people" rather than a name lookup |
| 9   | Phase 2 export ships two default cadences (daily delta, weekly rollup) plus a config-driven `exportProfiles` list and a manual `lookbackDays` override                | Matches your requested daily-primary/weekly-secondary split while keeping the range adaptable without code changes                                                                                                                             |
| 10  | Phase 2 targets GBrain's real ingestion contract (CLI `capture` / webhook `/ingest` / `entity` verb) instead of a placeholder format                                  | Pulled from github.com/garrytan/gbrain per your request; removes the biggest unknown from the original draft                                                                                                                                   |
