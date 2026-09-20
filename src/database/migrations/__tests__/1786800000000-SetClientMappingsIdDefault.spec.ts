import { DataSource } from 'typeorm';
import { SetClientMappingsIdDefault1786800000000 } from '../1786800000000-SetClientMappingsIdDefault';

describe('SetClientMappingsIdDefault migration', () => {
  it('is a no-op on SQLite (the app generates the id there)', async () => {
    const ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
    const runner = ds.createQueryRunner();
    const spy = jest.spyOn(runner, 'query');
    const migration = new SetClientMappingsIdDefault1786800000000();

    await migration.up(runner);
    await migration.down(runner);

    expect(spy).not.toHaveBeenCalled();
    await ds.destroy();
  });

  it('sets and drops the uuid default on PostgreSQL', async () => {
    const query = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
    const runner = {
      dataSource: { options: { type: 'postgres' } },
      hasTable: jest.fn().mockResolvedValue(true),
      query,
    } as never;
    const migration = new SetClientMappingsIdDefault1786800000000();

    await migration.up(runner);
    await migration.down(runner);

    expect(query.mock.calls[0][0]).toContain('SET DEFAULT gen_random_uuid()::varchar');
    expect(query.mock.calls[1][0]).toContain('DROP DEFAULT');
  });
});
