import { Migration } from "@mikro-orm/migrations";

export class Migration20261023000600 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table wager_transactions
      add column reference_attempts integer not null default 0,
      add column reference_next_attempt_at timestamptz`);
    this
      .addSql(`update wager_transactions set reference_next_attempt_at = created_at
      where status = 'PENDING_REFERENCE'`);
    this.replaceChecks(true);
    this
      .addSql(`alter table wager_transactions add constraint wager_transactions_reference_retry_shape check (
      reference_attempts between 0 and 10 and
      ((status = 'PENDING_REFERENCE' and reference_attempts < 10
        and reference_next_attempt_at is not null and isfinite(reference_next_attempt_at))
      or (status <> 'PENDING_REFERENCE' and reference_next_attempt_at is null))
    )`);
    this
      .addSql(`create index wager_transactions_reference_due on wager_transactions
      (reference_next_attempt_at, id) where status = 'PENDING_REFERENCE'`);
  }

  override async down(): Promise<void> {
    this.addSql(`do $$ begin
      lock table wager_transactions in access exclusive mode;
      if exists (select 1 from wager_transactions where failure_code = 'REFERENCE_NOT_FOUND') then
        raise exception 'Cannot remove expiration schema while expiration history exists' using errcode = '55000';
      end if;
    end $$`);
    this.addSql("drop index wager_transactions_reference_due");
    this.addSql(`alter table wager_transactions
      drop constraint wager_transactions_reference_retry_shape,
      drop column reference_attempts,
      drop column reference_next_attempt_at`);
    this.replaceChecks(false);
  }

  private replaceChecks(expiration: boolean): void {
    const missing = expiration ? ", 'REFERENCE_NOT_FOUND'" : "";
    this.addSql(`alter table wager_transactions
      drop constraint wager_transactions_reference_shape,
      drop constraint wager_transactions_terminal_shape,
      add constraint wager_transactions_reference_shape check (
        (kind in ('OPENING', 'BET', 'LOSS') and reference_external_transaction_id is null and reference_transaction_id is null)
        or (kind = 'WIN' and reference_external_transaction_id is null and reference_transaction_id is null and status = 'PROCESSED')
        or (kind in ('WIN', 'REFUND', 'ROLLBACK')
          and reference_external_transaction_id is not null
          and length(reference_external_transaction_id) between 1 and 200
          and reference_external_transaction_id !~ '^[[:space:]]|[[:space:]]$'
          and reference_external_transaction_id !~ '[[:cntrl:]]'
          and (status = 'PENDING_REFERENCE' or reference_transaction_id is not null
            ${expiration ? "or (status = 'REJECTED' and failure_code = 'REFERENCE_NOT_FOUND')" : ""}))
      ),
      add constraint wager_transactions_terminal_shape check (
        (kind = 'OPENING' and status = 'PROCESSED'
          and provider_id is null and external_transaction_id is null and idempotency_key is null
          and round_id is null and game_id is null and failure_code is null
          and processed_at is null and observed_balance is null)
        or
        (kind in ('BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')
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
              and failure_code in ('REFERENCE_MISMATCH', 'REFERENCE_NOT_PROCESSED'${missing})
              and processed_at is not null and isfinite(processed_at))
            or (kind = 'REFUND' and status = 'REJECTED' and failure_code is not null
              and failure_code in ('REFERENCE_MISMATCH', 'REFERENCE_NOT_PROCESSED', 'REFERENCE_ALREADY_REFUNDED'${missing})
              and processed_at is not null and isfinite(processed_at))
            or (kind = 'ROLLBACK' and status = 'REJECTED' and failure_code is not null
              and failure_code in ('REFERENCE_MISMATCH', 'REFERENCE_NOT_PROCESSED', 'REFERENCE_ALREADY_ROLLED_BACK', 'INSUFFICIENT_REVERSAL_FUNDS'${missing})
              and processed_at is not null and isfinite(processed_at))
            or (kind in ('WIN', 'REFUND', 'ROLLBACK') and status = 'PENDING_REFERENCE' and failure_code is null and processed_at is null)
          ))
      )`);
  }
}
