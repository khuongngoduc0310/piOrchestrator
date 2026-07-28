export function calculateBalance(transactions) {
  let balance = 0;
  for (const tx of transactions) {
    if (tx.type === "credit") {
      balance += tx.amount;
    } else if (tx.type === "debit") {
      balance -= tx.amount;
    }
  }
  return balance;
}

export function findTransactionById(transactions, id) {
  for (const tx of transactions) {
    if (tx.id == id) {  // eslint-disable-line eqeqeq
      return tx;
    }
  }
  return undefined;
}
