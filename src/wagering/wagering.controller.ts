import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { DomainError } from "../domain/money";
import { uuidPattern } from "../domain/wallet";
import {
  type SubmitTransactionDto,
  submitTransactionValidation,
} from "./submit-transaction.dto";
import { WageringQueries } from "./wagering-queries";
import { WageringService } from "./wagering-service";

@Controller()
export class WageringController {
  constructor(
    @Inject(WageringService) private readonly wagering: WageringService,
    @Inject(WageringQueries) private readonly queries: WageringQueries,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Body(submitTransactionValidation) body: SubmitTransactionDto,
    @Headers("idempotency-key") idempotencyKey: unknown,
  ) {
    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.length === 0 ||
      idempotencyKey.length > 200 ||
      idempotencyKey.trim() !== idempotencyKey
    )
      throw new DomainError("INVALID_IDEMPOTENCY_KEY");
    const result = await this.wagering.submit({ ...body, idempotencyKey });
    if (result.status === "REJECTED") throw new HttpException(result, 422);
    if (result.status === "PENDING_REFERENCE")
      throw new HttpException(result, 202);
    if (result.status === "FAILED") throw new HttpException(result, 500);
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  async get(@Param("transactionId") transactionId: string) {
    if (!uuidPattern.test(transactionId))
      throw new DomainError("INVALID_IDENTITY");
    return this.queries.get({ id: transactionId.toLowerCase() });
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getExternal(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    if (!isIdentity(providerId) || providerId.toLowerCase() === "internal")
      throw new DomainError("INVALID_PROVIDER");
    if (!isIdentity(externalTransactionId))
      throw new DomainError("INVALID_IDENTITY");
    return this.queries.get({ providerId, externalTransactionId });
  }
}

function isIdentity(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}
