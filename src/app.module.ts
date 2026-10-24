import "reflect-metadata";
import type { MikroORM } from "@mikro-orm/postgresql";
import { type DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { OutboxModule } from "./outbox/outbox.module";
import { DomainErrorFilter } from "./shared/domain-error.filter";
import { WageringModule } from "./wagering/wagering.module";
import { WalletsModule } from "./wallets/wallets.module";

@Module({
  providers: [{ provide: APP_FILTER, useClass: DomainErrorFilter }],
})
export class AppModule {
  static register(orm?: MikroORM): DynamicModule {
    return {
      module: AppModule,
      imports: [
        WalletsModule.register(orm),
        WageringModule.register(orm),
        OutboxModule.register(orm),
      ],
    };
  }
}

@Module({ imports: [AppModule.register()] })
export class PreviewAppModule {}
