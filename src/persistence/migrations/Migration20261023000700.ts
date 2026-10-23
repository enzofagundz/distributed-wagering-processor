import { Migration } from "@mikro-orm/migrations";

export class Migration20261023000700 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table outbox_messages
      add column attempts integer not null default 0 check (attempts >= 0),
      add column next_attempt_at timestamptz,
      add constraint outbox_retry_shape check (
        (next_attempt_at is null or isfinite(next_attempt_at)) and
        (published_at is null or next_attempt_at is null)
      )`);
    this.addSql(`create index outbox_messages_retry_due on outbox_messages
      (next_attempt_at, occurred_at, id) where published_at is null`);
  }

  override async down(): Promise<void> {
    this.addSql("drop index outbox_messages_retry_due");
    this.addSql(`alter table outbox_messages drop constraint outbox_retry_shape,
      drop column attempts, drop column next_attempt_at`);
  }
}
