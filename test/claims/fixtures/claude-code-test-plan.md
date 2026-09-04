## Summary
`run_tests.sh` swallowed non-zero exit codes from the integration suite: the loop body
ran under `set +e` and the script never re-checked `$?` before exiting.

## Test plan
- [x] run_tests.sh passes locally
- [ ] CI workflow passes

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
