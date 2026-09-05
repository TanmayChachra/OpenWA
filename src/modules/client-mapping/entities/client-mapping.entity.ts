import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type ClientMappingKind = 'contact' | 'group' | 'teammate';
export type ClientMappingStatus = 'active' | 'inactive';

/**
 * Maps a WhatsApp contact/group JID, or an internal teammate identifier, onto the client/team
 * context that feeds the G Brain export (docs/32) and gives the SLA escalation pipeline an owner
 * to notify. `sessionId` is non-FK provenance, same reasoning as `ConversationMapping`: a mapping
 * should outlive a single WhatsApp session (reconnects, session id churn), and a `kind='teammate'`
 * row has no WhatsApp session at all, so it is nullable rather than a real foreign key.
 *
 * Uniqueness: (sessionId, jid, kind) is enforced at the DB for contact/group rows. It is NOT
 * enforced there for teammate rows, because both Postgres and SQLite treat every NULL sessionId as
 * distinct in a unique index — two teammate rows with the same jid and a NULL sessionId would not
 * collide. `ClientMappingService` enforces teammate-jid uniqueness itself before insert instead of
 * a DB constraint (a partial/filtered unique index would need dialect-specific syntax to stay in
 * lockstep with the migration-drift check); this is a low-frequency, admin-managed table, so the
 * service-level check's race window is an acceptable tradeoff, same shape as the automation rule
 * per-session cap ("bounds amplification, not an invariant").
 */
@Entity('client_mappings')
@Index('IDX_client_mappings_sessionId', ['sessionId'])
@Index('UQ_client_mappings_session_jid_kind', ['sessionId', 'jid', 'kind'], { unique: true })
export class ClientMapping {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', nullable: true })
  sessionId!: string | null;

  /** WhatsApp JID for contact/group kinds; an internal teammate identifier for `kind='teammate'`. */
  @Column({ type: 'varchar' })
  jid!: string;

  @Column({ type: 'varchar' })
  kind!: ClientMappingKind;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  /** Nullable: groups don't have a phone number. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  /** 'Unbundl' or a client company name — the field the G Brain export groups context by. */
  @Column({ type: 'varchar', length: 200 })
  company!: string;

  /** Department, e.g. 'Performance', 'Design'. Nullable: not every mapped row has one. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  team!: string | null;

  /** Job title/function within `team`, e.g. 'Account Manager'. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  role!: string | null;

  /** IANA time zone name. Lets the SLA escalation deadline account for working hours. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  timezone!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: ClientMappingStatus;

  /**
   * Secondary escalation owner: another `ClientMapping` row's id. Deliberately NOT a DB foreign
   * key — it references the same table, and self-referential FK + this table's own uniqueness
   * constraints add migration complexity this admin-managed field doesn't earn. Validated at the
   * service layer instead (must point at an existing row, and not at itself).
   */
  @Column({ type: 'varchar', nullable: true })
  backupOwnerId!: string | null;

  /** Group/client-kind opt-out for Phase 4 sentiment tracking. Ignored for other kinds. */
  @Column({ type: 'boolean', default: true })
  sentimentTracking!: boolean;

  /** Free-text context — this is what makes the G Brain export useful as "context for people". */
  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
