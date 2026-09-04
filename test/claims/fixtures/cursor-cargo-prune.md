Prune now drops orphaned block index entries instead of leaking them until the next
restart. The orphan scan reuses the existing chainstate cursor, so there is no extra
disk pass.

### Testing
- [x] `cargo test -p bitcoin-rs-node --lib prune` (11 related tests)
- [x] `cargo test -p bitcoin-rs-node --lib` (full crate, no regressions)

[Open in Cursor](https://cursor.com/agents/bg-9f13c2)
