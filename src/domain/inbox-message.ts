import { DomainError } from "./money";

export interface InboxMessageState {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  #state: Readonly<InboxMessageState>;

  private constructor(state: InboxMessageState) {
    this.#state = Object.freeze({
      ...state,
      receivedAt: new Date(state.receivedAt),
      ...(state.processedAt
        ? { processedAt: new Date(state.processedAt) }
        : {}),
    });
    Object.freeze(this);
  }

  static receive(props: Omit<InboxMessageState, "processedAt">): InboxMessage {
    if (
      [props.consumerName, props.messageId].some(
        (value) =>
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > 200 ||
          value.trim() !== value ||
          /[\u0000-\u001f\u007f-\u009f]/.test(value),
      ) ||
      typeof props.payloadHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(props.payloadHash) ||
      !(props.receivedAt instanceof Date) ||
      !Number.isFinite(props.receivedAt.getTime())
    )
      throw new DomainError("INVALID_MESSAGE_ENVELOPE");
    return new InboxMessage({
      consumerName: props.consumerName,
      messageId: props.messageId,
      payloadHash: props.payloadHash,
      receivedAt: props.receivedAt,
    });
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state);
  }
  get consumerName(): string {
    return this.#state.consumerName;
  }
  get messageId(): string {
    return this.#state.messageId;
  }
  get payloadHash(): string {
    return this.#state.payloadHash;
  }
  get receivedAt(): Date {
    return new Date(this.#state.receivedAt);
  }
  get processedAt(): Date | undefined {
    return this.#state.processedAt
      ? new Date(this.#state.processedAt)
      : undefined;
  }
  isProcessed(): boolean {
    return this.#state.processedAt !== undefined;
  }
  matchesPayload(hash: string): boolean {
    return this.#state.payloadHash === hash;
  }
  markProcessed(at: Date): void {
    if (
      this.isProcessed() ||
      !(at instanceof Date) ||
      !Number.isFinite(at.getTime()) ||
      at < this.#state.receivedAt
    )
      throw new DomainError("INVALID_INBOX_STATE");
    this.#state = Object.freeze({ ...this.#state, processedAt: new Date(at) });
  }
}
