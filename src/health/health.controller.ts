import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import {
  Controller,
  Get,
  HttpCode,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Public } from "../auth/auth.module";
import { MIGRATIONS_TABLE, migrationList } from "../persistence/config";

type Status = "up" | "down";

export class HealthChecks {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queueUrls: string[],
    private readonly timeoutMs: number,
  ) {}

  async check(): Promise<{
    postgres: Status;
    migrations: Status;
    sqs: Status;
  }> {
    const [postgres, migrations, sqs] = await Promise.all([
      // A query abandonada pelo timeout segue no pool; o prazo só limita a resposta.
      this.probe(() => this.orm.em.getConnection().execute("select 1")),
      this.probe(() => this.requireAppliedMigrations()),
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
    return { postgres, migrations, sqs };
  }

  onModuleDestroy(): void {
    this.sqs.destroy();
  }

  // Ler a tabela do migrator evita depender do Migrator, que criaria banco e tabela.
  private async requireAppliedMigrations(): Promise<void> {
    const rows = (await this.orm.em
      .getConnection()
      .execute(`select name from ${MIGRATIONS_TABLE}`)) as { name: string }[];
    const applied = new Set(rows.map((row) => row.name));
    if (migrationList.some((migration) => !applied.has(migration.name)))
      throw new Error("pending migrations");
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

@Public()
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
    const ready =
      checks.postgres === "up" &&
      checks.migrations === "up" &&
      checks.sqs === "up";
    if (!ready)
      throw new ServiceUnavailableException({ status: "not_ready", checks });
    return { status: "ready", checks };
  }
}
