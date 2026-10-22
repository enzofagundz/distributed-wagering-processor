import 'reflect-metadata';
import { Body, Controller, Get, Inject, Module, Param, Post, Query } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { DomainError } from './domain/money';
import { DomainErrorFilter } from './domain-error.filter';
import { OpenWalletDto, openWalletValidation } from './open-wallet.dto';
import { LedgerQueryDto, ledgerQueryValidation } from './ledger-query.dto';
import { uuidPattern } from './domain/wallet';
import { WalletService } from './wallet-service';
import { databaseConfig } from './persistence/config';

@Controller('wallets')
class WalletController {
  constructor(@Inject(WalletService) private readonly wallets: WalletService) {}

  @Post()
  async open(@Body(openWalletValidation) body: OpenWalletDto) {
    return this.wallets.open(body.playerId, body.initialBalance);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    if (!uuidPattern.test(walletId)) throw new DomainError('INVALID_IDENTITY');
    return this.wallets.get(walletId);
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query(ledgerQueryValidation) query: LedgerQueryDto) {
    if (!uuidPattern.test(walletId)) throw new DomainError('INVALID_IDENTITY');
    return this.wallets.ledger(walletId, { limit: Number(query.limit), cursor: query.cursor });
  }
}

@Module({
  controllers: [WalletController],
  providers: [
    { provide: MikroORM, useFactory: () => MikroORM.init(databaseConfig()) },
    { provide: WalletService, useFactory: (orm: MikroORM) => new WalletService(orm), inject: [MikroORM] },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
})
export class AppModule {}

export async function createApplication(orm: MikroORM) {
  return NestFactory.create({
    module: AppModule,
    providers: [{ provide: MikroORM, useValue: orm }],
  }, { logger: false });
}
