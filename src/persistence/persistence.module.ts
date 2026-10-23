import { Module, type DynamicModule } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { databaseConfig } from "./config";

@Module({})
export class PersistenceModule {
  static register(orm?: MikroORM): DynamicModule {
    return {
      module: PersistenceModule,
      providers: [
        orm
          ? { provide: MikroORM, useValue: orm }
          : {
              provide: MikroORM,
              useFactory: () => MikroORM.init(databaseConfig()),
            },
      ],
      exports: [MikroORM],
    };
  }
}
