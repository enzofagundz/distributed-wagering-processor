import { HttpException, ValidationPipe } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsObject, IsString, Matches, ValidateNested, type ValidationError } from 'class-validator';
import { uuidPattern } from '../domain/wallet';

class InitialBalanceDto {
  @IsDefined({ message: 'INVALID_AMOUNT' })
  @IsString({ message: 'INVALID_AMOUNT' })
  @Matches(/^(0|[1-9]\d*)\.\d{2}$/, { message: 'INVALID_AMOUNT' })
  amount!: string;

  @IsDefined({ message: 'INVALID_CURRENCY' })
  @IsString({ message: 'INVALID_CURRENCY' })
  @IsIn(Intl.supportedValuesOf('currency'), { message: 'INVALID_CURRENCY' })
  currency!: string;
}

export class OpenWalletDto {
  @IsDefined({ message: 'INVALID_WALLET_PAYLOAD' })
  @IsString({ message: 'INVALID_WALLET_PAYLOAD' })
  @Matches(uuidPattern, { message: 'INVALID_IDENTITY' })
  playerId!: string;

  @IsDefined({ message: 'INVALID_WALLET_PAYLOAD' })
  @IsObject({ message: 'INVALID_WALLET_PAYLOAD' })
  @ValidateNested({ message: 'INVALID_WALLET_PAYLOAD' })
  @Type(() => InitialBalanceDto)
  initialBalance!: InitialBalanceDto;
}

function validationCodes(errors: ValidationError[]): string[] {
  return errors.flatMap(error => [
    ...Object.entries(error.constraints ?? {}).map(([rule, message]) =>
      rule === 'whitelistValidation' || (rule === 'isDefined' && error.value === undefined) ? 'INVALID_WALLET_PAYLOAD' : message),
    ...validationCodes(error.children ?? []),
  ]);
}

export const openWalletValidation = new ValidationPipe({
  expectedType: OpenWalletDto,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
  exceptionFactory: errors => {
    const codes = validationCodes(errors);
    const code = codes.includes('INVALID_WALLET_PAYLOAD') ? 'INVALID_WALLET_PAYLOAD' : codes[0] ?? 'INVALID_WALLET_PAYLOAD';
    return new HttpException({ code }, 400);
  },
});
