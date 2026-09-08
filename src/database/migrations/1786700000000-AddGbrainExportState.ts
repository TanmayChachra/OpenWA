import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `gbrain_export_state` — the per-(session, jid) checkpoint table backing the GBrain
 * scheduled export (docs/32 Phase 2, `GbrainExportService`). See the entity's doc comment
 * (`gbrain-export-state.entity.ts`) for why this is a plain checkpoint row rather than the fuller
 * pending/dispatched/failed dispatch-state machine `ingress_events` uses.
 */
export class AddGbrainExportState1786700000000 implements MigrationInterface {
  name = 'AddGbrainExportState1786700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('gbrain_export_state')) return;
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    const ts = isPostgres ? 'timestamp' : 'datetime';
    const now = isPostgres ? 'NOW()' : "(datetime('now'))";

    await queryRunner.query(
      `CREATE TABLE "gbrain_export_state" (` +
        `"id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "jid" varchar NOT NULL, ` +
        `"lastExportedMessageTimestamp" bigint NOT NULL, "updatedAt" ${ts} NOT NULL DEFAULT ${now})`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_gbrain_export_state_session_jid" ON "gbrain_export_state" ("sessionId", "jid")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_gbrain_export_state_session_jid"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "gbrain_export_state"`);
  }
}
