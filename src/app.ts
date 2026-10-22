import 'reflect-metadata';
import { Body, Controller, Get, Inject, Module, Param, Post } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { DomainError } from './domain/money';
import { DomainErrorFilter } from './domain-error.filter';
import { OpenWalletDto, openWalletValidation } from './open-wallet.dto';
import { uuidPattern } from './domain/wallet';
import { WalletService } from './wallet-service';

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
}

export async function createApplication(orm: MikroORM) {
  @Module({
    controllers: [WalletController],
    providers: [
      { provide: WalletService, useValue: new WalletService(orm) },
      { provide: APP_FILTER, useClass: DomainErrorFilter },
    ],
  })
  class AppModule {}
  return NestFactory.create(AppModule, { logger: false });
}
