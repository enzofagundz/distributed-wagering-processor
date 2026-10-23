import { Migration } from "@mikro-orm/migrations";

export class Migration20261022000300 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      "create index wallet_ledger_entries_wallet_order_index on wallet_ledger_entries (wallet_id, created_at, id)",
    );
    this.addSql("drop index wallet_ledger_entries_wallet_id_index");
  }

  override async down(): Promise<void> {
    this.addSql(
      "create index wallet_ledger_entries_wallet_id_index on wallet_ledger_entries (wallet_id)",
    );
    this.addSql("drop index wallet_ledger_entries_wallet_order_index");
  }
}
