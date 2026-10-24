import { MikroORM } from "@mikro-orm/postgresql";
import { type DynamicModule, Module } from "@nestjs/common";
import { Metrics } from "../metrics/metrics";
import { PersistenceModule } from "../persistence/persistence.module";
import { WalletController } from "./wallet.controller";
import { WalletService } from "./wallet-service";

@Module({
  controllers: [WalletController],
  providers: [
    {
      provide: WalletService,
      useFactory: (orm: MikroORM, metrics: Metrics) =>
        new WalletService(orm, metrics),
      inject: [MikroORM, Metrics],
    },
  ],
})
export class WalletsModule {
  static register(orm?: MikroORM): DynamicModule {
    return {
      module: WalletsModule,
      imports: [PersistenceModule.register(orm)],
    };
  }
}
