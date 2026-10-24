import { DomainError } from "./money";
import type { IntegrationEvent } from "./opening-events";
import { uuidPattern } from "./wallet";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts?: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

interface NormalizedState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

const retryCapSeconds = 300;
const retryExponentCap = 9;

function backoffSeconds(attempts: number): number {
  return Math.min(retryCapSeconds, 2 ** Math.min(attempts, retryExponentCap));
}

function isUsableDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function normalize(state: OutboxMessageState): NormalizedState {
  const payload = state.payload;
  const attempts = state.attempts ?? 0;
  const nextAttemptAt = state.nextAttemptAt ?? null;
  const publishedAt = state.publishedAt ?? null;
  if (
    !uuidPattern.test(state.id) ||
    !uuidPattern.test(state.aggregateId) ||
    typeof state.eventType !== "string" ||
    state.eventType.length === 0 ||
    state.eventType.length > 200 ||
    state.eventType.trim() !== state.eventType ||
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    !isUsableDate(state.occurredAt) ||
    !Number.isInteger(attempts) ||
    attempts < 0 ||
    (nextAttemptAt !== null && !isUsableDate(nextAttemptAt)) ||
    (publishedAt !== null && !isUsableDate(publishedAt)) ||
    (publishedAt !== null && nextAttemptAt !== null)
  )
    throw new DomainError("INVALID_OUTBOX_MESSAGE");
  return {
    id: state.id,
    aggregateId: state.aggregateId,
    eventType: state.eventType,
    payload: Object.freeze({ ...payload }),
    occurredAt: new Date(state.occurredAt),
    attempts,
    nextAttemptAt: nextAttemptAt ? new Date(nextAttemptAt) : null,
    publishedAt: publishedAt ? new Date(publishedAt) : null,
  };
}

export class OutboxMessage {
  #state: Readonly<NormalizedState>;

  private constructor(state: OutboxMessageState) {
    this.#state = Object.freeze(normalize(state));
    Object.freeze(this);
  }

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    if (!isUsableDate(event.occurredAt))
      throw new DomainError("INVALID_OUTBOX_MESSAGE");
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get id(): string {
    return this.#state.id;
  }
  get aggregateId(): string {
    return this.#state.aggregateId;
  }
  get eventType(): string {
    return this.#state.eventType;
  }
  get payload(): Readonly<Record<string, unknown>> {
    return this.#state.payload;
  }
  get occurredAt(): Date {
    return new Date(this.#state.occurredAt);
  }
  get attempts(): number {
    return this.#state.attempts;
  }
  get nextAttemptAt(): Date | null {
    return this.#state.nextAttemptAt
      ? new Date(this.#state.nextAttemptAt)
      : null;
  }
  get publishedAt(): Date | null {
    return this.#state.publishedAt ? new Date(this.#state.publishedAt) : null;
  }

  isPending(): boolean {
    return this.#state.publishedAt === null;
  }

  isDue(now: Date): boolean {
    if (!isUsableDate(now)) throw new DomainError("INVALID_OUTBOX_STATE");
    const nextAttemptAt = this.#state.nextAttemptAt;
    return this.isPending() && (nextAttemptAt === null || nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this.#assertPending();
    if (!isUsableDate(at)) throw new DomainError("INVALID_OUTBOX_STATE");
    this.#state = Object.freeze({
      ...this.#state,
      publishedAt: new Date(at),
      nextAttemptAt: null,
    });
  }

  scheduleRetry(now: Date): void {
    this.#assertPending();
    if (!isUsableDate(now)) throw new DomainError("INVALID_OUTBOX_STATE");
    const attempts = this.#state.attempts + 1;
    this.#state = Object.freeze({
      ...this.#state,
      attempts,
      nextAttemptAt: new Date(now.getTime() + backoffSeconds(attempts) * 1000),
    });
  }

  #assertPending(): void {
    if (!this.isPending()) throw new DomainError("INVALID_OUTBOX_STATE");
  }
}
