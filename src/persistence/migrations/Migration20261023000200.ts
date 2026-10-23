import { Migration } from '@mikro-orm/migrations';

export class Migration20261023000200 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table wager_transactions
      drop constraint wager_transactions_kind_check,
      drop constraint wager_transactions_status_check,
      drop constraint wager_transactions_terminal_shape,
      drop constraint wager_transactions_payload_hash_check,
      add column reference_external_transaction_id varchar(200),
      add column reference_transaction_id uuid,
      add constraint wager_transactions_kind_check check (kind in ('OPENING', 'BET', 'WIN')),
      add constraint wager_transactions_status_check check (status in ('PROCESSED', 'REJECTED', 'PENDING_REFERENCE')),
      add constraint wager_transactions_reference_identity_unique unique (id, provider_id, external_transaction_id),
      add constraint wager_transactions_reference_fk foreign key (reference_transaction_id, provider_id, reference_external_transaction_id)
        references wager_transactions (id, provider_id, external_transaction_id),
      add constraint wager_transactions_reference_shape check (
        (kind in ('OPENING', 'BET') and reference_external_transaction_id is null and reference_transaction_id is null)
        or (kind = 'WIN' and (
          (reference_external_transaction_id is null and reference_transaction_id is null and status = 'PROCESSED')
          or (reference_external_transaction_id is not null
            and length(reference_external_transaction_id) between 1 and 200
            and reference_external_transaction_id !~ '^[[:space:]]|[[:space:]]$'
            and reference_external_transaction_id !~ '[[:cntrl:]]'
            and (status = 'PENDING_REFERENCE' or reference_transaction_id is not null))
        ))
      ),
      add constraint wager_transactions_payload_hash_check check (
        (kind = 'OPENING' and payload_hash is null) or
        (kind in ('BET', 'WIN') and payload_hash is not null and payload_hash ~ '^[0-9a-f]{64}$')),
      add constraint wager_transactions_terminal_shape check (
        (kind = 'OPENING' and status = 'PROCESSED'
          and provider_id is null and external_transaction_id is null and idempotency_key is null
          and round_id is null and game_id is null and failure_code is null
          and processed_at is null and observed_balance is null)
        or
        (kind in ('BET', 'WIN')
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
          and observed_balance is not null and observed_balance >= 0 and observed_balance < 'Infinity'::numeric
          and (
            (status = 'PROCESSED' and failure_code is null and processed_at is not null and isfinite(processed_at))
            or (kind = 'BET' and status = 'REJECTED' and failure_code is not distinct from 'INSUFFICIENT_FUNDS'
              and processed_at is not null and isfinite(processed_at))
            or (kind = 'WIN' and status = 'REJECTED' and failure_code is not null
              and failure_code in ('REFERENCE_MISMATCH', 'REFERENCE_NOT_PROCESSED')
              and processed_at is not null and isfinite(processed_at))
            or (kind = 'WIN' and status = 'PENDING_REFERENCE' and failure_code is null and processed_at is null)
          ))
      )`);
  }

  override async down(): Promise<void> {
    this.addSql(`do $$
      begin
        lock table wager_transactions in access exclusive mode;
        if exists (select 1 from wager_transactions where kind = 'WIN' or status = 'PENDING_REFERENCE'
          or reference_external_transaction_id is not null or reference_transaction_id is not null) then
          raise exception 'Cannot remove WIN schema while WIN or reference history exists' using errcode = '55000';
        end if;
        alter table wager_transactions
          drop constraint wager_transactions_reference_fk,
          drop constraint wager_transactions_reference_identity_unique,
          drop constraint wager_transactions_reference_shape,
          drop constraint wager_transactions_kind_check,
          drop constraint wager_transactions_status_check,
          drop constraint wager_transactions_terminal_shape,
          drop constraint wager_transactions_payload_hash_check,
          drop column reference_external_transaction_id,
          drop column reference_transaction_id,
          add constraint wager_transactions_kind_check check (kind in ('OPENING', 'BET')),
          add constraint wager_transactions_status_check check (status in ('PROCESSED', 'REJECTED')),
          add constraint wager_transactions_payload_hash_check check (
            (kind = 'OPENING' and payload_hash is null) or
            (kind = 'BET' and payload_hash is not null and payload_hash ~ '^[0-9a-f]{64}$')),
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
          );
      end;
    $$`);
  }
}
