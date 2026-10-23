import { expect, test } from "bun:test";
import { InboxMessage } from "../../src/domain/inbox-message";

const receivedAt = new Date("2026-10-23T18:00:00.000Z");
const props = {
  consumerName: "wager-transactions",
  messageId: "msg-18",
  payloadHash: "a".repeat(64),
  receivedAt,
};

test("inbox validates its identity and hash before receiving, and processes only once", () => {
  for (const field of ["consumerName", "messageId"] as const) {
    for (const value of ["", " ", "bad\u0000", "a".repeat(201)])
      expect(() => InboxMessage.receive({ ...props, [field]: value })).toThrow(
        "INVALID_MESSAGE_ENVELOPE",
      );
  }
  expect(() => InboxMessage.receive({ ...props, payloadHash: "bad" })).toThrow(
    "INVALID_MESSAGE_ENVELOPE",
  );
  expect(() =>
    InboxMessage.receive({ ...props, receivedAt: new Date(NaN) }),
  ).toThrow("INVALID_MESSAGE_ENVELOPE");
  const inbox = InboxMessage.receive(props);
  expect(inbox.isProcessed()).toBe(false);
  expect(inbox.matchesPayload(props.payloadHash)).toBe(true);
  expect(inbox.matchesPayload("b".repeat(64))).toBe(false);
  expect(() =>
    inbox.markProcessed(new Date("2026-10-23T17:59:59.999Z")),
  ).toThrow("INVALID_INBOX_STATE");
  expect(() => inbox.markProcessed(new Date(NaN))).toThrow(
    "INVALID_INBOX_STATE",
  );
  const at = new Date("2026-10-23T18:00:01.000Z");
  inbox.markProcessed(at);
  at.setFullYear(2000);
  expect(inbox.processedAt?.toISOString()).toBe("2026-10-23T18:00:01.000Z");
  expect(inbox.isProcessed()).toBe(true);
  expect(() => inbox.markProcessed(new Date())).toThrow("INVALID_INBOX_STATE");
});

test("rehydration preserves inbox checkpoint without replaying receive or processing", () => {
  const processedAt = new Date("2026-10-23T18:00:01.000Z");
  const inbox = InboxMessage.rehydrate({ ...props, processedAt });
  processedAt.setFullYear(2000);
  expect(inbox.messageId).toBe("msg-18");
  expect(inbox.consumerName).toBe("wager-transactions");
  expect(inbox.processedAt?.toISOString()).toBe("2026-10-23T18:00:01.000Z");
  inbox.receivedAt.setFullYear(2000);
  expect(inbox.receivedAt.toISOString()).toBe("2026-10-23T18:00:00.000Z");
  expect(() => inbox.markProcessed(new Date())).toThrow("INVALID_INBOX_STATE");
});
