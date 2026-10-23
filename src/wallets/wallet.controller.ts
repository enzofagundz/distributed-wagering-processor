import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { DomainError } from "../domain/money";
import { OpenWalletDto, openWalletValidation } from "./open-wallet.dto";
import { LedgerQueryDto, ledgerQueryValidation } from "./ledger-query.dto";
import { uuidPattern } from "../domain/wallet";
import { WalletService } from "./wallet-service";

@Controller("wallets")
export class WalletController {
  constructor(@Inject(WalletService) private readonly wallets: WalletService) {}

  @Post()
  async open(@Body(openWalletValidation) body: OpenWalletDto) {
    return this.wallets.open(body.playerId, body.initialBalance);
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string) {
    if (!uuidPattern.test(walletId)) throw new DomainError("INVALID_IDENTITY");
    return this.wallets.get(walletId);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconcile(@Param("walletId") walletId: string) {
    if (!uuidPattern.test(walletId)) throw new DomainError("INVALID_IDENTITY");
    return this.wallets.reconcile(walletId);
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query(ledgerQueryValidation) query: LedgerQueryDto,
  ) {
    if (!uuidPattern.test(walletId)) throw new DomainError("INVALID_IDENTITY");
    return this.wallets.ledger(walletId, {
      limit: Number(query.limit),
      cursor: query.cursor,
    });
  }
}

@Controller("metrics")
export class WalletMetricsController {
  constructor(@Inject(WalletService) private readonly wallets: WalletService) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  get() {
    return this.wallets.metrics();
  }
}
