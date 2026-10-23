import { Migration } from "@mikro-orm/migrations";

export class Migration20261023000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      "alter table wager_transactions add column payload_hash varchar(64)",
    );
    this
      .addSql(`update wager_transactions set payload_hash = encode(sha256(convert_to(
      '{"externalTransactionId":' || to_json(external_transaction_id)::text ||
      ',"gameId":' || to_json(game_id)::text || ',"kind":"BET","money":{"amount":' || to_json(amount::text)::text ||
      ',"currency":' || to_json(currency)::text || '},"playerId":' || to_json(player_id::text)::text ||
      ',"providerId":' || to_json(provider_id)::text || ',"roundId":' || to_json(round_id)::text ||
      ',"walletId":' || to_json(wallet_id::text)::text || '}', 'UTF8')), 'hex') where kind = 'BET'`);
    this
      .addSql(`alter table wager_transactions add constraint wager_transactions_payload_hash_check check (
      (kind = 'OPENING' and payload_hash is null) or
      (kind = 'BET' and payload_hash is not null and payload_hash ~ '^[0-9a-f]{64}$'))`);
  }

  override async down(): Promise<void> {
    this.addSql(
      "alter table wager_transactions drop constraint wager_transactions_payload_hash_check, drop column payload_hash",
    );
  }
}
