# Verifying a receipt by hand

A receipt is only worth something if you can check it without trusting the tool
that produced it. This page is the procedure. It takes a few minutes and needs
`git`, the project's test runner, `node`, and `jq`.

The receipt format is documented in [receipt-spec.md](receipt-spec.md); this page
is the operational version of its "Verifying a receipt" section.

## 0. Get the receipt

The gate uploads `receipt.json` as a workflow artifact when `upload-receipt` is
true (the default). Download it from the workflow run, or:

```bash
gh run download <run-id> -n merge-evidence-receipt -D ./receipt
jq . receipt/receipt.json | head -40
```

Everything below reads from that file.

## 1. Confirm the receipt describes the commit you are about to merge

This is the step people skip, and it is the one that matters. A receipt is bound
to exactly one commit. A receipt for any other commit tells you nothing.

```bash
jq -r '.pr.head_sha' receipt.json
gh pr view <number> --json headRefOid -q .headRefOid
```

The two strings must be identical. If the pull request has had a push since the
gate ran, they will not be — and you need a fresh run, not a fresh reading of
this receipt.

Also check the repository and number:

```bash
jq -r '.pr.repo, .pr.number' receipt.json
```

## 2. Confirm the description has not been edited since

Every claim on the receipt carries `body_hash`: the SHA-256 of the full pull
request body at the moment the gate read it. If someone edited the description
after the run, the hash will not match what is on the pull request now.

```bash
jq -r '.claims[0].body_hash' receipt.json
gh pr view <number> --json body -q .body | shasum -a 256
```

Compare the hex digest to the part after `sha256:`. A mismatch is not proof of
anything bad — descriptions get edited for typos — but it means the claims on the
receipt are not the claims currently on the pull request.

## 3. Re-run the command the gate ran

`observed.command` is the exact command line the gate executed, **after** it
injected a machine-readable reporter. Run that string, not the one in the pull
request body.

```bash
git fetch origin "$(jq -r '.pr.head_sha' receipt.json)"
git checkout --detach "$(jq -r '.pr.head_sha' receipt.json)"

jq -r '.observed.command' receipt.json
# e.g. go test -json -count=1 ./...
```

Check `observed.exit_code` against what you get. The gate also records the
toolchain it used:

```bash
jq -r '.observed.toolchain' receipt.json
```

A different Go or Node version can legitimately change the result. If yours
differs, match theirs before concluding anything.

## 4. Recompute `tests_digest`

`observed.tests_digest` is `sha256:` over the **sorted, newline-joined list of
executed test ids**. It lets you confirm that the same set of tests ran, without
the gate having to publish the whole log. The definition lives in `testsDigest`
in `src/core/runners/index.ts`.

Save this as `digest.mjs`:

```js
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const ids = readFileSync(0, 'utf8').split('\n').filter(Boolean).sort();
const digest = createHash('sha256').update(ids.join('\n'), 'utf8').digest('hex');
console.log(`sha256:${digest}`);
```

It reads one test id per line on stdin and prints the digest. Sorting is plain
JavaScript string order (UTF-16 code units) — that is what the gate uses, so do
not pipe through `sort` with a locale set; use this script's own sort.

Now produce the id list from your re-run. The id shape is per runner, and it is
fixed by the adapters in `src/core/runners/adapters/`:

**Go** — `<Package>/<Test>`, subtests keep their `/`:

```bash
go test -json -count=1 ./... \
  | jq -r 'select(.Test != null and (.Action=="pass" or .Action=="fail" or .Action=="skip")) | .Package + "/" + .Test' \
  | node digest.mjs
```

**Jest / Vitest** — `<file>::<fullName>`:

```bash
npx vitest run --reporter=json --outputFile=/tmp/results.json
jq -r '.testResults[] | .name as $f | .assertionResults[] | $f + "::" + .fullName' /tmp/results.json \
  | node digest.mjs
```

**node's built-in runner (junit reporter)** — `<file>::<describe path>`, the
file relative to the repository and the `describe` blocks joined with ` > `:

```bash
NODE_OPTIONS="--test-reporter=junit --test-reporter-destination=/tmp/node-junit.xml" npm test
python3 - <<'PY' | node digest.mjs
import os, xml.etree.ElementTree as ET
root = os.getcwd()
def walk(node, suites):
    for tc in node.findall('testcase'):
        print(f"{os.path.relpath(tc.get('file'), root)}::{' > '.join(suites + [tc.get('name')])}")
    for suite in node.findall('testsuite'):
        walk(suite, suites + [suite.get('name')])
walk(ET.parse('/tmp/node-junit.xml').getroot(), [])
PY
```

**pytest / cargo-nextest (JUnit XML)** — `<file>::<name>`, falling back to
`<classname>::<name>` when the reporter emits no `file` attribute:

```bash
python3 - <<'PY' | node digest.mjs
import xml.etree.ElementTree as ET
for tc in ET.parse('junit.xml').getroot().iter('testcase'):
    f = tc.get('file') or tc.get('classname') or ''
    print(f"{f}::{tc.get('name')}")
PY
```

Compare the output to:

```bash
jq -r '.observed.tests_digest' receipt.json
```

**Equal** — the same set of tests executed. **Different** — a different set ran.
That is a fact about the two runs, not a verdict: a nondeterministic collection
step, a different Python version skipping a module, or a genuinely different set
of tests all produce a mismatch. Look at the id lists to see which.

One known caveat: Jest and Vitest report an **absolute** test file path, so the
digest for those runners depends on the checkout directory. To reproduce a
GitHub-hosted run exactly, check out at the same path
(`/home/runner/work/<repo>/<repo>`), or compare the sorted id lists directly
instead of the digest.

## 5. Check the diff facts yourself

The `diff` section of the receipt is a set of statements about the patch. Each
one is checkable with `git` alone.

```bash
BASE=$(jq -r '.pr.base_sha' receipt.json)
HEAD=$(jq -r '.pr.head_sha' receipt.json)

# sensitive_paths / lockfiles / snapshots: were these files really touched?
git diff --name-status "$BASE" "$HEAD"

# focused/skipped: is the marker really on an ADDED line?
git diff "$BASE" "$HEAD" -- <path> | grep -n '^+.*it\.only('
```

For `diff.tests.deleted`, list the tests at each end and take the difference —
this is what the gate does, using the runner rather than a regex:

```bash
git checkout --detach "$BASE" && go test -list '.*' ./... | sort > /tmp/base-tests
git checkout --detach "$HEAD" && go test -list '.*' ./... | sort > /tmp/head-tests
comm -23 /tmp/base-tests /tmp/head-tests
```

## 6. Check the discrepancies against their evidence

Every entry in `discrepancies[]` carries an `evidence` array of concrete strings —
paths, test ids, counts. There is no free-form reasoning to audit.

```bash
jq -r '.discrepancies[] | "\(.check) \(.severity): \(.summary)\n  \(.evidence | join("\n  "))"' receipt.json
```

If an evidence line does not survive steps 3–5, the finding is wrong. Please open
an issue with the receipt attached — a false positive in a deterministic check is
a bug with a reproducible cause.

## 7. Verify the signature

`signature.method` on the receipt says which of the two applies. Either way the
signature covers the exact bytes of `receipt.json`: verify the file you were
given, not a re-serialised copy.

**`attest`** — the receipt is the predicate of a GitHub artifact attestation
signed with the workflow's own identity:

```bash
gh attestation verify receipt.json -R owner/name \
  --predicate-type https://merge-evidence.dev/receipt/v1 \
  --signer-workflow owner/name/.github/workflows/merge-evidence.yml \
  --format json
# offline, with the bundle from the artifact:
gh attestation verify receipt.json --bundle receipt.sigstore.json -R owner/name \
  --predicate-type https://merge-evidence.dev/receipt/v1
```

Trust the certificate's identity (`verificationResult.signature.certificate`)
and the witnessed timestamps; the predicate is what that workflow said. Check
that the identity is the workflow you expect, then that `pr.head_sha` inside the
predicate is the commit in front of you, then the verdict.

**`key`** — a detached Ed25519 signature beside the receipt, checked against the
public key you hold (never the copy embedded in the signature document):

```bash
node dist/cli/index.js verify --receipt receipt.json --signature receipt.sig.json \
  --public-key merge-evidence.pub --format json
# exit 0 verified · 1 not verified, reason on stderr · 2 usage
```

An unsigned receipt (`signature.method` absent) rests on where you got it: a
workflow artifact from a run you can inspect, on a commit you confirmed in step
1. Treat a receipt pasted into a comment thread as unverified.

## Related

- [receipt-spec.md](receipt-spec.md) — every field and what it means.
- [checks.md](checks.md) — the rule behind each discrepancy.
