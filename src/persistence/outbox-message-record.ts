import { EntitySchema } from "@mikro-orm/core";
import { OutboxMessage } from "../domain/outbox-message";

export interface OutboxMessageRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts?: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

export interface OutboxMessageRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at_ms: number;
  attempts: number;
  next_attempt_at_ms: number | null;
  published_at_ms: number | null;
  now_ms: number;
}

// O driver devolve timestamptz como texto; a leitura pública usa epoch em ms
// para não depender do formato da conexão.
export const outboxMessageClaimSql = `select id, aggregate_id, event_type, payload,
    (extract(epoch from occurred_at) * 1000)::float8 as occurred_at_ms,
    attempts,
    (extract(epoch from next_attempt_at) * 1000)::float8 as next_attempt_at_ms,
    (extract(epoch from published_at) * 1000)::float8 as published_at_ms,
    (extract(epoch from clock_timestamp()) * 1000)::float8 as now_ms
  from outbox_messages
  where published_at is null
    and (next_attempt_at is null or next_attempt_at <= clock_timestamp())
  order by occurred_at, id
  limit 1
  for update skip locked`;

export const outboxMessageRetrySql =
  "update outbox_messages set attempts = ?, next_attempt_at = ? where id = ?";

export const outboxMessagePublishedSql =
  "update outbox_messages set published_at = ?, next_attempt_at = null where id = ?";

export function toOutboxRecord(message: OutboxMessage): OutboxMessageRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt,
    publishedAt: message.publishedAt,
  };
}

export function fromOutboxRow(row: OutboxMessageRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: new Date(row.occurred_at_ms),
    attempts: row.attempts,
    nextAttemptAt:
      row.next_attempt_at_ms === null ? null : new Date(row.next_attempt_at_ms),
    publishedAt:
      row.published_at_ms === null ? null : new Date(row.published_at_ms),
  });
}

export const outboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  name: "OutboxMessageRecord",
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "uuid" },
    eventType: { type: "string", columnType: "text" },
    payload: { type: "json", columnType: "jsonb" },
    occurredAt: { type: "Date", columnType: "timestamptz" },
    attempts: { type: "integer", default: 0 },
    nextAttemptAt: {
      type: "Date",
      columnType: "timestamptz",
      nullable: true,
      default: null,
    },
    publishedAt: {
      type: "Date",
      columnType: "timestamptz",
      nullable: true,
      default: null,
    },
  },
});
