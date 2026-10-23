import "reflect-metadata";
import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import { DomainErrorFilter } from "./shared/domain-error.filter";
import { WalletsModule } from "./wallets/wallets.module";
import { WageringModule } from "./wagering/wagering.module";

@Module({
  providers: [{ provide: APP_FILTER, useClass: DomainErrorFilter }],
})
export class AppModule {
  static register(orm?: MikroORM): DynamicModule {
    return {
      module: AppModule,
      imports: [WalletsModule.register(orm), WageringModule.register(orm)],
    };
  }
}

@Module({ imports: [AppModule.register()] })
export class PreviewAppModule {}
