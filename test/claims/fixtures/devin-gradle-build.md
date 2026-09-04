## Summary
Adds a retry budget to the S3 uploader so a transient 503 no longer fails the whole
batch. The budget is per-batch and resets between batches.

Verified: `./gradlew clean build` → BUILD SUCCESSFUL, 68 tests, 0 failures.

## Test plan
- [x] `./gradlew :uploader:test` passes locally
- [ ] Staging soak before rollout

---
[Devin session](https://app.devin.ai/sessions/8f2c1a90bd4e4a7f9c31)
Requested by: @maintainer
