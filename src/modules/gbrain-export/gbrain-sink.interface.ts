/**
 * One rendered export document, ready to hand to GBrain verbatim (markdown front-matter + body —
 * see `gbrain-export-render.ts`). `entityId` is a stable identifier for the underlying contact/group
 * (`${sessionId}:${jid}`) so a re-export of the same jid updates the same GBrain entity rather than
 * minting a new one each run — GBrain's own entity concept keys on whatever identifier the front
 * matter carries, so this is carried in the front matter, not passed as a separate sink argument.
 */
export interface GBrainDocument {
  entityId: string;
  markdown: string;
}

export interface GBrainSinkResult {
  delivered: boolean;
  /** Present only when `delivered` is false — never thrown, so one failed doc never aborts a batch. */
  error?: string;
}

/**
 * The one interface both transports implement (docs/32 Phase 2), so switching between them is a
 * config change (`GBRAIN_EXPORT_SINK`), not a code change. Deliberately narrow: a sink only ever
 * sends one document and reports whether it landed — everything else (which jids to export, how
 * much history, checkpoint bookkeeping) is `GbrainExportService`'s job, not the sink's.
 */
export interface GBrainSink {
  readonly id: 'cli' | 'webhook';
  send(doc: GBrainDocument): Promise<GBrainSinkResult>;
}
