import { Migration } from '@mikro-orm/migrations';

export class Migration20261022000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table wallets (
      id uuid primary key,
      player_id uuid not null,
      currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
      balance numeric(30,2) not null default 0,
      version integer not null default 1 check (version >= 1),
      created_at timestamptz not null,
      updated_at timestamptz not null,
      constraint wallets_balance_nonnegative check (balance >= 0 and balance <> 'NaN'::numeric),
      constraint wallets_player_currency_unique unique (player_id, currency)
    )`);
  }

  override async down(): Promise<void> {
    this.addSql('drop table wallets');
  }
}
