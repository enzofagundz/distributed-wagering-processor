import { HttpException, ValidationPipe } from '@nestjs/common';
import { IsOptional, Matches } from 'class-validator';

export class LedgerQueryDto {
  @Matches(/^(?:[1-9]|[1-9]\d|100)$/)
  limit = '50';

  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{48}$/)
  cursor?: string;
}

export const ledgerQueryValidation = new ValidationPipe({
  expectedType: LedgerQueryDto,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
  exceptionFactory: () => new HttpException({ code: 'INVALID_LEDGER_QUERY' }, 400),
});
