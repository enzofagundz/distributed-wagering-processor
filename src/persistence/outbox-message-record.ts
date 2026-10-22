import { EntitySchema } from '@mikro-orm/core';

export interface OutboxMessageRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  publishedAt?: Date | null;
}

export const outboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'string', columnType: 'text' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'Date', columnType: 'timestamptz' },
    publishedAt: { type: 'Date', columnType: 'timestamptz', nullable: true, default: null },
  },
});
