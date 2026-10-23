import { Module, type DynamicModule } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { PersistenceModule } from "../persistence/persistence.module";
import { WageringController } from "./wagering.controller";
import { WageringService } from "./wagering-service";

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: WageringService,
      useFactory: (orm: MikroORM) => new WageringService(orm),
      inject: [MikroORM],
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
