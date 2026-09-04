Make the cart tolerant of out-of-range discount percentages.

## What changed

- `src/cart.js`: `applyDiscount` now clamps `percent` into `0..100` instead of
  throwing, so a bad coupon can no longer crash checkout.

## Test plan

- [x] Ran `npm test` in the project root.
- 12 tests, 0 failures.
- [x] Full suite green, no regressions.

Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
