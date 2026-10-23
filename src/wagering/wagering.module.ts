import { Module, type DynamicModule } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { PersistenceModule } from "../persistence/persistence.module";
import { WageringController } from "./wagering.controller";
import { WageringService } from "./wagering-service";
import { PendingReferenceWorker } from "./pending-reference-worker";

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: WageringService,
      useFactory: (orm: MikroORM) => new WageringService(orm),
      inject: [MikroORM],
    },
    {
      provide: PendingReferenceWorker,
      useFactory: (wagering: WageringService) =>
        new PendingReferenceWorker(wagering, {
          intervalMs: Number(process.env.PENDING_REFERENCE_INTERVAL_MS),
          pageSize: Number(process.env.PENDING_REFERENCE_PAGE_SIZE),
        }),
      inject: [WageringService],
    },
  ],
})
export class WageringModule {
  static register(orm?: MikroORM): DynamicModule {
    return {
      module: WageringModule,
      imports: [PersistenceModule.register(orm)],
    };
  }
}
