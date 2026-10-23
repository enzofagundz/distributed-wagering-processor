import { Migration } from "@mikro-orm/migrations";

export class Migration20261022000200 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      "alter table wallets add constraint wallets_identity_unique unique (id, player_id, currency)",
    );
    this.addSql(
      "alter table wallets add constraint wallets_id_currency_unique unique (id, currency)",
    );
    this.addSql(`create table wager_transactions (
      id uuid primary key,
      wallet_id uuid not null,
      player_id uuid not null,
      currency varchar(3) not null,
      amount numeric(30,2) not null,
      kind text not null check (kind = 'OPENING'),
      status text not null check (status = 'PROCESSED'),
      created_at timestamptz not null,
      constraint wager_transactions_amount_positive_finite check (amount > 0 and amount < 'Infinity'::numeric),
      constraint wager_transactions_wallet_identity_fk foreign key (wallet_id, player_id, currency) references wallets (id, player_id, currency),
      constraint wager_transactions_opening_wallet_unique unique (wallet_id),
      constraint wager_transactions_ledger_identity_unique unique (id, wallet_id, currency, amount)
    )`);
    this.addSql(`create table wallet_ledger_entries (
      id uuid primary key,
      wallet_id uuid not null,
      transaction_id uuid not null,
      direction text not null check (direction in ('CREDIT', 'DEBIT')),
      amount numeric(30,2) not null,
      currency varchar(3) not null,
      balance_before numeric(30,2) not null,
      balance_after numeric(30,2) not null,
      created_at timestamptz not null,
      constraint wallet_ledger_entries_amount_positive_finite check (amount > 0 and amount < 'Infinity'::numeric),
      constraint wallet_ledger_entries_balances_nonnegative_finite check (balance_before >= 0 and balance_before < 'Infinity'::numeric and balance_after >= 0 and balance_after < 'Infinity'::numeric),
      constraint wallet_ledger_entries_balanced check (
        (direction = 'CREDIT' and balance_before + amount = balance_after)
        or (direction = 'DEBIT' and balance_before - amount = balance_after)
      ),
      constraint wallet_ledger_entries_wallet_currency_fk foreign key (wallet_id, currency) references wallets (id, currency),
      constraint wallet_ledger_entries_transaction_identity_fk foreign key (transaction_id, wallet_id, currency, amount) references wager_transactions (id, wallet_id, currency, amount),
      constraint wallet_ledger_entries_transaction_wallet_unique unique (transaction_id, wallet_id)
    )`);
    this.addSql(
      "create index wallet_ledger_entries_wallet_id_index on wallet_ledger_entries (wallet_id)",
    );
    this
      .addSql(`create function reject_wallet_ledger_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'Wallet ledger entries are immutable' using errcode = '55000';
      end;
    $$`);
    this.addSql(
      "create trigger wallet_ledger_entries_immutable before update or delete or truncate on wallet_ledger_entries for each statement execute function reject_wallet_ledger_mutation()",
    );
    this.addSql(`create table outbox_messages (
      id uuid primary key,
      aggregate_id uuid not null,
      event_type text not null,
      payload jsonb not null,
      occurred_at timestamptz not null,
      published_at timestamptz default null
    )`);
  }

  override async down(): Promise<void> {
    this.addSql("drop table outbox_messages");
    this.addSql(
      "drop trigger wallet_ledger_entries_immutable on wallet_ledger_entries",
    );
    this.addSql("drop function reject_wallet_ledger_mutation()");
    this.addSql("drop table wallet_ledger_entries");
    this.addSql("drop table wager_transactions");
    this.addSql(
      "alter table wallets drop constraint wallets_id_currency_unique",
    );
    this.addSql("alter table wallets drop constraint wallets_identity_unique");
  }
}
