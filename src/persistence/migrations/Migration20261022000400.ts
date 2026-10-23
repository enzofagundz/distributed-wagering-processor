import { Migration } from "@mikro-orm/migrations";

export class Migration20261022000400 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table wager_transactions
      drop constraint wager_transactions_kind_check,
      drop constraint wager_transactions_status_check,
      drop constraint wager_transactions_opening_wallet_unique,
      add column provider_id varchar(200),
      add column external_transaction_id varchar(200),
      add column idempotency_key varchar(200),
      add column round_id varchar(200),
      add column game_id varchar(200),
      add column failure_code text,
      add column processed_at timestamptz,
      add column observed_balance numeric(30,2),
      add constraint wager_transactions_kind_check check (kind in ('OPENING', 'BET')),
      add constraint wager_transactions_status_check check (status in ('PROCESSED', 'REJECTED')),
      add constraint wager_transactions_provider_external_unique unique (provider_id, external_transaction_id),
      add constraint wager_transactions_idempotency_key_unique unique (idempotency_key),
      add constraint wager_transactions_terminal_shape check (
        (kind = 'OPENING' and status = 'PROCESSED'
          and provider_id is null and external_transaction_id is null and idempotency_key is null
          and round_id is null and game_id is null and failure_code is null
          and processed_at is null and observed_balance is null)
        or
        (kind = 'BET'
          and provider_id is not null and length(provider_id) between 1 and 200
          and provider_id !~ '^[[:space:]]|[[:space:]]$' and lower(provider_id) <> 'internal'
          and external_transaction_id is not null and length(external_transaction_id) between 1 and 200
          and external_transaction_id !~ '^[[:space:]]|[[:space:]]$'
          and idempotency_key is not null and length(idempotency_key) between 1 and 200
          and idempotency_key !~ '^[[:space:]]|[[:space:]]$'
          and round_id is not null and length(round_id) between 1 and 200
          and round_id !~ '^[[:space:]]|[[:space:]]$'
          and game_id is not null and length(game_id) between 1 and 200
          and game_id !~ '^[[:space:]]|[[:space:]]$'
          and processed_at is not null and isfinite(processed_at)
          and observed_balance is not null and observed_balance >= 0 and observed_balance < 'Infinity'::numeric
          and ((status = 'PROCESSED' and failure_code is null)
            or (status = 'REJECTED' and failure_code is not distinct from 'INSUFFICIENT_FUNDS')))
      )`);
    this.addSql(
      "create unique index wager_transactions_opening_wallet_unique on wager_transactions (wallet_id) where kind = 'OPENING'",
    );
  }

  override async down(): Promise<void> {
    this.addSql(`do $$
      begin
        lock table wager_transactions in access exclusive mode;
        if exists (select 1 from wager_transactions where kind = 'BET') then
          raise exception 'Cannot remove BET schema while BET history exists' using errcode = '55000';
        end if;
        drop index wager_transactions_opening_wallet_unique;
        alter table wager_transactions
          drop constraint wager_transactions_terminal_shape,
          drop constraint wager_transactions_provider_external_unique,
          drop constraint wager_transactions_idempotency_key_unique,
          drop constraint wager_transactions_kind_check,
          drop constraint wager_transactions_status_check,
          drop column provider_id,
          drop column external_transaction_id,
          drop column idempotency_key,
          drop column round_id,
          drop column game_id,
          drop column failure_code,
          drop column processed_at,
          drop column observed_balance,
          add constraint wager_transactions_kind_check check (kind = 'OPENING'),
          add constraint wager_transactions_status_check check (status = 'PROCESSED'),
          add constraint wager_transactions_opening_wallet_unique unique (wallet_id);
      end;
    $$`);
  }
}
