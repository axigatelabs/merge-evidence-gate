# Contributing

Thanks for looking. This project has a narrow definition of a good change: it
must be deterministic, it must be traceable to a file, and it must not make the
gate claim more than it verified.

## Branch workflow

One integration branch, one pull request per release.

```
fm/<task>  ─┐
fm/<task>  ─┼─►  build  ──►  main
fm/<task>  ─┘   (fast-forward)   (one PR, CI runs once)
```

- Work happens on a task branch off `build` (`fm/claims`, `fm/runners`, `fm/diff`,
  `fm/docs`, …).
- Task branches are fast-forwarded into `build`. Keep yours a clean fast-forward:
  rebase onto `build` rather than merging it in.
- `build` reaches `main` through a single pull request. That is the only pull
  request, and it is where CI runs.
- **Pushes to `build` deliberately trigger nothing.** See
  [`.github/workflows/ci.yml`](.github/workflows/ci.yml): CI runs on the pull
  request into `main` and on `workflow_dispatch`, and nowhere else. Day-to-day
  verification is local.

## Before every commit

```bash
npm run check
```

That is `npm run typecheck && npm test && npm run build` — TypeScript with
`strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` on; the
Vitest suite; and the two `ncc` bundles (`dist/index.js` for the Action,
`dist/cli/index.js` for the offline CLI). All three must pass. `ncc` typechecks
everything `tsconfig.json` includes, tests as well as `src/`, so a test file that
reaches past `lib: ES2022` fails the build even when Vitest is green. Because CI
runs once per release, a broken commit on `build` is not caught by a robot — it
is caught by whoever pulls next.

`dist/` is gitignored on `build` and committed only at release time, so never
commit a bundle from a task branch. The committed `dist/index.js` must be
byte-identical to a fresh `npm run build` and must load with no sibling files
(`node dist/index.js` outside a pull-request event prints a notice and exits
0); CI checks both, because 0.1.0 shipped a bundle that required a gitignored
`sourcemap-register.js` and crashed on every install.

## Rules for changes

**No fabricated results.** Do not write a number, a command output, or a behavior
claim into documentation, a test fixture, or a comment unless you produced it by
running something. If a doc says a command prints X, run the command. If a
fixture claims to be `go test -json` output, capture real output. This project
exists because unverified claims are expensive; ours are not exempt.

**Deterministic checks only.** A check must produce the same finding from the same
inputs on any machine, and must be able to point at a file path, a test id, or a
number. If a rule needs a model, a heuristic score, or a judgment call, it does
not go in. "Probably a problem" is not a finding.

**Mark unfinished behavior as planned.** Documentation describes what the code
does today. Anything designed but not implemented is labeled *planned* — never
written in the present tense.

**The core stays pure.** Everything under `src/core/` reads no files, spawns no
processes, and makes no network calls. The Action (`src/main.ts`) is the only
place that touches `@actions/*` and the outside world. This is what makes the core
testable from fixtures, and it is not negotiable.

**Receipt field names are an API.** Additions are allowed in a minor version;
renames and removals need a new major (`/v2`). See
[`docs/receipt-spec.md`](docs/receipt-spec.md).

**American spelling** in code, comments, and documentation.

## Adding a runner adapter

An adapter turns one reporter's machine output into `ExecutedTest[]`. Everything
it needs is a string in, structured tests out.

1. **Add the family.** Extend `RunnerFamily` in
   [`src/core/types.ts`](src/core/types.ts). Skip this if your runner emits JUnit
   XML — reuse the `junit` family, as cargo-nextest does.
2. **Write the parser.** A new file in `src/core/runners/adapters/` exporting a
   `RunnerAdapter`. Decide the test **id** shape first and document it in the file
   header: it has to be stable across runs and recognizable to a human, because it
   is what `tests_digest` hashes and what a reviewer reads. Existing shapes:
   `<Package>/<Test>` (Go), `<file>::<fullName>` (Jest/Vitest),
   `<file>::<name>` (JUnit/pytest).
3. **Handle the awkward cases.** Retries (`invocations > 1`), skipped tests,
   subtests, and a package that fails to build all need a defined answer. Look at
   `src/core/runners/adapters/go.ts` for how build failures become a synthetic
   test id.
4. **Register it.** Add it to the `adapters` map in
   [`src/core/runners/index.ts`](src/core/runners/index.ts). Map a family to
   `undefined` if it genuinely has no per-test output — that is what plain
   `cargo test` does — and make sure `detect.ts` attaches a `note` explaining why.
5. **Teach detection to produce it.** In
   [`src/core/runners/detect.ts`](src/core/runners/detect.ts): add the command
   shape to `classifyDirect`, an injection function that adds the reporter flags,
   and an entry in `REPORT_PATHS`. Two invariants: the injected run must emit
   per-test output, and it must disable retries and result caching.
6. **Add a real fixture.** Capture actual reporter output into
   `test/runners/fixtures/` and add a test alongside the existing ones. Cover at
   least: a pass, a failure, a skip, and whatever the runner does that is weird.
7. **Document it.** Add a row to the "Supported runners" table in
   [`README.md`](README.md) with the exact command the gate runs.

## Adding a check

1. **Add the id.** Extend `CheckId` in [`src/core/types.ts`](src/core/types.ts)
   and `CHECK_IDS` in `src/core/reconcile/policy.ts`, and give it a default in
   `DEFAULT_POLICY.severity` there — the map is partial, so an id you forget
   silently resolves to `info` and never blocks (`test/reconcile/policy.test.ts`
   pins the full map). Never reuse a retired id — receipts in the wild carry
   them. (`C7` was held back until 0.2.0, when it became the "tests added"
   check; the next free id is `C9`.)
2. **Write the detection in the right module.** Something about the description
   goes in `src/core/claims/`; something about the diff goes in
   `src/core/diff/classify.ts` or `markers.ts`; something about the run goes in
   `src/core/runners/`. Keep it a pure function with a name that says what it
   answers.
3. **Pick a default severity honestly.** `fail` is for findings that are almost
   never legitimate (a test was deleted, CI was weakened). `needs-human` is for
   findings that are often legitimate but should be seen (a count differs, a
   lockfile moved). `info` never blocks. When in doubt, go one level softer: a
   false `fail` on a required check costs more than a missed finding.
4. **Define the evidence.** Every `Discrepancy` carries an `evidence` array of
   concrete strings. Write them so a reader can reproduce the finding with `git`
   or the test runner alone — that is the standard
   [`docs/verify-a-receipt.md`](docs/verify-a-receipt.md) holds them to.
5. **Test both directions.** The case that must fire, and the near-miss that must
   not. The near-miss test is the important one: the marker patterns in
   `src/core/diff/markers.ts` exist in the shape they do because `process.exit(`
   must not read as `xit(`.
6. **Document it.** A section in [`docs/checks.md`](docs/checks.md) with what it
   catches, exactly how it is detected, the evidence, the default severity, and a
   real failure mode it prevents. Add the row to the README table and the default
   to [`docs/receipt-spec.md`](docs/receipt-spec.md) and
   [`.merge-evidence.example.yml`](.merge-evidence.example.yml).

## The demo project

[`demo/lying-pr/`](demo/README.md) is a fixture, not a product: a six-test Node
project and two pull requests against it. It is outside the root `tsconfig.json`
includes and outside the root Vitest config, and it must stay that way — it has
its own dependencies and must never affect `npm run check`.

If you change the fixture, re-run the commands in
[`demo/README.md`](demo/README.md) and update the numbers to what you actually
got.

## Reporting a false positive

A false positive in a deterministic check is a bug with a reproducible cause, and
it is the most valuable issue you can file. Include the `receipt.json` and, if you
can, the pull request. "The evidence line does not survive step 5 of
[verify-a-receipt](docs/verify-a-receipt.md)" is a complete bug report.

## License

By contributing you agree your contributions are licensed under the MIT License —
see [LICENSE](LICENSE).
