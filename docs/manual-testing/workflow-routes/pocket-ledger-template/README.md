# Pocket Ledger

A minimal financial ledger for testing piOrchestrator workflow routes.

## Transaction shape

```ts
interface Transaction {
  id: string;
  type: "credit" | "debit";
  amount: number | string;
  category?: string;
  description?: string;
}
```

Amount may be specified as a number or a numeric string. A transaction without a
category is treated as `"uncategorized"`.

## API

### calculateBalance(transactions)

Calculates the net balance by summing credits and subtracting debits. Returns
the resulting number.

### findTransactionById(transactions, id)

Returns the first transaction with the matching ID, or `undefined` if no
transaction is found. IDs are exact string identifiers.
