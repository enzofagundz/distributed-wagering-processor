import { Body, Controller, Headers, HttpException, Inject, Post } from '@nestjs/common';
import { DomainError } from '../domain/money';
import { SubmitBetDto, submitBetValidation } from './submit-bet.dto';
import { WageringService } from './wagering-service';

@Controller('wagering/transactions')
export class WageringController {
  constructor(@Inject(WageringService) private readonly wagering: WageringService) {}

  @Post()
  async submit(@Body(submitBetValidation) body: SubmitBetDto, @Headers('idempotency-key') idempotencyKey: unknown) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 200
      || idempotencyKey.trim() !== idempotencyKey) throw new DomainError('INVALID_IDEMPOTENCY_KEY');
    const result = await this.wagering.submit({ ...body, idempotencyKey });
    if (result.status === 'REJECTED') throw new HttpException(result, 422);
    return result;
  }
}
