import { Logger } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";

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
          { id: string; payload: Record<string, unknown> }[]
        >(`select id, payload from outbox_messages where published_at is null
          order by occurred_at, id limit 1 for update skip locked`);
        if (!message) return false;
        await this.sqs.send(
          new SendMessageCommand({
            QueueUrl: this.queueUrl,
            MessageBody: JSON.stringify(message.payload),
          }),
          { abortSignal: AbortSignal.timeout(5000) },
        );
        await em.execute(
          "update outbox_messages set published_at = clock_timestamp() where id = ?",
          [message.id],
        );
        return true;
      });
      if (!sent) break;
      published++;
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
      this.logger.error(
        JSON.stringify({
          event: "OutboxPublicationFailed",
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    }
  }
}
