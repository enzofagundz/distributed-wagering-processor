import { Migration } from "@mikro-orm/migrations";

export class Migration20261023000800 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table inbox_messages (
      consumer_name text not null check (length(consumer_name) between 1 and 200),
      message_id text not null check (length(message_id) between 1 and 200),
      payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
      received_at timestamptz not null default clock_timestamp() check (isfinite(received_at)),
      processed_at timestamptz check (isfinite(processed_at) and processed_at >= received_at),
      result jsonb,
      primary key (consumer_name, message_id),
      constraint inbox_result_shape check ((processed_at is null and result is null) or
        (processed_at is not null and result is not null and jsonb_typeof(result) = 'object'))
    )`);
  }

  override async down(): Promise<void> {
    this.addSql(`do $$ begin
      if exists (select 1 from inbox_messages) then
        raise exception 'Cannot remove inbox deduplication history';
      end if;
    end $$`);
    this.addSql("drop table inbox_messages");
  }
}
