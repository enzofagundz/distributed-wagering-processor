import { createHash } from "node:crypto";
import { DomainError } from "../domain/money";
import { submitTransactionValidation } from "./submit-transaction.dto";
import type { SubmitTransactionInput } from "./wagering-service";

export async function parseWagerMessage(body: string | undefined): Promise<{
  messageId: string;
  payloadHash: string;
  data: SubmitTransactionInput;
}> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body ?? "");
  } catch {
    throw new DomainError("INVALID_MESSAGE_ENVELOPE");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
    throw new DomainError("INVALID_MESSAGE_ENVELOPE");
  const value = envelope as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !["messageId", "type", "occurredAt", "data"].includes(key),
    ) ||
    typeof value.messageId !== "string" ||
    value.messageId.length === 0 ||
    value.messageId.length > 200 ||
    value.messageId.trim() !== value.messageId ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value.messageId) ||
    value.type !== "WagerTransactionRequested" ||
    typeof value.occurredAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.occurredAt) ||
    !Number.isFinite(Date.parse(value.occurredAt)) ||
    new Date(value.occurredAt).toISOString() !== value.occurredAt ||
    !value.data ||
    typeof value.data !== "object" ||
    Array.isArray(value.data)
  )
    throw new DomainError("INVALID_MESSAGE_ENVELOPE");
  const { idempotencyKey, ...bodyData } = value.data as Record<string, unknown>;
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.length === 0 ||
    idempotencyKey.length > 200 ||
    idempotencyKey.trim() !== idempotencyKey ||
    /[\u0000-\u001f\u007f-\u009f]/.test(idempotencyKey)
  )
    throw new DomainError("INVALID_IDEMPOTENCY_KEY");
  const data = (await submitTransactionValidation.transform(bodyData, {
    type: "body",
  })) as Omit<SubmitTransactionInput, "idempotencyKey">;
  return {
    messageId: value.messageId,
    payloadHash: createHash("sha256")
      .update(JSON.stringify(canonical(envelope)))
      .digest("hex"),
    data: { ...data, idempotencyKey },
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
