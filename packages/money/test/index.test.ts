import { describe, expect, it } from "vitest";
import {
  add,
  convert,
  currencyMeta,
  format,
  majorOf,
  minorOf,
  money,
  parseDisplay,
  sub,
  sum,
} from "../src/index.js";

describe("money", () => {
  it("treats JMD as zero-decimal", () => {
    expect(currencyMeta("JMD").decimals).toBe(0);
    const m = money(1250, "JMD");
    expect(majorOf(m)).toBe(1250);
    expect(format(m)).toBe("J$1,250");
  });

  it("treats USD as two-decimal", () => {
    const m = money(1250, "USD");
    expect(majorOf(m)).toBeCloseTo(12.5);
    expect(format(m)).toBe("$12.50");
  });

  it("adds same-currency values", () => {
    expect(add(money(100, "JMD"), money(250, "JMD")).amount).toBe(350);
  });

  it("refuses to mix currencies without fx", () => {
    expect(() => add(money(100, "JMD"), money(100, "USD"))).toThrow();
  });

  it("converts with an explicit rate", () => {
    const fx = { from: "USD", to: "JMD", rate: 155 };
    // money(1000, "USD") is $10.00 (minor units)
    const converted = convert(money(1000, "USD"), "JMD", fx);
    expect(converted.currency).toBe("JMD");
    expect(converted.amount).toBe(1550);
    const total = add(money(15000, "JMD"), money(1000, "USD"), fx);
    expect(total.amount).toBe(16550);
    expect(sub(total, money(15500, "JMD"), fx).amount).toBe(1050);
  });

  it("formats dual currency with to+fx", () => {
    const fx = { from: "USD", to: "JMD", rate: 155, to: "JMD" };
    expect(format(money(1000, "USD"), fx)).toBe("J$1,550");
  });

  it("round-trips display parsing", () => {
    expect(parseDisplay("1,250", "JMD")).toBe(1250);
    expect(parseDisplay("$12.50", "USD")).toBe(1250);
    expect(parseDisplay("J$ 1,250", "JMD")).toBe(1250);
    expect(minorOf(12.5, "USD")).toBe(1250);
  });

  it("sums and handles empty lists", () => {
    expect(sum([]).amount).toBe(0);
    expect(sum([money(1, "JMD"), money(2, "JMD"), money(3, "JMD")]).amount).toBe(6);
  });
});
