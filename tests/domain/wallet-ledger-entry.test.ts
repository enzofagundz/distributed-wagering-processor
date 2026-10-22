import { expect, test } from 'bun:test';
import { DomainError, Money } from '../../src/domain/money';
import { WalletLedgerEntry, type WalletLedgerEntryState } from '../../src/domain/wallet-ledger-entry';

const id = '0192f291-27dd-7d3f-8071-5f8685deef37';
const walletId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const transactionId = '0192f291-27dd-7d3f-8071-5f8685deef38';
const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });
const state = (overrides: Partial<WalletLedgerEntryState> = {}): WalletLedgerEntryState => ({
  id, walletId, transactionId, direction: 'CREDIT', money: money('0.20'),
  balanceBefore: money('9007199254740993.10'), balanceAfter: money('9007199254740993.30'),
  createdAt: new Date('2026-10-22T12:00:00.000Z'), ...overrides,
});

test('creates exact credit beyond Number safe integer and exposes audit identity', () => {
  const props = state();
  const entry = WalletLedgerEntry.create(props);
  expect(entry.id).toBe(id);
  expect(entry.walletId).toBe(walletId);
  expect(entry.transactionId).toBe(transactionId);
  expect(entry.direction).toBe('CREDIT');
  expect(entry.money.toJSON()).toEqual({ amount: '0.20', currency: 'BRL' });
  expect(entry.balanceBefore.toString()).toBe('9007199254740993.10');
  expect(entry.balanceAfter.toString()).toBe('9007199254740993.30');
  expect(entry.createdAt).toEqual(props.createdAt);
  expect(entry.isBalanced()).toBe(true);
});

test('accepts opening credit from zero and debit down to zero', () => {
  const credit = WalletLedgerEntry.create(state({ balanceBefore: Money.zero('BRL'), balanceAfter: money('0.20') }));
  const debit = WalletLedgerEntry.create(state({ direction: 'DEBIT', balanceBefore: money('0.20'), balanceAfter: Money.zero('BRL') }));
  expect(credit.isBalanced()).toBe(true);
  expect(debit.direction).toBe('DEBIT');
  expect(debit.balanceAfter.toString()).toBe('0.00');
  expect(debit.isBalanced()).toBe(true);
});

for (const field of ['id', 'walletId', 'transactionId'] as const) {
  test(`rejects invalid ${field}`, () => {
    expect(() => WalletLedgerEntry.create(state({ [field]: 'not-a-uuid' })))
      .toThrow(new DomainError('INVALID_IDENTITY'));
  });
}

for (const direction of ['', 'credit', 'TRANSFER', null]) {
  test(`rejects invalid direction ${JSON.stringify(direction)}`, () => {
    expect(() => WalletLedgerEntry.create(state({ direction: direction as never })))
      .toThrow(new DomainError('INVALID_LEDGER_DIRECTION'));
  });
}

for (const amount of [Money.zero('BRL'), money('0.01').negate()]) {
  test(`rejects nonpositive ledger amount ${amount.toString()}`, () => {
    expect(() => WalletLedgerEntry.create(state({ money: amount })))
      .toThrow(new DomainError('LEDGER_AMOUNT_MUST_BE_POSITIVE'));
  });
}

for (const field of ['balanceBefore', 'balanceAfter'] as const) {
  test(`rejects negative ${field}`, () => {
    expect(() => WalletLedgerEntry.create(state({ [field]: money('0.01').negate() })))
      .toThrow(new DomainError('LEDGER_BALANCE_NEGATIVE'));
  });
}

for (const field of ['money', 'balanceBefore', 'balanceAfter'] as const) {
  test(`rejects mismatched ${field} currency`, () => {
    expect(() => WalletLedgerEntry.create(state({ [field]: money('0.20', 'USD') })))
      .toThrow(new DomainError('CURRENCY_MISMATCH'));
  });
}

for (const direction of ['CREDIT', 'DEBIT'] as const) {
  test(`rejects unbalanced ${direction}`, () => {
    expect(() => WalletLedgerEntry.create(state({ direction, balanceBefore: money('1.00'), balanceAfter: money('1.01') })))
      .toThrow(new DomainError('LEDGER_UNBALANCED'));
  });
}

test('rehydrates historical state without revalidating transition', () => {
  const entry = WalletLedgerEntry.rehydrate(state({ balanceAfter: money('1.00') }));
  expect(entry.id).toBe(id);
  expect(entry.balanceAfter.toString()).toBe('1.00');
  expect(entry.isBalanced()).toBe(false);
});

test('reports false for rehydrated currency mismatch or unknown direction', () => {
  expect(WalletLedgerEntry.rehydrate(state({ balanceAfter: money('0.20', 'USD') })).isBalanced()).toBe(false);
  expect(WalletLedgerEntry.rehydrate(state({ direction: 'UNKNOWN' as never })).isBalanced()).toBe(false);
});

for (const method of ['create', 'rehydrate'] as const) {
  test(`${method} protects source state, returned dates and runtime structure`, () => {
    const props = state();
    const timestamp = props.createdAt.getTime();
    const entry = WalletLedgerEntry[method](props);
    props.id = transactionId;
    props.direction = 'DEBIT';
    props.money = money('9.99');
    props.balanceBefore = Money.zero('BRL');
    props.balanceAfter = Money.zero('BRL');
    props.createdAt.setTime(0);
    entry.createdAt.setTime(0);
    expect(entry.id).toBe(id);
    expect(entry.direction).toBe('CREDIT');
    expect(entry.money.toString()).toBe('0.20');
    expect(entry.balanceBefore.toString()).toBe('9007199254740993.10');
    expect(entry.balanceAfter.toString()).toBe('9007199254740993.30');
    expect(entry.createdAt.getTime()).toBe(timestamp);
    expect(Object.isFrozen(entry)).toBe(true);
    for (const field of ['id', 'walletId', 'transactionId', 'direction', 'money', 'balanceBefore', 'balanceAfter', 'createdAt']) {
      expect(Reflect.set(entry, field, null)).toBe(false);
      expect(() => Object.defineProperty(entry, field, { value: null })).toThrow(TypeError);
    }
    for (const value of [entry.money, entry.balanceBefore, entry.balanceAfter]) {
      expect(Object.isFrozen(value)).toBe(true);
      expect(Reflect.set(value, 'currency', 'USD')).toBe(false);
    }
    expect(entry.isBalanced()).toBe(true);
  });
}
