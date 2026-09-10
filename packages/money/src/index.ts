/**
 * Money handling with configurable currencies.
 * Amounts are ALWAYS stored as integer minor units + ISO-4217 code.
 * JMD is the operational default (no cents in circulation => 0 decimals);
 * USD is supported for dual-currency display/conversion.
 */

export interface CurrencyMeta {
  code: string;
  symbol: string;
  name: string;
  /** decimal places for the major unit (JMD has no circulating cents) */
  decimals: number;
}

export const CURRENCIES: Record<string, CurrencyMeta> = {
  JMD: { code: "JMD", symbol: "J$", name: "Jamaican dollar", decimals: 0 },
  USD: { code: "USD", symbol: "$", name: "US dollar", decimals: 2 },
  BBD: { code: "BBD", symbol: "Bds$", name: "Barbadian dollar", decimals: 2 },
  CAD: { code: "CAD", symbol: "C$", name: "Canadian dollar", decimals: 2 },
};

const FALLBACK: CurrencyMeta = { code: "XXX", symbol: "", name: "Unknown", decimals: 2 };

export function currencyMeta(code: string | null | undefined): CurrencyMeta {
  if (!code) return FALLBACK;
  return CURRENCIES[code.toUpperCase()] ?? { ...FALLBACK, code: code.toUpperCase() };
}

/** A monetary value. `amount` is integer minor units of `currency`. */
export interface Money {
  amount: number;
  currency: string;
}

export const money = (amount: number, currency: string): Money => ({
  amount: Math.round(amount),
  currency: currency.toUpperCase(),
});

export const zero = (currency: string): Money => money(0, currency);

/** major units (e.g. 1250 for J$1,250) */
export function majorOf(m: Money): number {
  const d = currencyMeta(m.currency).decimals;
  return m.amount / 10 ** d;
}

/** convert a major-unit input (e.g. 12.5) to rounded minor units */
export function minorOf(value: number, currency: string): number {
  const d = currencyMeta(currency).decimals;
  return Math.round(value * 10 ** d);
}

export interface FxRate {
  from: string;
  to: string;
  /** major units of `to` per 1 major unit of `from` */
  rate: number;
}

function ensureSameCurrency(a: Money, b: Money, fx?: FxRate): [Money, Money] {
  if (a.currency === b.currency) return [a, b];
  if (!fx) throw new Error(`Cannot combine ${a.currency} and ${b.currency} without an FX rate`);
  return [a, convert(b, a.currency, fx)];
}

export function convert(m: Money, to: string, fx: FxRate): Money {
  const fromCode = m.currency;
  const toCode = to.toUpperCase();
  if (fromCode === toCode) return m;
  const need = fx.from.toUpperCase() === fromCode ? fx : null;
  if (!need) throw new Error(`No FX rate available for ${fromCode} -> ${toCode}`);
  const fromDec = currencyMeta(fromCode).decimals;
  const toDec = currencyMeta(toCode).decimals;
  const major = m.amount / 10 ** fromDec;
  return money(Math.round(major * need.rate * 10 ** toDec), toCode);
}

export function add(a: Money, b: Money, fx?: FxRate): Money {
  const [x, y] = ensureSameCurrency(a, b, fx);
  return money(x.amount + y.amount, x.currency);
}

export function sub(a: Money, b: Money, fx?: FxRate): Money {
  const [x, y] = ensureSameCurrency(a, b, fx);
  return money(x.amount - y.amount, x.currency);
}

export function equals(a: Money, b: Money, fx?: FxRate): boolean {
  if (a.currency === b.currency) return a.amount === b.amount;
  if (!fx) return false;
  try {
    return convert(a, b.currency, fx).amount === b.amount;
  } catch {
    return false;
  }
}

export function isPositive(m: Money): boolean {
  return m.amount > 0;
}

const FORMATTERS: Record<string, Intl.NumberFormat | undefined> = {};

/** Format for display: J$ 1,250 / $ 12.50. With `to` + fx, renders in another currency. */
export function format(m: Money, fx?: FxRate & { to?: string }): string {
  const target = fx && fx.to ? convert(m, fx.to, fx) : m;
  const meta = currencyMeta(target.currency);
  const major = majorOf(target);
  const key = `${target.currency}:${meta.decimals}`;
  if (!FORMATTERS[key]) {
    FORMATTERS[key] = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: meta.decimals,
      maximumFractionDigits: meta.decimals,
    });
  }
  const num = FORMATTERS[key]!.format(major);
  return `${meta.symbol}${num}`.replace(/  +/g, " ");
}

/** Parse a display string ("1,250" / "$1,250.50") to minor units. */
export function parseDisplay(input: string, currency: string): number {
  const cleaned = input.replace(/[^0-9.-]/g, "");
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) throw new Error(`Invalid amount: "${input}"`);
  return minorOf(value, currency);
}

/** Sum many values (all same currency unless fx provided). */
export function sum(values: Money[], fx?: FxRate): Money {
  return values.reduce((acc, v) => add(acc, v, fx), zero(values[0]?.currency ?? "JMD"));
}
