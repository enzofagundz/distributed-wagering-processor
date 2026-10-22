import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { DomainError } from './domain/money';

const statusByCode: Readonly<Record<string, number>> = {
  INVALID_WALLET_PAYLOAD: 400,
  INVALID_IDENTITY: 400,
  INVALID_AMOUNT: 400,
  INVALID_CURRENCY: 400,
  INITIAL_BALANCE_NEGATIVE: 400,
  WALLET_NOT_FOUND: 404,
  WALLET_ALREADY_EXISTS: 409,
};

@Catch(DomainError)
export class DomainErrorFilter extends BaseExceptionFilter implements ExceptionFilter<DomainError> {
  override catch(error: DomainError, host: ArgumentsHost) {
    const status = statusByCode[error.code];
    super.catch(status === undefined ? error : new HttpException({ code: error.code }, status), host);
  }
}
