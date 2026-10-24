import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { Logger } from "@nestjs/common";

export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async runOnce(): Promise<number> {
    let published = 0;
    for (let i = 0; i < 100; i++) {
      const sent = await this.orm.em.fork().transactional(async (em) => {
        const [message] = await em.execute<
          {
            id: string;
            payload: {
              eventType?: string;
              correlationId?: string;
              data?: { transactionId?: string; walletId?: string };
            };
          }[]
        >(`select id, payload from outbox_messages where published_at is null
          and (next_attempt_at is null or next_attempt_at <= clock_timestamp())
          order by occurred_at, id limit 1 for update skip locked`);
        if (!message) return false;
        try {
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: this.queueUrl,
              MessageBody: JSON.stringify(message.payload),
            }),
            { abortSignal: AbortSignal.timeout(5000) },
          );
        } catch (error) {
          await em.execute(
            `update outbox_messages
            set attempts = attempts + 1,
              next_attempt_at = clock_timestamp() +
                least(300, power(2, least(attempts + 1, 9))) * interval '1 second'
            where id = ?`,
            [message.id],
          );
          this.logger.error({
            event: "OutboxPublicationFailed",
            eventId: message.id,
            eventType: message.payload.eventType,
            correlationId: message.payload.correlationId,
            transactionId: message.payload.data?.transactionId,
            walletId: message.payload.data?.walletId,
            errorType: error instanceof Error ? error.name : "UnknownError",
          });
          return "retry";
        }
        await em.execute(
          "update outbox_messages set published_at = clock_timestamp(), next_attempt_at = null where id = ?",
          [message.id],
        );
        this.logger.log({
          event: "OutboxEventPublished",
          eventId: message.id,
          eventType: message.payload.eventType,
          correlationId: message.payload.correlationId,
          transactionId: message.payload.data?.transactionId,
          walletId: message.payload.data?.walletId,
        });
        return true;
      });
      if (!sent) break;
      if (sent === true) published++;
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
