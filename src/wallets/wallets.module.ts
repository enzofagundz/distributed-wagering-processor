import { Module, type DynamicModule } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { PersistenceModule } from '../persistence/persistence.module';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet-service';

@Module({
  controllers: [WalletController],
  providers: [
    { provide: WalletService, useFactory: (orm: MikroORM) => new WalletService(orm), inject: [MikroORM] },
  ],
})
export class WalletsModule {
  static register(orm?: MikroORM): DynamicModule {
    return { module: WalletsModule, imports: [PersistenceModule.register(orm)] };
  }
}
