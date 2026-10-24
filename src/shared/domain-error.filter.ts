import {
  type ArgumentsHost,
  BadRequestException,
  Catch,
  type ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import { DomainError } from "../domain/money";

const statusByCode: Readonly<Record<string, number>> = {
  INVALID_WALLET_PAYLOAD: 400,
  INVALID_IDENTITY: 400,
  INVALID_LEDGER_QUERY: 400,
  INVALID_AMOUNT: 400,
  INVALID_CURRENCY: 400,
  INITIAL_BALANCE_NEGATIVE: 400,
  WALLET_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  WALLET_ALREADY_EXISTS: 409,
  INVALID_TRANSACTION_PAYLOAD: 400,
  INVALID_TRANSACTION_KIND: 400,
  INVALID_IDEMPOTENCY_KEY: 400,
  INVALID_PROVIDER: 400,
  PLAYER_WALLET_MISMATCH: 400,
  CURRENCY_MISMATCH: 400,
  TRANSACTION_ALREADY_EXISTS: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INSUFFICIENT_FUNDS: 422,
  TEMPORARY_UNAVAILABLE: 503,
};

@Catch(DomainError, BadRequestException)
export class DomainErrorFilter
  extends BaseExceptionFilter
  implements ExceptionFilter<DomainError | BadRequestException>
{
  override catch(
    error: DomainError | BadRequestException,
    host: ArgumentsHost,
  ) {
    if (error instanceof BadRequestException) {
      const request = host
        .switchToHttp()
        .getRequest<{ method: string; url: string }>();
      const path = request.url.split("?")[0];
      const invalidTransaction =
        request.method === "POST" &&
        (path === "/wagering/transactions" ||
          path === "/wagering/transactions/");
      super.catch(
        invalidTransaction
          ? new HttpException({ code: "INVALID_TRANSACTION_PAYLOAD" }, 400)
          : error,
        host,
      );
      return;
    }
    const status = statusByCode[error.code];
    super.catch(
      status === undefined
        ? error
        : new HttpException({ code: error.code }, status),
      host,
    );
  }
}
