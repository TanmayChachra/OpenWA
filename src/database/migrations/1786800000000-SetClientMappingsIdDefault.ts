import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `client_mappings.id` is `@PrimaryGeneratedColumn('uuid')`, so on PostgreSQL TypeORM omits it from
 * the INSERT and relies on a column DEFAULT — which 1786500000000 never set, so every insert failed
 * with 23502 (not-null violation). Every other uuid primary key carries `gen_random_uuid()::varchar`
 * (see 1770200000000). A follow-up rather than an edit to 1786500000000 so databases that already
 * ran it are repaired too. SQLite generates the id in the application, so it is a no-op there.
 */
export class SetClientMappingsIdDefault1786800000000 implements MigrationInterface {
  name = 'SetClientMappingsIdDefault1786800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;
    if (!(await queryRunner.hasTable('client_mappings'))) return;
    await queryRunner.query(`ALTER TABLE "client_mappings" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::varchar`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;
    if (!(await queryRunner.hasTable('client_mappings'))) return;
    await queryRunner.query(`ALTER TABLE "client_mappings" ALTER COLUMN "id" DROP DEFAULT`);
  }
}
