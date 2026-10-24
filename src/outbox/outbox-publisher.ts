import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { Logger } from "@nestjs/common";
import { Metrics } from "../metrics/metrics";
import {
  fromOutboxRow,
  type OutboxMessageRow,
  outboxMessageClaimSql,
  outboxMessagePublishedSql,
  outboxMessageRetrySql,
} from "../persistence/outbox-message-record";

type Envelope = {
  eventType?: string;
  correlationId?: string;
  data?: { transactionId?: string; walletId?: string };
};

export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly metrics = new Metrics(),
  ) {}

  async runOnce(): Promise<number> {
    let published = 0;
    for (let i = 0; i < 100; i++) {
      const sent = await this.orm.em.fork().transactional(async (em) => {
        const [row] = await em.execute<OutboxMessageRow[]>(
          outboxMessageClaimSql,
        );
        if (!row) return false;
        const message = fromOutboxRow(row);
        const envelope = message.payload as Envelope;
        try {
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: this.queueUrl,
              MessageBody: JSON.stringify(message.payload),
            }),
            { abortSignal: AbortSignal.timeout(5000) },
          );
        } catch (error) {
          message.scheduleRetry(new Date(row.now_ms));
          await em.execute(outboxMessageRetrySql, [
            message.attempts,
            message.nextAttemptAt,
            message.id,
          ]);
          this.logger.error({
            event: "OutboxPublicationFailed",
            eventId: message.id,
            eventType: message.eventType,
            correlationId: envelope.correlationId,
            transactionId: envelope.data?.transactionId,
            walletId: envelope.data?.walletId,
            errorType: error instanceof Error ? error.name : "UnknownError",
          });
          this.metrics.increment("outbox_publication_retries_total");
          return "retry";
        }
        message.markPublished(new Date(row.now_ms));
        await em.execute(outboxMessagePublishedSql, [
          message.publishedAt,
          message.id,
        ]);
        this.logger.log({
          event: "OutboxEventPublished",
          eventId: message.id,
          eventType: message.eventType,
          correlationId: envelope.correlationId,
          transactionId: envelope.data?.transactionId,
          walletId: envelope.data?.walletId,
        });
        return true;
      });
      if (!sent) break;
      if (sent === true) {
        published++;
        this.metrics.increment("outbox_published_total");
      }
    }
    return published;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
    this.sqs.destroy();
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.tick().finally(() => {
        this.running = undefined;
        if (!this.stopped) this.schedule();
      });
    }, 1000);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error({
        event: "OutboxPublicationFailed",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}
