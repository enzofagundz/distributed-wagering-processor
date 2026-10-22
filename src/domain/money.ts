export interface MoneyProps {
  amount: string;
  currency: string;
}

export class DomainError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

const currencies = new Set(Intl.supportedValuesOf('currency'));

export class Money {
  private constructor(private readonly cents: bigint, public readonly currency: string) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string' || !/^(0|[1-9]\d*)\.\d{2}$/.test(props.amount)) {
      throw new DomainError('INVALID_AMOUNT');
    }
    if (typeof props.currency !== 'string' || !currencies.has(props.currency)) {
      throw new DomainError('INVALID_CURRENCY');
    }
    return new Money(BigInt(props.amount.replace('.', '')), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean { return this.cents === 0n; }
  isPositive(): boolean { return this.cents > 0n; }
  isNegative(): boolean { return this.cents < 0n; }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    const digits = (this.cents < 0n ? -this.cents : this.cents).toString().padStart(3, '0');
    return `${this.cents < 0n ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new DomainError('CURRENCY_MISMATCH');
  }
}
