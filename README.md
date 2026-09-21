# HTTP Cache Lab — Surrogate-Key Invalidation Workbench

Local workbench for simulating an HTTP cache with **surrogate-key (tag)
invalidation**, generation-checked origin fills, and an atomic reverse tag
index.

Run `npm install`, then `npm run dev` (API on :4174, UI on :4173).
Tests: `npm test`.

## Race conditions this lab fixes

1. **Stale fill resurrection** — an origin response that was already in flight
   when an invalidation landed used to be written back after the invalidation,
   making just-invalidated content visible again.
2. **Orphaned intersection entries** — an item carrying several tags could be
   removed from only one index set, leaving a dangling reference in the other
   sets that could never be cleaned.

## Protocol

- Every tag and every cache item has a monotonic **invalidation generation**.
- When an origin fill **starts**, it captures a write condition:
  `{instanceId, itemGen, tagGens: {tag: gen}}` for every tag the item carries.
- Origin IO runs without holding the lock; when the fill completes, the
  condition is re-checked in the same transaction that commits the entry. If
  the item generation moved or **any** related tag generation advanced, the
  response is discarded (`x-cache: MISS_SUPPRESSED`) and nothing is written.
- Main-store removal and reverse-index cleanup always happen in one
  serialized critical section, iterating the entry's own tag list, so
  intersection members leave no dangling references.
- Invalidations accept an idempotency key (`idemKey`): a retried batch returns
  the original batch with `replayed: true` without bumping generations.
- Concurrent identical fills coalesce onto one in-flight record and share the
  same verdict.
- A cache reset retires the engine `instanceId`, so fills captured before a
  reset can never resurrect old state.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/cache/state` | generations, entries, reverse index, in-flight fills, batches, events, consistency check |
| GET | `/api/cache/objects/:id?delayMs=` | fetch through the cache; `x-cache`: `HIT` / `MISS` / `MISS_SUPPRESSED` / `MISS_FAILED` |
| POST | `/api/cache/invalidate` | body `{tags:[...], idemKey?}` — invalidate a label set as one batch |
| POST | `/api/cache/evict` | body `{key?}` — evict one entry (or LRU); index refs removed atomically |
| POST | `/api/cache/reset` | reset lab (optional `capacity`) |
| POST | `/api/cache/objects/:id/fault` | body `{willFail}` — make origin fills fail |
| PUT | `/api/cache/objects/:id` | conditional origin update (`revision` optimistic lock) |

The legacy `/api/experiments` endpoints remain available.

## UI

Open the page in two tabs to simulate two clients operating at once: batches,
evictions, in-flight fills and suppressed fills poll live. The right pane
shows invalidation batches (with idempotent replays), the suppressed-fill
counter, the captured condition of each stored entry, and an always-on index
consistency badge (`dangling` / `unindexed` / `extraIndexRefs` /
`generationMismatch` must all stay empty).

## Tests

`test/api.test.ts` covers: multi-tag intersection invalidation, in-flight
fill suppression, unrelated-tag non-suppression, consecutive invalidations,
idempotent replay, manual + capacity-driven eviction, eviction racing an
in-flight fill, tag reuse after invalidation, fill failure/retry, two-page
concurrent interleaving, and fill coalescing. Invariants are asserted after
every state read.
