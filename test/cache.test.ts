import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import type {CacheSnapshot} from '../src/server/cache';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Start a supertest request immediately (superagent only sends on .then/end)
 * and return a promise for its response, so the request is genuinely in flight
 * while we perform invalidations.
 */
function start(app: ReturnType<typeof createApp>, url: string): Promise<request.Response> {
  const test = request(app).get(url);
  return new Promise((resolve, reject) => {
    test.end((error, response) => response ? resolve(response) : reject(error));
  });
}

async function state(app: ReturnType<typeof createApp>): Promise<CacheSnapshot> {
  return (await request(app).get('/api/cache/state')).body as CacheSnapshot;
}

/** Warm a key into the cache with a fast origin. */
async function warm(app: ReturnType<typeof createApp>, key: string) {
  return request(app).get(`/api/cache/${key}?delay=10`).expect(200);
}

async function expectHits(app: ReturnType<typeof createApp>, keys: string[]) {
  for (const key of keys) {
    const response = await request(app).get(`/api/cache/${key}`).expect(200);
    expect(response.header['x-cache-status']).toBe('HIT');
  }
}

describe('surrogate-key generation cache', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    app = createApp({capacity: 8});
  });

  it('invalidate covers a multi-tag intersection without orphaned entries', async () => {
    // delta carries news+sports+home; all four seeded keys get warmed.
    for (const key of ['alpha', 'beta', 'gamma', 'delta']) await warm(app, key);

    let snap = await state(app);
    expect(snap.entries).toHaveLength(4);
    expect(snap.invariant.ok).toBe(true);
    // The intersection (delta) is reachable from all three tags.
    for (const tag of ['news', 'sports', 'home']) {
      expect(snap.tagIndex[tag]).toContain('delta');
    }

    // Invalidating news + sports at once must evict alpha,beta,gamma,delta
    // (gamma is the intersection-only child key; delta is the triple overlap).
    const result = await request(app).post('/api/cache/invalidate')
      .send({tags: ['news', 'sports'], batchId: 'b1'}).expect(200);
    expect(result.body.affectedKeys.sort()).toEqual(['alpha', 'beta', 'delta', 'gamma']);

    snap = await state(app);
    expect(snap.entries).toHaveLength(0);
    // The "home" tag must not keep dangling references to gamma/delta.
    expect(snap.tagIndex).toEqual({});
    expect(snap.invariant.ok).toBe(true);
    expect(snap.invariant.danglingReferences).toEqual([]);

    // Every read now goes back to the origin (MISS / fresh fill).
    for (const key of ['alpha', 'beta', 'gamma', 'delta']) {
      const response = await request(app).get(`/api/cache/${key}?delay=5`).expect(200);
      expect(response.header['x-cache-status']).toBe('MISS');
    }
  });

  it('suppresses a write-back from an in-flight fill when a tagged invalidation lands', async () => {
    // Start two fills: only alpha carries "news"; gamma must be unaffected.
    const alpha = start(app, '/api/cache/alpha?delay=120');
    const gamma = start(app, '/api/cache/gamma?delay=120');
    await sleep(30);

    let snap = await state(app);
    expect(snap.inFlight.map(f => f.key).sort()).toEqual(['alpha', 'gamma']);

    // While both fills are travelling, invalidate "news" (alpha's tag).
    await request(app).post('/api/cache/invalidate')
      .send({tags: ['news'], batchId: 'inflight-1'}).expect(200);

    const [alphaResponse, gammaResponse] = await Promise.all([alpha, gamma]);

    // Alpha's bytes are still delivered to the one waiting client...
    expect(alphaResponse.status).toBe(200);
    expect(alphaResponse.header['x-cache-status']).toBe('SUPPRESSED');
    expect(alphaResponse.body.suppressedReason).toMatch(/tag-generation:news/);
    // ...gamma committed normally...
    expect(gammaResponse.header['x-cache-status']).toBe('MISS');

    snap = await state(app);
    expect(snap.entries.map(e => e.key)).toEqual(['gamma']);
    expect(snap.fills.find(f => f.key === 'alpha')?.status).toBe('suppressed');
    expect(snap.invariant.ok).toBe(true);

    // The suppressed content can never re-appear: next read of alpha is a
    // brand new fill, and after it lands it is captured at the new generation.
    const next = await request(app).get('/api/cache/alpha?delay=5').expect(200);
    expect(next.header['x-cache-status']).toBe('MISS');
    expect(next.body.writeCondition.tagGenerations.news).toBe(snap.tagGenerations.news);
    await expectHits(app, ['alpha', 'gamma']);
  });

  it('suppresses an in-flight fill even when the invalidated key was never cached', async () => {
    // Explicit key invalidation before alpha is ever populated.
    const pending = start(app, '/api/cache/alpha?delay=100');
    await sleep(20);
    await request(app).post('/api/cache/invalidate')
      .send({keys: ['alpha'], batchId: 'absent-key'}).expect(200);
    const response = await pending;
    expect(response.header['x-cache-status']).toBe('SUPPRESSED');
    expect(response.body.suppressedReason).toBe('item-generation');
    const snap = await state(app);
    expect(snap.entries).toHaveLength(0);
    expect(snap.invariant.ok).toBe(true);
  });

  it('consecutive invalidations are each observed and replay is idempotent', async () => {
    await warm(app, 'alpha');
    const first = await request(app).post('/api/cache/invalidate')
      .send({tags: ['news'], batchId: 'repeat'}).expect(200);
    expect(first.body.generations.news).toBe(1);

    await warm(app, 'alpha');
    const second = await request(app).post('/api/cache/invalidate')
      .send({tags: ['news'], batchId: 'repeat-2'}).expect(200);
    expect(second.body.generations.news).toBe(2);

    // Replaying either batch must not move generations again.
    const replay1 = await request(app).post('/api/cache/invalidate')
      .send({tags: ['news'], batchId: 'repeat'}).expect(200);
    const replay2 = await request(app).post('/api/cache/invalidate')
      .send({tags: ['news'], batchId: 'repeat-2'}).expect(200);
    expect(replay1.body.duplicated).toBe(true);
    expect(replay2.body.duplicated).toBe(true);
    expect(replay1.body.generations.news).toBe(1);
    expect(replay2.body.generations.news).toBe(2);

    const snap = await state(app);
    expect(snap.tagGenerations.news).toBe(2);
    expect(snap.entries).toHaveLength(0);
    // Two distinct batches executed; both replays were folded into them.
    expect(snap.batches).toHaveLength(2);
    expect(snap.batches.reduce((n, b) => n + b.duplicateCount, 0)).toBe(2);
    expect(snap.invariant.ok).toBe(true);
  });

  it('manual and capacity eviction keeps the reverse index in sync', async () => {
    await warm(app, 'alpha');
    await warm(app, 'beta');

    const removed = await request(app).post('/api/cache/alpha/evict').expect(200);
    expect(removed.body.removed).toBe(true);
    let snap = await state(app);
    expect(snap.entries.map(e => e.key)).toEqual(['beta']);
    expect(snap.tagIndex.news ?? []).not.toContain('alpha');
    expect(snap.tagIndex.home ?? []).toEqual([]); // alpha was home's only member
    expect(snap.invariant.ok).toBe(true);
    // Evicting again is a harmless no-op.
    await request(app).post('/api/cache/alpha/evict').expect(200);

    // Capacity eviction: shrink to one entry, then fill two more.
    await request(app).post('/api/cache/config/capacity').send({capacity: 1}).expect(200);
    await warm(app, 'gamma'); // evicts LRU beta
    await warm(app, 'delta'); // evicts gamma
    snap = await state(app);
    expect(snap.entries.map(e => e.key)).toEqual(['delta']);
    expect(snap.evictions.filter(e => e.reason === 'capacity').map(e => e.key).sort())
      .toEqual(['beta', 'gamma']);
    expect(snap.invariant.ok).toBe(true);

    // A refresh fill in flight when the entry is evicted must be suppressed by
    // the bumped item generation.
    await warm(app, 'alpha'); // capacity 1: alpha is the sole entry
    const pending = start(app, '/api/cache/alpha?refresh=1&delay=80');
    await sleep(20);
    await request(app).post('/api/cache/alpha/evict').expect(200);
    const guarded = await pending;
    expect(guarded.header['x-cache-status']).toBe('SUPPRESSED');
    expect(guarded.body.suppressedReason).toBe('item-generation');

    snap = await state(app);
    expect(snap.entries).toHaveLength(0);
    expect(snap.invariant.ok).toBe(true);
  });

  it('tag reuse: a fill captured at the old tag set is suppressed when tags change mid-flight', async () => {
    // Fill alpha (tags news,home), then republish origin reusing the entry for
    // a new surrogate tag while a refresh is in flight.
    await warm(app, 'alpha');

    const refresh = start(app, '/api/cache/alpha?refresh=1&delay=100');
    await sleep(25);
    // Origin re-bind: drop "news", reuse slot with "promo". The cached copy is
    // stale; invalidate the old tags and republish the origin.
    await request(app).post('/api/cache/invalidate')
      .send({tags: ['news', 'home'], batchId: 'reuse-invalidate'}).expect(200);
    await request(app).post('/api/cache/alpha/origin')
      .send({body: 'cache simulations: alpha\nstate: promoted', tags: ['promo']}).expect(200);

    const response = await refresh;
    // The in-flight fill saw news generation move (and/or its tag set change);
    // either way it must not be cached.
    expect(response.header['x-cache-status']).toBe('SUPPRESSED');
    expect(['item-generation', 'surrogate-keys-changed', 'tag-generation:news', 'tag-generation:home'])
      .toContain(response.body.suppressedReason);

    let snap = await state(app);
    expect(snap.entries).toHaveLength(0);
    expect(snap.invariant.ok).toBe(true);

    // A subsequent fill lands under the new surrogate tag only.
    const fresh = await request(app).get('/api/cache/alpha?delay=5').expect(200);
    expect(fresh.header['x-cache-status']).toBe('MISS');
    expect(fresh.body.tags).toEqual(['promo']);
    snap = await state(app);
    expect(snap.tagIndex.news).toBeUndefined();
    expect(snap.tagIndex.home).toBeUndefined();
    expect(snap.tagIndex.promo).toEqual(['alpha']);
    expect(snap.invariant.ok).toBe(true);

    // Invalidating the fresh tag evicts the reused entry; old tags have no refs.
    await request(app).post('/api/cache/invalidate')
      .send({tags: ['promo'], batchId: 'reuse-invalidate-2'}).expect(200);
    snap = await state(app);
    expect(snap.entries).toHaveLength(0);
    expect(snap.tagIndex).toEqual({});
    expect(snap.invariant.ok).toBe(true);
  });

  it('fill failure records a failed fill and never writes the cache or index', async () => {
    await request(app).post('/api/cache/alpha/fail-mode').send({failing: true}).expect(200);
    const response = await request(app).get('/api/cache/alpha?delay=10').expect(502);
    expect(response.body.cacheStatus).toBe('FAIL');
    let snap = await state(app);
    expect(snap.entries).toHaveLength(0);
    expect(snap.tagIndex).toEqual({});
    expect(snap.fills[0].status).toBe('failed');
    expect(snap.invariant.ok).toBe(true);

    // Recovery: origin healthy again fills normally.
    await request(app).post('/api/cache/alpha/fail-mode').send({failing: false}).expect(200);
    const recovered = await request(app).get('/api/cache/alpha?delay=5').expect(200);
    expect(recovered.header['x-cache-status']).toBe('MISS');
    snap = await state(app);
    expect(snap.entries.map(e => e.key)).toEqual(['alpha']);
    expect(snap.invariant.ok).toBe(true);
  });

  it('two pages operating concurrently: races leave no stale content and no dangling refs', async () => {
    // Warm everything.
    await Promise.all(['alpha', 'beta', 'gamma', 'delta'].map(k => warm(app, k)));

    // Page A and Page B fire the same logical invalidation concurrently using
    // the same batch id -> exactly one generation bump.
    const [a, b] = await Promise.all([
      request(app).post('/api/cache/invalidate').send({tags: ['news', 'sports'], batchId: 'shared-batch'}),
      request(app).post('/api/cache/invalidate').send({tags: ['news', 'sports'], batchId: 'shared-batch'}),
    ]);
    expect([a.body.generations.news, b.body.generations.news].sort()).toEqual([1, 1]);
    expect(a.body.duplicated === true || b.body.duplicated === true).toBe(true);

    // Both pages immediately re-request while origin latency varies.
    const reads = await Promise.all([
      request(app).get('/api/cache/alpha?delay=90'),
      request(app).get('/api/cache/beta?delay=10'),
      request(app).get('/api/cache/gamma?delay=60'),
      request(app).get('/api/cache/delta?delay=10'),
    ]);
    for (const r of reads) {
      expect(r.status).toBe(200);
      expect(r.header['x-cache-status']).toBe('MISS');
    }

    // Mid-flight churn: invalidation racing more fills and an eviction.
    const racing = start(app, '/api/cache/delta?refresh=1&delay=100');
    await sleep(20);
    await Promise.all([
      request(app).post('/api/cache/invalidate').send({tags: ['home'], batchId: 'shared-batch-2'}),
      request(app).post('/api/cache/beta/evict'),
      start(app, '/api/cache/alpha?refresh=1&delay=80').then(async r => {
        // The other page evicts alpha right after its fill commits...
        await sleep(5);
        await request(app).post('/api/cache/alpha/evict');
        return r;
      }),
    ]);
    const racingResponse = await racing;
    expect(racingResponse.header['x-cache-status']).toBe('SUPPRESSED');

    await sleep(120);
    const snap = await state(app);
    expect(snap.invariant.ok).toBe(true);
    expect(snap.invariant.danglingReferences).toEqual([]);
    expect(snap.invariant.missingReferences).toEqual([]);
    expect(snap.invariant.staleEntries).toEqual([]);

    // Everything currently cached was captured at live generations; every
    // stale fill was suppressed; nothing old-generation is visible.
    for (const entry of snap.entries) {
      expect(entry.itemGeneration).toBe(snap.itemGenerations[entry.key]);
      for (const tag of entry.tags) {
        expect(entry.tagGenerations[tag]).toBe(snap.tagGenerations[tag]);
      }
    }
  });

  it('invariants stay green across interleaved fills, invalidations and evictions', async () => {
    const keys = ['alpha', 'beta', 'gamma', 'delta'];
    const tags = ['news', 'sports', 'home'];
    const operations: Array<Promise<unknown>> = [];
    for (let i = 0; i < 24; i++) {
      const key = keys[i % keys.length];
      if (i % 4 === 0) {
        operations.push(request(app).get(`/api/cache/${key}?refresh=1&delay=${20 + (i % 5) * 20}`));
      } else if (i % 4 === 1) {
        operations.push(request(app).post('/api/cache/invalidate')
          .send({tags: [tags[i % tags.length]], batchId: `storm-${i}`}));
      } else if (i % 4 === 2) {
        operations.push(request(app).post(`/api/cache/${key}/evict`));
      } else {
        operations.push(request(app).get(`/api/cache/${key}?delay=10`));
      }
    }
    await Promise.all(operations);
    await sleep(150);
    const snap = await state(app);
    expect(snap.invariant.ok).toBe(true);
    // Cross-check index<->store symmetry directly.
    for (const entry of snap.entries) {
      for (const tag of entry.tags) expect(snap.tagIndex[tag]).toContain(entry.key);
    }
    for (const [tag, refs] of Object.entries(snap.tagIndex)) {
      for (const key of refs) expect(snap.entries.find(e => e.key === key)?.tags).toContain(tag);
    }
  });

  afterEach(async () => {
    // No background timers should keep state corrupt; final invariant is clean.
    const snap = await state(app);
    expect(snap.invariant.ok).toBe(true);
  });
});
