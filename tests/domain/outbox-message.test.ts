import { expect, test } from "bun:test";
import { DomainError } from "../../src/domain/money";
import { IntegrationEvent } from "../../src/domain/opening-events";
import {
  OutboxMessage,
  type OutboxMessageState,
} from "../../src/domain/outbox-message";

class SampleEvent extends IntegrationEvent<{ value: string }> {
  readonly eventType = "SampleEventHappened";
  constructor(
    aggregateId: string = crypto.randomUUID(),
    occurredAt: Date = new Date("2026-10-23T17:59:59.000Z"),
  ) {
    super(aggregateId, crypto.randomUUID(), occurredAt, { value: "sample" });
  }
}

const now = new Date("2026-10-23T18:00:00.000Z");
const seconds = (date: Date) => (date.getTime() - now.getTime()) / 1000;
const persisted = {
  id: crypto.randomUUID(),
  aggregateId: crypto.randomUUID(),
  eventType: "WagerTransactionProcessed",
  payload: { eventId: crypto.randomUUID(), version: 1 },
  occurredAt: new Date("2026-10-23T17:00:00.000Z"),
  attempts: 3,
  nextAttemptAt: new Date("2026-10-23T18:30:00.000Z"),
  publishedAt: null,
};

test("enqueue derives identity, envelope and pending state from the integration event", () => {
  const event = new SampleEvent();
  const message = OutboxMessage.enqueue(event);
  expect(message.id).toBe(event.eventId);
  expect(message.aggregateId).toBe(event.aggregateId);
  expect(message.eventType).toBe("SampleEventHappened");
  expect(message.payload).toEqual(event.toJSON());
  expect(message.occurredAt.toISOString()).toBe("2026-10-23T17:59:59.000Z");
  expect(message.attempts).toBe(0);
  expect(message.nextAttemptAt).toBeNull();
  expect(message.publishedAt).toBeNull();
  expect(message.isPending()).toBe(true);
  expect(message.isDue(now)).toBe(true);
  expect(() =>
    OutboxMessage.enqueue(new SampleEvent(undefined, new Date(NaN))),
  ).toThrow("INVALID_OUTBOX_MESSAGE");
  expect(() => {
    const payload = message.payload as Record<string, unknown>;
    payload.extra = true;
  }).toThrow();
  expect(() => OutboxMessage.enqueue(new SampleEvent("not-a-uuid"))).toThrow(
    "INVALID_OUTBOX_MESSAGE",
  );
});

test("rehydrate keeps persisted state without reapplying transitions", () => {
  const message = OutboxMessage.rehydrate(persisted);
  expect(message.id).toBe(persisted.id);
  expect(message.attempts).toBe(3);
  expect(message.nextAttemptAt?.toISOString()).toBe("2026-10-23T18:30:00.000Z");
  expect(message.publishedAt).toBeNull();
  expect(message.isPending()).toBe(true);
  expect(message.isDue(new Date("2026-10-23T18:29:59.999Z"))).toBe(false);
  expect(message.isDue(new Date("2026-10-23T18:30:00.000Z"))).toBe(true);
  const publishedAt = new Date("2026-10-23T19:00:00.000Z");
  const published = OutboxMessage.rehydrate({
    ...persisted,
    attempts: 9,
    nextAttemptAt: null,
    publishedAt,
  });
  expect(published.isPending()).toBe(false);
  expect(published.isDue(new Date("2027-01-01T00:00:00.000Z"))).toBe(false);
  expect(published.publishedAt?.toISOString()).toBe("2026-10-23T19:00:00.000Z");
  const occurredAt = published.occurredAt;
  occurredAt.setFullYear(2000);
  expect(published.occurredAt.toISOString()).toBe("2026-10-23T17:00:00.000Z");
});

test("rehydrate rejects shapes the table forbids", () => {
  const invalid: unknown[] = [
    { ...persisted, id: "bad" },
    { ...persisted, aggregateId: "bad" },
    { ...persisted, eventType: "" },
    { ...persisted, eventType: " outbox" },
    { ...persisted, payload: null },
    { ...persisted, payload: [] },
    { ...persisted, occurredAt: new Date(NaN) },
    { ...persisted, attempts: -1 },
    { ...persisted, attempts: 1.5 },
    { ...persisted, nextAttemptAt: new Date(NaN) },
    { ...persisted, publishedAt: new Date(NaN) },
    {
      ...persisted,
      publishedAt: new Date("2026-10-23T19:00:00.000Z"),
    },
  ];
  for (const state of invalid)
    expect(() => OutboxMessage.rehydrate(state as OutboxMessageState)).toThrow(
      "INVALID_OUTBOX_MESSAGE",
    );
});

test("retry backs off 2, 4, 8 until the five-minute cap and stays terminal after publication", () => {
  const message = OutboxMessage.enqueue(new SampleEvent());
  const delays: number[] = [];
  for (let attempt = 1; attempt <= 10; attempt++) {
    message.scheduleRetry(now);
    expect(message.attempts).toBe(attempt);
    expect(message.isPending()).toBe(true);
    const nextAttemptAt = message.nextAttemptAt!;
    expect(seconds(nextAttemptAt)).toBeLessThanOrEqual(300);
    expect(message.isDue(new Date(nextAttemptAt.getTime() - 1))).toBe(false);
    expect(message.isDue(nextAttemptAt)).toBe(true);
    delays.push(seconds(nextAttemptAt));
  }
  expect(delays).toEqual([2, 4, 8, 16, 32, 64, 128, 256, 300, 300]);
  expect(() => message.isDue(new Date(NaN))).toThrow("INVALID_OUTBOX_STATE");
  expect(() => message.scheduleRetry(new Date(NaN))).toThrow(
    "INVALID_OUTBOX_STATE",
  );
  message.markPublished(now);
  expect(message.publishedAt?.toISOString()).toBe(now.toISOString());
  expect(message.nextAttemptAt).toBeNull();
  expect(message.attempts).toBe(10);
  expect(message.isPending()).toBe(false);
  expect(message.isDue(new Date(now.getTime() + 300_000))).toBe(false);
  expect(() => message.markPublished(now)).toThrow("INVALID_OUTBOX_STATE");
  expect(() => message.scheduleRetry(now)).toThrow("INVALID_OUTBOX_STATE");
  expect(() => message.markPublished(new Date(NaN))).toThrow(
    "INVALID_OUTBOX_STATE",
  );
});

test("domain errors keep their code for the outbox message", () => {
  expect(() => OutboxMessage.rehydrate({ ...persisted, attempts: -1 })).toThrow(
    DomainError,
  );
  try {
    OutboxMessage.rehydrate({ ...persisted, attempts: -1 });
  } catch (error) {
    expect((error as DomainError).code).toBe("INVALID_OUTBOX_MESSAGE");
  }
});
