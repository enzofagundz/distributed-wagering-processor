import { Migration } from "@mikro-orm/migrations";

export class Migration20261023000900 extends Migration {
  override async up(): Promise<void> {
    this.replaceChecks(true);
  }

  override async down(): Promise<void> {
    this.addSql(`do $$ begin
      lock table wager_transactions in access exclusive mode;
      if exists (select 1 from wager_transactions where status = 'FAILED') then
        raise exception 'Cannot remove FAILED schema while FAILED history exists' using errcode = '55000';
      end if;
    end $$`);
    this.replaceChecks(false);
  }

  private replaceChecks(includeFailed: boolean): void {
    const statuses = includeFailed
      ? "'PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED'"
      : "'PROCESSED', 'REJECTED', 'PENDING_REFERENCE'";
    const failedReference = includeFailed ? "status = 'FAILED' or " : "";
    const failedTerminal = includeFailed
      ? `or (kind in ('WIN', 'REFUND', 'ROLLBACK') and status = 'FAILED'
              and failure_code is not null and failure_code = 'PERMANENT_INFRASTRUCTURE_FAILURE'
              and processed_at is not null and isfinite(processed_at))`
      : "";
    this.addSql(`alter table wager_transactions
      drop constraint wager_transactions_status_check,
      drop constraint wager_transactions_reference_shape,
      drop constraint wager_transactions_terminal_shape,
      add constraint wager_transactions_status_check check (status in (${statuses})),
      add constraint wager_transactions_reference_shape check (
        (kind in ('OPENING', 'BET', 'LOSS') and reference_external_transaction_id is null and reference_transaction_id is null)
        or (kind = 'WIN' and reference_external_transaction_id is null and reference_transaction_id is null and status = 'PROCESSED')
        or (kind in ('WIN', 'REFUND', 'ROLLBACK')
          and reference_external_transaction_id is not null
          and length(reference_external_transaction_id) between 1 and 200
          and reference_external_transaction_id !~ '^[[:space:]]|[[:space:]]$'
          and reference_external_transaction_id !~ '[[:cntrl:]]'
          and (status = 'PENDING_REFERENCE' or ${failedReference}reference_transaction_id is not null
            or (status = 'REJECTED' and failure_code = 'REFERENCE_NOT_FOUND')))
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
              and failure_code in ('REFERENCE_MISMATCH', 'REFERENCE_NOT_PROCESSED', 'REFERENCE_NOT_FOUND')
              and processed_at is not null and isfinite(processed_at))
            or (kind = 'REFUND' and status = 'REJECTED' and failure_code is not null
              and failure_code in ('REFERENCE_MISMATCH', 'REFERENCE_NOT_PROCESSED', 'REFERENCE_ALREADY_REFUNDED', 'REFERENCE_NOT_FOUND')
              and processed_at is not null and isfinite(processed_at))
            or (kind = 'ROLLBACK' and status = 'REJECTED' and failure_code is not null
              and failure_code in ('REFERENCE_MISMATCH', 'REFERENCE_NOT_PROCESSED', 'REFERENCE_ALREADY_ROLLED_BACK', 'INSUFFICIENT_REVERSAL_FUNDS', 'REFERENCE_NOT_FOUND')
              and processed_at is not null and isfinite(processed_at))
            ${failedTerminal}
            or (kind in ('WIN', 'REFUND', 'ROLLBACK') and status = 'PENDING_REFERENCE' and failure_code is null and processed_at is null)
          ))
      )`);
  }
}
