# Sync CI Incremental Implementation Plan

## Goal

Implement incremental `official` collection sync for CI, bounded retry/timeout behavior, lower sync concurrency, and a read-only dry-run mode.

## Phases

- [x] Phase 1: Capture implementation plan and current findings.
- [x] Phase 2: Add failing tests for diff targeting, retry, dry-run, and fallback behavior.
- [x] Phase 3: Implement sync refactor and CLI behavior.
- [x] Phase 4: Update GitHub Actions workflow and npm test command.
- [x] Phase 5: Finalize design notes and verification results.

## Decisions

- Use GitHub Actions successful run history as the last-success source.
- Keep dry-run as read-only online mode: GET requests are allowed, remote writes are blocked.
- Keep sync scoped to this repository; do not change rankland backend hash APIs.

## Errors Encountered

| Error                                                                                          | Attempt  | Resolution                                                                                                    |
| ---------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `node scripts/sync.test.js` exited through `sync.js` CLI usage path while requiring the module | Red test | Refactored `sync.js` to use `require.main === module` and export testable sync helpers.                       |
| Empty CI `LAST_SUCCESS_SHA` was treated as a missing paired argument                           | Red test | Changed CLI parsing to validate whether flags are present, allowing an empty value to fall back to full sync. |
