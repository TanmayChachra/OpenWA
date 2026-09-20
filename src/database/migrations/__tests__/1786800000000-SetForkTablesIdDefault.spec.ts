import { DataSource } from 'typeorm';
import { SetForkTablesIdDefault1786800000000 } from '../1786800000000-SetForkTablesIdDefault';

describe('SetForkTablesIdDefault migration', () => {
  it('is a no-op on SQLite (the app generates the id there)', async () => {
    const ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
    const runner = ds.createQueryRunner();
    const spy = jest.spyOn(runner, 'query');
    const migration = new SetForkTablesIdDefault1786800000000();

    await migration.up(runner);
    await migration.down(runner);

    expect(spy).not.toHaveBeenCalled();
    await ds.destroy();
  });

  it('sets and drops the uuid default on both tables on PostgreSQL, skipping a missing table', async () => {
    const query = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
    const runner = {
      dataSource: { options: { type: 'postgres' } },
      hasTable: jest.fn((t: string) => Promise.resolve(t !== 'gbrain_export_state')),
      query,
    } as never;
    const migration = new SetForkTablesIdDefault1786800000000();

    await migration.up(runner);
    await migration.down(runner);

    expect(query.mock.calls.map(c => c[0])).toEqual([
      expect.stringContaining('"client_mappings" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::varchar'),
      expect.stringContaining('"client_mappings" ALTER COLUMN "id" DROP DEFAULT'),
    ]);
  });
});
