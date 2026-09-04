/** Toy shopping-cart math. Enough surface for six tests and one PR. */

/** Sum of `price * quantity` over every line item. */
export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

/** `amount` reduced by `percent`. Throws when the percentage is out of range. */
export function applyDiscount(amount, percent) {
  if (percent < 0 || percent > 100) {
    throw new RangeError(`discount percent out of range: ${percent}`);
  }
  return amount - (amount * percent) / 100;
}

/** Cart total: the subtotal with a percentage discount applied. */
export function total(items, percent = 0) {
  return applyDiscount(subtotal(items), percent);
}
