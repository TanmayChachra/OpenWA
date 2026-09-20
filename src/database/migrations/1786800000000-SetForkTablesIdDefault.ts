import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `client_mappings.id` and `gbrain_export_state.id` are `@PrimaryGeneratedColumn('uuid')`, so on
 * PostgreSQL TypeORM omits them from the INSERT and relies on a column DEFAULT, which their create
 * migrations never set: every insert failed with 23502 (not-null violation). Every other uuid primary
 * key carries `gen_random_uuid()::varchar` (see 1770200000000). A follow-up rather than an edit to the
 * create migrations so databases that already ran them are repaired too. SQLite generates the id in
 * the application, so it is a no-op there.
 */
const TABLES = ['client_mappings', 'gbrain_export_state'];

export class SetForkTablesIdDefault1786800000000 implements MigrationInterface {
  name = 'SetForkTablesIdDefault1786800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;
    for (const table of TABLES) {
      if (!(await queryRunner.hasTable(table))) continue;
      await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::varchar`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;
    for (const table of TABLES) {
      if (!(await queryRunner.hasTable(table))) continue;
      await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "id" DROP DEFAULT`);
    }
  }
}
