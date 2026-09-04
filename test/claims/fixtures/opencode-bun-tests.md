Adds a `--dry-run` flag to the migration CLI so operators can preview the statement
plan without touching the database.

## Verification
Ran `bun run test:unit` (738 passed, 1 skipped), and `bun run test:browser` (118 passed).
