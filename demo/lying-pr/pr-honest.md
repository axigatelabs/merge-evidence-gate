Add a coupon-code lookup to the cart module.

## What changed

- `src/cart.js`: new `couponPercent(code)` that maps a coupon code to a discount
  percentage, returning `0` for codes it does not know.
- `test/cart.test.js`: one test covering the unknown-code path.

No existing behavior changed. `subtotal`, `applyDiscount`, and `total` are untouched.

## Test plan

- [x] Ran `npm test` in the project root.
- 7 tests, 0 failures.

Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
