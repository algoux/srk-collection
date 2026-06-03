# Sync CI Incremental Design

## Purpose

The sync CI should avoid full collection writes when a `master` push only changes a few ranklists. It should also stop retry storms, reduce parallel pressure on the API server, and provide a dry-run mode that previews remote writes without performing them.

## Diff Base

CI reads the last successful run for the same workflow on `master` through the GitHub Actions API. The workflow checks out full history, then passes that SHA to `scripts/sync.js` with `--changed-from` and the current `GITHUB_SHA` as `--changed-to`.

If no last-success SHA is available, the SHA is missing locally, or the SHA is not an ancestor of the current commit, sync falls back to full collection mode.

## Incremental Targeting

The script still parses the full `official/config.yaml` because group content depends on the full tree. In incremental mode:

- Changed `.srk.json` files map back to `fileMap` entries from `parseConfig`.
- Changed `config.yaml` triggers only collection/group sync.
- Changed files outside the collection, unrelated collection files, and deleted srk files do not trigger rank sync.
- A changed srk file that is not referenced by `config.yaml` fails the run because it cannot be synced to a stable remote `uniqueKey`.

## Dry Run

`--dry-run` is an online read-only preview. It may send GET requests to inspect remote rank and group state, and to compare the remote file bytes with the local compressed srk JSON. It must not call upload, rank create/update, or group create/update endpoints.

## Retry And Concurrency

Got's built-in retry is disabled. Every logical request is wrapped by the sync script with a maximum of five retries after the initial attempt. Per-attempt timeouts are `30s`, `45s`, `60s`, `75s`, `90s`, and `105s`. Rank sync task concurrency is limited to 5.

## Verification

- `node scripts/sync.test.js` first failed before implementation because requiring `scripts/sync.js` executed the CLI usage path.
- `npm test` now runs `scripts/sync.test.js` and covers CLI parsing, CI empty-SHA fallback, diff target mapping, unmapped srk failure, no-op diffs, retry bounds, non-retriable 404 handling, timeout stepping, and dry-run write blocking for rank and collection sync.
- A local smoke check of `resolveSyncTargets('official', fileMap, { changedFrom: 'HEAD~1', changedTo: 'HEAD' })` selected only `ccpc2026invitational-fuzhou` and `fjcpc13th` for the latest repository diff.
