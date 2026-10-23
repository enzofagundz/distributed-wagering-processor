import { EntitySchema, StringType } from "@mikro-orm/core";

export interface WalletLedgerEntryRecord {
  id: string;
  walletId: string;
  transactionId: string;
  direction: "CREDIT" | "DEBIT";
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export const walletLedgerEntrySchema =
  new EntitySchema<WalletLedgerEntryRecord>({
    name: "WalletLedgerEntryRecord",
    tableName: "wallet_ledger_entries",
    properties: {
      id: { type: "uuid", primary: true },
      walletId: { type: "uuid" },
      transactionId: { type: "uuid" },
      direction: { type: "string", columnType: "text" },
      amount: { type: new StringType(), columnType: "numeric(30,2)" },
      currency: { type: "string", length: 3 },
      balanceBefore: { type: new StringType(), columnType: "numeric(30,2)" },
      balanceAfter: { type: new StringType(), columnType: "numeric(30,2)" },
      createdAt: { type: "Date", columnType: "timestamptz" },
    },
    indexes: [
      {
        name: "wallet_ledger_entries_wallet_order_index",
        properties: ["walletId", "createdAt", "id"],
      },
    ],
    uniques: [
      {
        name: "wallet_ledger_entries_transaction_wallet_unique",
        properties: ["transactionId", "walletId"],
      },
    ],
  });
