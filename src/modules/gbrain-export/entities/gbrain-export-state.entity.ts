import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { bigintToNumberTransformer } from '../../message/entities/message.entity';

/**
 * Per-(session, jid) checkpoint for the GBrain scheduled export (docs/32 Phase 2): the epoch-ms
 * timestamp of the newest message a successful export has already included, so the next run's
 * "delta since last export" query has a starting point instead of re-sending everything every time.
 *
 * One row per contact/group that has EVER been exported — created lazily on first successful export
 * for that jid, not backfilled for every existing `ClientMapping` row up front. Absence of a row
 * means "never exported"; the export service treats that as "export everything within the
 * requested lookback window" rather than a zero-message delta.
 *
 * Deliberately NOT the same shape as `IngressEvent`'s pending/dispatched/failed dispatch-state
 * machine (see `ingress-event.entity.ts`): a nightly batch export has no per-attempt retry queue or
 * dead-letter table to reuse that machinery for — a failed export for one jid simply leaves this
 * row's checkpoint un-advanced, so the NEXT scheduled run (or a manual `lookbackDays` backfill)
 * naturally re-includes the messages that were never confirmed delivered. That is the same
 * "checkpoint, don't advance until confirmed" idea the reconciler pattern is built on, just without
 * the extra bookkeeping a queue-backed delivery guarantee needs.
 */
@Entity('gbrain_export_state')
@Index('UQ_gbrain_export_state_session_jid', ['sessionId', 'jid'], { unique: true })
export class GbrainExportState {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  sessionId!: string;

  /** The contact/group jid this checkpoint tracks — matches `ClientMapping.jid` for the same row. */
  @Column({ type: 'varchar' })
  jid!: string;

  /** Epoch-ms of the newest message included in the last successful export for this jid. */
  @Column({ type: 'bigint', transformer: bigintToNumberTransformer })
  lastExportedMessageTimestamp!: number;

  @UpdateDateColumn()
  updatedAt!: Date;
}
