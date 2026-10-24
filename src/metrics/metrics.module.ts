import { MikroORM } from "@mikro-orm/postgresql";
import {
  Controller,
  type DynamicModule,
  Get,
  Header,
  Inject,
  Module,
} from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { type DatabaseGauges, Metrics } from "./metrics";

@Controller("metrics")
export class MetricsController {
  constructor(
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(MikroORM) private readonly orm: MikroORM,
  ) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async get() {
    // Estado persistido vem do banco: igual em qualquer instância e sobrevive a reinícios.
    const em = this.orm.em.fork();
    const transactionsByStatus = await em.execute<
      DatabaseGauges["transactionsByStatus"]
    >(
      `select s.status, count(t.id)::text as count
      from unnest(array['PROCESSED', 'REJECTED', 'PENDING_REFERENCE']) as s(status)
      left join wager_transactions t on t.status = s.status
      group by s.status order by s.status`,
    );
    const [outbox] = await em.execute<
      { pending: string; age: string }[]
    >(`select count(*)::text as pending,
        coalesce(extract(epoch from clock_timestamp() - min(occurred_at)), 0)::numeric(12, 3)::text as age
      from outbox_messages where published_at is null`);
    return this.metrics.render({
      transactionsByStatus,
      outboxPending: outbox?.pending ?? "0",
      outboxOldestAgeSeconds: outbox?.age ?? "0",
    });
  }
}

@Module({})
export class MetricsModule {
  static register(orm?: MikroORM): DynamicModule {
    return {
      module: MetricsModule,
      global: true,
      imports: [PersistenceModule.register(orm)],
      controllers: [MetricsController],
      providers: [Metrics],
      exports: [Metrics],
    };
  }
}
