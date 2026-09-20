import { DataSource } from 'typeorm';
import { AddGbrainExportState1786700000000 } from '../1786700000000-AddGbrainExportState';

describe('AddGbrainExportState migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('creates and drops the table', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddGbrainExportState1786700000000();

    await migration.up(runner);
    expect(await runner.hasTable('gbrain_export_state')).toBe(true);

    await migration.down(runner);
    expect(await runner.hasTable('gbrain_export_state')).toBe(false);

    await runner.release();
  });

  it('up() is idempotent when the table already exists (hasTable guard)', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddGbrainExportState1786700000000();

    await migration.up(runner);
    await expect(migration.up(runner)).resolves.not.toThrow();
    expect(await runner.hasTable('gbrain_export_state')).toBe(true);

    await runner.release();
  });

  it('enforces one checkpoint row per (sessionId, jid)', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddGbrainExportState1786700000000();
    await migration.up(runner);

    await runner.query(
      `INSERT INTO "gbrain_export_state" ("id", "sessionId", "jid", "lastExportedMessageTimestamp") ` +
        `VALUES ('r1', 's1', '628@c.us', 1700000000000)`,
    );
    await expect(
      runner.query(
        `INSERT INTO "gbrain_export_state" ("id", "sessionId", "jid", "lastExportedMessageTimestamp") ` +
          `VALUES ('r2', 's1', '628@c.us', 1700000001000)`,
      ),
    ).rejects.toThrow();

    // Same jid, different session: unaffected.
    await expect(
      runner.query(
        `INSERT INTO "gbrain_export_state" ("id", "sessionId", "jid", "lastExportedMessageTimestamp") ` +
          `VALUES ('r3', 's2', '628@c.us', 1700000001000)`,
      ),
    ).resolves.toBeDefined();

    await runner.release();
  });
});
