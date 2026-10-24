import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import {
  Controller,
  Get,
  HttpCode,
  ServiceUnavailableException,
} from "@nestjs/common";

type Status = "up" | "down";

export class HealthChecks {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queueUrls: string[],
    private readonly timeoutMs: number,
  ) {}

  async check(): Promise<{ postgres: Status; sqs: Status }> {
    const [postgres, sqs] = await Promise.all([
      // A query abandonada pelo timeout segue no pool; o prazo só limita a resposta.
      this.probe(() => this.orm.em.getConnection().execute("select 1")),
      this.probe((signal) =>
        Promise.all(
          this.queueUrls.map((QueueUrl) =>
            this.sqs.send(
              new GetQueueAttributesCommand({
                QueueUrl,
                AttributeNames: ["QueueArn"],
              }),
              { abortSignal: signal },
            ),
          ),
        ),
      ),
    ]);
    return { postgres, sqs };
  }

  onModuleDestroy(): void {
    this.sqs.destroy();
  }

  private async probe(
    run: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<Status> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const timeout = new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason)),
    );
    try {
      await Promise.race([run(signal), timeout]);
      return "up";
    } catch {
      return "down";
    }
  }
}

@Controller("health")
export class HealthController {
  constructor(private readonly checks: HealthChecks) {}

  @Get("live")
  @HttpCode(200)
  live() {
    return { status: "live" };
  }

  @Get("ready")
  @HttpCode(200)
  async ready() {
    const checks = await this.checks.check();
    const ready = checks.postgres === "up" && checks.sqs === "up";
    if (!ready)
      throw new ServiceUnavailableException({ status: "not_ready", checks });
    return { status: "ready", checks };
  }
}
