import { describe, expect, it } from 'vitest';

import { applyDiscount, subtotal, total } from '../src/cart.js';

const CART = [
  { price: 10, quantity: 2 },
  { price: 5, quantity: 1 },
];

describe('subtotal', () => {
  it('is zero for an empty cart', () => {
    expect(subtotal([])).toBe(0);
  });

  it('sums price times quantity', () => {
    expect(subtotal(CART)).toBe(25);
  });
});

describe('applyDiscount', () => {
  it('removes the given percentage', () => {
    expect(applyDiscount(200, 10)).toBe(180);
  });

  it('rejects a negative percentage', () => {
    expect(() => applyDiscount(200, -1)).toThrow(RangeError);
  });

  it('rejects a percentage above 100', () => {
    expect(() => applyDiscount(200, 101)).toThrow(RangeError);
  });
});

describe('total', () => {
  it('discounts the subtotal', () => {
    expect(total(CART, 20)).toBe(20);
  });
});
