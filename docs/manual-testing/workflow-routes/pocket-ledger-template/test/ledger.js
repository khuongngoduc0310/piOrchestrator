import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateBalance, findTransactionById } from "../src/ledger.js";

describe("calculateBalance", () => {
  it("returns 0 for an empty ledger", () => {
    assert.strictEqual(calculateBalance([]), 0);
  });

  it("sums credit transactions", () => {
    const txns = [
      { id: "1", type: "credit", amount: 100 },
      { id: "2", type: "credit", amount: 50 },
    ];
    assert.strictEqual(calculateBalance(txns), 150);
  });

  it("subtracts debit transactions", () => {
    const txns = [
      { id: "1", type: "debit", amount: 30 },
      { id: "2", type: "debit", amount: 20 },
    ];
    assert.strictEqual(calculateBalance(txns), -50);
  });

  it("calculates mix of credits and debits", () => {
    const txns = [
      { id: "1", type: "credit", amount: 100 },
      { id: "2", type: "debit", amount: 30 },
      { id: "3", type: "credit", amount: 20 },
    ];
    assert.strictEqual(calculateBalance(txns), 90);
  });

  it("handles decimal amounts", () => {
    const txns = [
      { id: "1", type: "credit", amount: 10.5 },
      { id: "2", type: "debit", amount: 3.25 },
    ];
    assert.strictEqual(calculateBalance(txns), 7.25);
  });
});

describe("findTransactionById", () => {
  it("finds a transaction by its string ID", () => {
    const txns = [
      { id: "abc", type: "credit", amount: 10 },
      { id: "def", type: "debit", amount: 5 },
    ];
    assert.deepStrictEqual(findTransactionById(txns, "abc"), { id: "abc", type: "credit", amount: 10 });
  });

  it("returns undefined for a non-existent ID", () => {
    const txns = [{ id: "abc", type: "credit", amount: 10 }];
    assert.strictEqual(findTransactionById(txns, "xyz"), undefined);
  });

  it("returns undefined for an empty ledger", () => {
    assert.strictEqual(findTransactionById([], "abc"), undefined);
  });
});
