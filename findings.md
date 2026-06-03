# Sync CI Incremental Findings

- Current CI runs only on `master` pushes and executes `npm run sync official` after a shallow checkout.
- Current `scripts/sync.js` parses the whole collection and queues every configured srk file with `PQueue({ concurrency: 20 })`.
- Current got retry config sets `limit: 3`, but custom `calculateDelay` always returns `1000`, which can override got's stop signal and explains unbounded retry logs.
- `parseConfig('official')` maps configured srk files from `config.yaml` item paths to `<path>.srk.json`; changed file paths must be mapped back through this file map.
- `rankland-be` stores file md5 in the file model, but public routes visible in the local backend expose only `/file/upload` and `/file/download`, so this repository cannot do remote hash-only checks without backend changes.
