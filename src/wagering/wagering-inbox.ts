import type { EntityManager } from "@mikro-orm/postgresql";
import { InboxMessage } from "../domain/inbox-message";
import { DomainError } from "../domain/money";
import type { SubmitTransactionResult } from "./wagering-service";

export interface InboxContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export class WageringInbox {
  async run(
    em: EntityManager,
    inbox: InboxContext | undefined,
    action: () => Promise<SubmitTransactionResult>,
  ): Promise<SubmitTransactionResult> {
    if (!inbox) return action();
    const received = InboxMessage.receive({ ...inbox, receivedAt: new Date() });
    const inserted = await em.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?) on conflict (consumer_name, message_id) do nothing returning message_id`,
      [
        received.consumerName,
        received.messageId,
        received.payloadHash,
        received.receivedAt,
      ],
    );
    if (inserted.length === 0) {
      const [existing] = await em.execute<
        {
          payload_hash: string;
          received_at: Date;
          processed_at: Date | null;
          result: SubmitTransactionResult | null;
        }[]
      >(
        "select payload_hash, received_at, processed_at, result from inbox_messages where consumer_name = ? and message_id = ?",
        [inbox.consumerName, inbox.messageId],
      );
      if (
        !existing ||
        existing.result === null ||
        existing.processed_at === null
      )
        throw new Error("Incomplete persisted inbox result");
      const persisted = InboxMessage.rehydrate({
        ...inbox,
        payloadHash: existing.payload_hash,
        receivedAt: existing.received_at,
        processedAt: existing.processed_at,
      });
      if (!persisted.matchesPayload(received.payloadHash))
        throw new DomainError("MESSAGE_ID_CONFLICT");
      return { ...existing.result, idempotentReplay: true };
    }
    const result = await action();
    received.markProcessed(new Date());
    await em.execute(
      `update inbox_messages set processed_at = ?, result = ?::jsonb
       where consumer_name = ? and message_id = ?`,
      [
        received.processedAt,
        JSON.stringify(result),
        received.consumerName,
        received.messageId,
      ],
    );
    return result;
  }
}
