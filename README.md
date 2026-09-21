# HTTP Cache Lab

Local workbench for simulating an HTTP cache with **surrogate-key (tag)
invalidation**, per-tag / per-item invalidation **generations**, and an
in-flight fill guard.

Run `npm install`, then `npm run dev` (API on `:4174`, UI on `:4173`).
Tests: `npm test`.

## Race conditions this lab fixes

1. A stale origin fill already in flight when its tags are invalidated would
   otherwise commit after the invalidation and resurrect the old content.
2. Invalidating the intersection of two tags could delete only one reverse
   index reference, leaving an orphan entry that could never be cleaned.

## Correctness model

- Every surrogate tag has a monotonic `tagGeneration`; every cache key has an
  `itemGeneration` (bumped on invalidation and eviction).
- A fill **captures its write condition when it starts**: the item generation
  and each tag generation. When it returns it commits under a global lock; if
  any captured generation moved (or the origin's surrogate key set changed),
  the write-back is **suppressed** — bytes are served to that one client but
  never enter the cache.
- Main store and reverse tag index are updated atomically in the same critical
  section; removing an entry drops **all** of its tag references, so the index
  can never dangle.
- Invalidations are idempotent batches: replaying the same `batchId` never
  moves a generation twice.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/cache/state` | Entries, reverse index, generations, batches, fills, evictions, invariant |
| GET | `/api/cache/:key?delay=&refresh=&fail=` | Read-through fetch (`X-Cache-Status: HIT\|MISS\|SUPPRESSED`) |
| POST | `/api/cache/invalidate` | `{tags?, keys?, batchId?}` generation invalidation (idempotent) |
| POST | `/api/cache/:key/evict` | Manual LRU eviction |
| POST | `/api/cache/:key/origin` | Publish new origin body/tags (tag-reuse demo) |
| POST | `/api/cache/:key/fail-mode` | Simulate origin failure |
| POST | `/api/cache/config/capacity` | LRU capacity |
| POST | `/api/cache/reset` | Reset workbench |

## Covered scenarios

`test/cache.test.ts` covers multi-tag intersection, in-flight fill suppression
(including never-cached keys), consecutive + idempotent invalidations,
manual/capacity eviction, surrogate-tag reuse, fill failure, two pages acting
concurrently, and randomized interleaving — each ending with an invariant
check that no stale-generation entry is visible and the reverse index has
neither dangling nor missing references.
