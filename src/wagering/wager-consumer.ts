import { createHash } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { HttpException, Logger } from "@nestjs/common";
import { DomainError } from "../domain/money";
import { parseWagerMessage } from "./wager-message";
import type { WageringService } from "./wagering-service";

export class WagerConsumer {
  private readonly logger = new Logger(WagerConsumer.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly wagering: WageringService,
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly dlqUrl: string,
  ) {}

  async runOnce(): Promise<number> {
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: [
          "ApproximateReceiveCount",
          "MessageGroupId",
        ],
      }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
    for (const message of response.Messages ?? []) await this.process(message);
    return response.Messages?.length ?? 0;
  }

  private async process(message: Message): Promise<void> {
    const receiptHandle = message.ReceiptHandle;
    if (receiptHandle === undefined)
      throw new Error("Missing SQS receipt handle");
    let context: Awaited<ReturnType<typeof parseWagerMessage>> | undefined;
    const heartbeat = setInterval(() => {
      void this.sqs
        .send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: receiptHandle,
            VisibilityTimeout: 30,
          }),
          { abortSignal: AbortSignal.timeout(5000) },
        )
        .catch(() =>
          this.logger.warn(
            JSON.stringify({
              event: "WagerVisibilityExtensionFailed",
              messageId: context?.messageId ?? message.MessageId,
            }),
          ),
        );
    }, 10000);
    heartbeat.unref?.();
    try {
      context = await parseWagerMessage(message.Body);
      const result = await this.wagering.submit(context.data, {
        consumerName: "wager-transactions",
        messageId: context.messageId,
        payloadHash: context.payloadHash,
      });
      this.logger.log(
        JSON.stringify({
          event: "WagerMessageCommitted",
          correlationId: result.transactionId,
          messageId: context.messageId,
          transactionId: result.transactionId,
          walletId: context.data.walletId,
          providerId: context.data.providerId,
          status: result.status,
          idempotentReplay: result.idempotentReplay,
        }),
      );
    } catch (error) {
      const permanent =
        error instanceof HttpException ||
        (error instanceof DomainError &&
          error.code !== "TEMPORARY_UNAVAILABLE");
      const count = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
      const code =
        error instanceof DomainError
          ? error.code
          : error instanceof HttpException
            ? "INVALID_TRANSACTION_PAYLOAD"
            : "PROCESSING_FAILED";
      this.logger.warn(
        JSON.stringify({
          event: permanent ? "WagerMessageInvalid" : "WagerMessageRetry",
          messageId: context?.messageId ?? message.MessageId,
          walletId: context?.data.walletId,
          providerId: context?.data.providerId,
          code,
          attempt: count,
        }),
      );
      if (permanent || count >= 5) {
        await this.sqs.send(
          new SendMessageCommand({
            QueueUrl: this.dlqUrl,
            MessageBody: message.Body ?? "",
            MessageGroupId: message.Attributes?.MessageGroupId ?? "invalid",
            // Causa e origem viajam fora do corpo, que segue idêntico ao original.
            MessageAttributes: {
              failureCode: { DataType: "String", StringValue: code },
              failureKind: {
                DataType: "String",
                StringValue: permanent ? "PERMANENT" : "RETRIES_EXHAUSTED",
              },
              receiveCount: { DataType: "Number", StringValue: String(count) },
              sourceMessageId: {
                DataType: "String",
                StringValue: message.MessageId ?? "unknown",
              },
              ...(context && {
                wagerMessageId: {
                  DataType: "String",
                  StringValue: context.messageId,
                },
              }),
            },
            MessageDeduplicationId: createHash("sha256")
              .update(`${message.MessageId}:${message.Body}`)
              .digest("hex"),
          }),
          { abortSignal: AbortSignal.timeout(5000) },
        );
      } else {
        await this.sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: Math.min(2 ** count, 60),
          }),
          { abortSignal: AbortSignal.timeout(5000) },
        );
        return;
      }
    } finally {
      clearInterval(heartbeat);
    }
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
  async onModuleDestroy(): Promise<void> {
    await this.stop();
    this.sqs.destroy();
  }
  private schedule(): void {
    this.timer = setTimeout(() => {
      this.running = this.runOnce()
        .then(
          () => {},
          (error) =>
            this.logger.error(
              JSON.stringify({
                event: "WagerConsumerFailed",
                errorType: error instanceof Error ? error.name : "UnknownError",
              }),
            ),
        )
        .finally(() => {
          this.running = undefined;
          if (!this.stopped) this.schedule();
        });
    }, 100);
    this.timer.unref?.();
  }
}
