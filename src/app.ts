import 'reflect-metadata';
import { Body, Controller, Get, HttpException, Inject, Module, Param, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { DomainError, type MoneyProps } from './domain/money';
import { uuidPattern } from './domain/wallet';
import { WalletService } from './wallet-service';

function objectWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

async function httpResult(operation: () => Promise<unknown>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DomainError) {
      const status = error.code === 'WALLET_ALREADY_EXISTS' ? 409 : error.code === 'WALLET_NOT_FOUND' ? 404 : 400;
      throw new HttpException({ code: error.code }, status);
    }
    throw error;
  }
}

@Controller('wallets')
class WalletController {
  constructor(@Inject(WalletService) private readonly wallets: WalletService) {}

  @Post()
  async open(@Body() body: unknown) {
    if (!objectWithKeys(body, ['playerId', 'initialBalance']) || typeof body.playerId !== 'string'
      || !objectWithKeys(body.initialBalance, ['amount', 'currency'])) {
      throw new HttpException({ code: 'INVALID_WALLET_PAYLOAD' }, 400);
    }
    return httpResult(() => this.wallets.open(body.playerId as string, body.initialBalance as unknown as MoneyProps));
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    if (!uuidPattern.test(walletId)) throw new HttpException({ code: 'INVALID_IDENTITY' }, 400);
    return httpResult(() => this.wallets.get(walletId));
  }
}

export async function createApplication(orm: MikroORM) {
  @Module({ controllers: [WalletController], providers: [{ provide: WalletService, useValue: new WalletService(orm) }] })
  class AppModule {}
  return NestFactory.create(AppModule, { logger: false });
}
