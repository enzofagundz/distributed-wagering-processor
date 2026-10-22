import { HttpException, ValidationPipe } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsObject, IsString, Matches, MaxLength, ValidateNested, type ValidationError } from 'class-validator';
import { uuidPattern } from '../domain/wallet';

class BetMoneyDto {
  @IsDefined({ message: 'INVALID_TRANSACTION_PAYLOAD' })
  @IsString({ message: 'INVALID_AMOUNT' })
  @Matches(/^(0|[1-9]\d{0,27})\.\d{2}$/, { message: 'INVALID_AMOUNT' })
  amount!: string;

  @IsDefined({ message: 'INVALID_TRANSACTION_PAYLOAD' })
  @IsString({ message: 'INVALID_CURRENCY' })
  @IsIn(Intl.supportedValuesOf('currency'), { message: 'INVALID_CURRENCY' })
  currency!: string;
}

export class SubmitBetDto {
  @IsDefined({ message: 'INVALID_TRANSACTION_PAYLOAD' })
  @IsString({ message: 'INVALID_PROVIDER' })
  @Matches(/^\S(?:[\s\S]*\S)?$/, { message: 'INVALID_PROVIDER' })
  @MaxLength(200, { message: 'INVALID_PROVIDER' })
  providerId!: string;

  @IsDefined({ message: 'INVALID_TRANSACTION_PAYLOAD' })
  @IsString({ message: 'INVALID_IDENTITY' })
  @Matches(/^\S(?:[\s\S]*\S)?$/, { message: 'INVALID_IDENTITY' })
  @MaxLength(200, { message: 'INVALID_IDENTITY' })
  externalTransactionId!: string;

  @IsDefined({ message: 'INVALID_TRANSACTION_PAYLOAD' })
  @IsString({ message: 'INVALID_IDENTITY' })
  @Matches(uuidPattern, { message: 'INVALID_IDENTITY' })
  walletId!: string;

  @IsDefined({ message: 'INVALID_TRANSACTION_PAYLOAD' })
  @IsString({ message: 'INVALID_IDENTITY' })
  @Matches(uuidPattern, { message: 'INVALID_IDENTITY' })
  playerId!: string;

  @IsDefined({ message: 'INVALID_TRANSACTION_PAYLOAD' })
  @IsString({ message: 'INVALID_IDENTITY' })
  @Matches(/^\S(?:[\s\S]*\S)?$/, { message: 'INVALID_IDENTITY' })
  @MaxLength(200, { message: 'INVALID_IDENTITY' })
  roundId!: string;

  @IsDefined({ message: 'INVALID_TRANSACTION_PAYLOAD' })
  @IsString({ message: 'INVALID_IDENTITY' })
  @Matches(/^\S(?:[\s\S]*\S)?$/, { message: 'INVALID_IDENTITY' })
  @MaxLength(200, { message: 'INVALID_IDENTITY' })
  gameId!: string;

  @IsDefined({ message: 'INVALID_TRANSACTION_PAYLOAD' })
  @IsIn(['BET'], { message: 'INVALID_TRANSACTION_KIND' })
  kind!: 'BET';

  @IsDefined({ message: 'INVALID_TRANSACTION_PAYLOAD' })
  @IsObject({ message: 'INVALID_TRANSACTION_PAYLOAD' })
  @ValidateNested({ message: 'INVALID_TRANSACTION_PAYLOAD' })
  @Type(() => BetMoneyDto)
  money!: BetMoneyDto;
}

function validationCodes(errors: ValidationError[]): string[] {
  return errors.flatMap(error => [
    ...Object.entries(error.constraints ?? {}).map(([rule, message]) =>
      rule === 'whitelistValidation' || rule === 'unknownValue' || rule === 'isDefined' ? 'INVALID_TRANSACTION_PAYLOAD' : message),
    ...validationCodes(error.children ?? []),
  ]);
}

export const submitBetValidation = new ValidationPipe({
  expectedType: SubmitBetDto,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
  exceptionFactory: errors => {
    const codes = validationCodes(errors);
    const code = codes.includes('INVALID_TRANSACTION_PAYLOAD') ? 'INVALID_TRANSACTION_PAYLOAD' : codes[0] ?? 'INVALID_TRANSACTION_PAYLOAD';
    return new HttpException({ code }, 400);
  },
});
