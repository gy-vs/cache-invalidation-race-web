/**
 * Simulated HTTP cache with surrogate-key (tag) invalidation.
 *
 * Correctness model
 * -----------------
 * - Every tag owns a monotonically increasing invalidation generation.
 * - Every cache key owns an item generation, bumped whenever the cached entry
 *   is removed by invalidation or eviction.
 * - A revalidation/origin fill captures its write condition at *start*:
 *   the item generation and the generation of every surrogate tag the origin
 *   will attach. When the fill finishes it commits under a global lock; if any
 *   captured generation moved while the fill was in flight the result is
 *   discarded ("suppressed fill") and can never re-enter the cache.
 * - The main entry map and the reverse tag index are mutated in the same
 *   synchronous critical section, so removing an entry always removes every
 *   tag reference it owned (no orphaned entries / dangling index refs).
 * - Invalidations carry a client batch id; replaying the same id is idempotent.
 */

export type OriginRecord = {
  key: string;
  body: string;
  tags: string[];
  rev: number;
  updatedAt: string;
};

export type FillSnapshot = {
  itemGeneration: number;
  tags: string[];
  tagGenerations: Record<string, number>;
};

export type CacheEntry = {
  key: string;
  body: string;
  tags: string[];
  originRev: number;
  /** Slot generation captured when the fill started. */
  itemGeneration: number;
  /** Tag generations captured when the fill started. */
  tagGenerations: Record<string, number>;
  fillId: string;
  cachedAt: number;
  lastAccessAt: number;
  hits: number;
  size: number;
};

export type InvalidationBatch = {
  id: string;
  at: number;
  tags: string[];
  keys: string[];
  affectedKeys: string[];
  generations: Record<string, number>;
  duplicateCount: number;
};

export type FillEvent = {
  fillId: string;
  at: number;
  key: string;
  status: 'stored' | 'suppressed' | 'failed';
  reason?: string;
  durationMs: number;
  originRev?: number;
  snapshot?: FillSnapshot;
  observed?: { itemGeneration: number; tagGenerations: Record<string, number> };
};

export type EvictionEvent = { at: number; key: string; reason: 'manual' | 'capacity' };

export type InFlightFill = {
  fillId: string;
  key: string;
  startedAt: number;
  delayMs: number;
  snapshot: FillSnapshot;
};

export type CacheInvariant = {
  ok: boolean;
  /** index references that point at missing entries / wrong tags */
  danglingReferences: string[];
  /** cached entries whose tags are not all indexed */
  missingReferences: string[];
  /** entries captured at generations that have since moved */
  staleEntries: string[];
};

export type CacheSnapshot = {
  capacity: number;
  size: number;
  origins: OriginRecord[];
  failingKeys: string[];
  entries: Array<Omit<CacheEntry, 'cachedAt' | 'lastAccessAt'> & {
    cachedAt: string;
    lastAccessAt: string;
    ageMs: number;
  }>;
  tagIndex: Record<string, string[]>;
  tagGenerations: Record<string, number>;
  itemGenerations: Record<string, number>;
  inFlight: Array<Omit<InFlightFill, 'startedAt'> & { startedAt: string; elapsedMs: number }>;
  batches: InvalidationBatch[];
  fills: FillEvent[];
  evictions: EvictionEvent[];
  invariant: CacheInvariant;
};

export type FetchResult =
  | { status: 'HIT'; entry: CacheEntry }
  | { status: 'MISS'; entry: CacheEntry }
  | { status: 'SUPPRESSED'; key: string; reason: string; fillId: string; origin: OriginRecord }
  | { status: 'FAIL'; key: string; fillId: string; error: string };

export class HttpError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

const MAX_EVENTS = 100;

const DEFAULT_ORIGINS: ReadonlyArray<Pick<OriginRecord, 'key' | 'body' | 'tags'>> = [
  {key: 'alpha', body: 'cache simulations: alpha\nstate: active', tags: ['news', 'home']},
  {key: 'beta', body: 'cache simulations: beta\nstate: review', tags: ['news', 'sports']},
  {key: 'gamma', body: 'cache simulations: gamma\nstate: draft', tags: ['sports', 'home']},
  {key: 'delta', body: 'cache simulations: delta\nstate: intersection', tags: ['news', 'sports', 'home']},
];

function normTags(tags: string[]): string[] {
  return [...new Set(tags.map(t => String(t).trim()).filter(Boolean))].sort();
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

export class CacheStore {
  private origins = new Map<string, OriginRecord>();
  private entries = new Map<string, CacheEntry>();
  /** Reverse surrogate-key index: tag -> keys currently carrying that tag. */
  private tagIndex = new Map<string, Set<string>>();
  private tagGens = new Map<string, number>();
  private itemGens = new Map<string, number>();
  /** LRU order: iteration goes least-recently-used first. */
  private lru = new Map<string, true>();
  private inFlight = new Map<string, InFlightFill>();
  private batchesById = new Map<string, InvalidationBatch>();
  private batches: InvalidationBatch[] = [];
  private fills: FillEvent[] = [];
  private evictions: EvictionEvent[] = [];
  private failingKeys = new Set<string>();
  private fillSeq = 0;
  private batchSeq = 0;
  private lockTail: Promise<unknown> = Promise.resolve();
  capacity: number;

  constructor(options: { capacity?: number } = {}) {
    this.capacity = options.capacity ?? 8;
    for (const seed of DEFAULT_ORIGINS) {
      this.origins.set(seed.key, {
        key: seed.key,
        body: seed.body,
        tags: normTags(seed.tags),
        rev: 1,
        updatedAt: new Date(0).toISOString(),
      });
    }
  }

  /** Serialise read-modify-write critical sections. */
  private withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.lockTail.then(fn, () => fn());
    this.lockTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private tagGen(tag: string): number {
    return this.tagGens.get(tag) ?? 0;
  }

  private itemGen(key: string): number {
    return this.itemGens.get(key) ?? 0;
  }

  // ---- origin catalogue ----------------------------------------------------

  listOrigins(): OriginRecord[] {
    return [...this.origins.values()];
  }

  upsertOrigin(key: string, patch: { body?: string; tags?: string[] }): Promise<OriginRecord> {
    return this.withLock(() => {
      const current = this.origins.get(key);
      const record: OriginRecord = {
        key,
        body: patch.body !== undefined ? String(patch.body) : current?.body ?? '',
        tags: normTags(patch.tags ?? current?.tags ?? []),
        rev: (current?.rev ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      this.origins.set(key, record);
      return record;
    });
  }

  setOriginFailure(key: string, failing: boolean): void {
    if (failing) this.failingKeys.add(key);
    else this.failingKeys.delete(key);
  }

  // ---- read path -----------------------------------------------------------

  async fetch(key: string, options: { delayMs?: number; fail?: boolean; refresh?: boolean } = {}): Promise<FetchResult> {
    const delayMs = Math.max(0, options.delayMs ?? 120);

    // Fast path: cached entry (refresh forces a new conditional fill).
    if (!options.refresh) {
      const hit = await this.withLock(() => {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        entry.hits += 1;
        entry.lastAccessAt = Date.now();
        this.touchLru(key);
        return entry;
      });
      if (hit) return {status: 'HIT', entry: {...hit, tagGenerations: {...hit.tagGenerations}}};
    }

    const fillId = `fill-${++this.fillSeq}`;

    // Capture the write condition BEFORE the origin request leaves.
    const snapshot = await this.withLock<FillSnapshot>(() => {
      const origin = this.origins.get(key);
      if (!origin) throw new HttpError(404, 'not_found');
      return {
        itemGeneration: this.itemGen(key),
        tags: origin.tags.slice(),
        tagGenerations: Object.fromEntries(origin.tags.map(tag => [tag, this.tagGen(tag)])),
      };
    });

    const startedAt = Date.now();
    this.inFlight.set(fillId, {fillId, key, startedAt, delayMs, snapshot});

    let origin: OriginRecord | undefined;
    let failure: string | undefined;
    try {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      origin = this.origins.get(key);
      if (!origin) failure = 'origin_disappeared';
      else if (options.fail || this.failingKeys.has(key)) failure = 'origin_5xx';
    } catch (error) {
      failure = error instanceof Error ? error.message : 'origin_error';
    }

    try {
      if (failure || !origin) {
        const event: FillEvent = {
          fillId, at: Date.now(), key, status: 'failed', reason: failure,
          durationMs: Date.now() - startedAt, snapshot,
        };
        await this.withLock(() => this.recordFill(event));
        return {status: 'FAIL', key, fillId, error: failure ?? 'origin_error'};
      }

      return await this.withLock(() => {
        const now = Date.now();
        const observed = {
          itemGeneration: this.itemGen(key),
          tagGenerations: Object.fromEntries(origin!.tags.map(tag => [tag, this.tagGen(tag)])),
        };

        // Re-validate the captured write condition. The first mismatch wins.
        let reason: string | undefined;
        if (observed.itemGeneration !== snapshot.itemGeneration) {
          reason = 'item-generation';
        } else if (!sameTags(normTags(origin!.tags), snapshot.tags)) {
          reason = 'surrogate-keys-changed';
        } else {
          for (const tag of origin!.tags) {
            if (observed.tagGenerations[tag] !== snapshot.tagGenerations[tag]) {
              reason = `tag-generation:${tag}`;
              break;
            }
          }
        }

        if (reason) {
          this.recordFill({
            fillId, at: now, key, status: 'suppressed', reason,
            durationMs: now - startedAt, originRev: origin!.rev, snapshot, observed,
          });
          // Delivered to this one client but never written to the cache.
          return {status: 'SUPPRESSED', key, reason, fillId, origin: origin!};
        }

        // Atomic replace: drop the previous entry + every one of its refs first.
        this.removeEntry(key);

        const entry: CacheEntry = {
          key,
          body: origin!.body,
          tags: origin!.tags.slice(),
          originRev: origin!.rev,
          itemGeneration: observed.itemGeneration,
          tagGenerations: observed.tagGenerations,
          fillId,
          cachedAt: now,
          lastAccessAt: now,
          hits: 0,
          size: origin!.body.length,
        };
        this.entries.set(key, entry);
        for (const tag of entry.tags) {
          let refs = this.tagIndex.get(tag);
          if (!refs) this.tagIndex.set(tag, (refs = new Set()));
          refs.add(key);
        }
        this.touchLru(key);
        this.enforceCapacity(now);

        this.recordFill({
          fillId, at: now, key, status: 'stored',
          durationMs: now - startedAt, originRev: origin!.rev, snapshot, observed,
        });
        return {status: 'MISS', entry: {...entry, tagGenerations: {...entry.tagGenerations}}};
      });
    } finally {
      this.inFlight.delete(fillId);
    }
  }

  // ---- invalidation --------------------------------------------------------

  invalidate(request: { tags?: string[]; keys?: string[]; batchId?: string }): Promise<InvalidationBatch & { duplicated: boolean }> {
    const tags = normTags(request.tags ?? []);
    const keys = [...new Set((request.keys ?? []).map(k => String(k).trim()).filter(Boolean))].sort();

    return this.withLock(() => {
      const id = request.batchId?.trim() || `batch-${++this.batchSeq}`;
      const existing = this.batchesById.get(id);
      if (existing) {
        existing.duplicateCount += 1;
        return {...existing, duplicated: true};
      }

      // Union of every key reachable from the invalidated tags, plus explicit keys.
      const affected = new Set<string>();
      for (const tag of tags) {
        for (const keyOfTag of this.tagIndex.get(tag) ?? []) affected.add(keyOfTag);
      }
      for (const key of keys) affected.add(key);

      // Atomic removal from main store + ALL reverse-index references.
      for (const key of affected) {
        if (this.removeEntry(key)) {
          // Bump the slot generation so in-flight fills for it are suppressed.
          this.itemGens.set(key, this.itemGen(key) + 1);
        }
      }
      // Explicit keys may not be cached; still arm the generation guard so a
      // fill that is currently in flight cannot land after the invalidation.
      for (const key of keys) {
        if (!affected.has(key) || !this.entries.has(key)) this.itemGens.set(key, this.itemGen(key) + 1);
      }
      // Tag generations move even when nothing is indexed right now: a fill in
      // flight for an absent key carrying the tag must be suppressed.
      const generations: Record<string, number> = {};
      for (const tag of tags) {
        const next = this.tagGen(tag) + 1;
        this.tagGens.set(tag, next);
        generations[tag] = next;
      }

      const batch: InvalidationBatch = {
        id,
        at: Date.now(),
        tags,
        keys,
        affectedKeys: [...affected].sort(),
        generations,
        duplicateCount: 0,
      };
      this.batchesById.set(id, batch);
      this.batches.push(batch);
      if (this.batches.length > MAX_EVENTS) this.batches.shift();
      return {...batch, duplicated: false};
    });
  }

  evict(key: string, reason: 'manual' | 'capacity' = 'manual'): Promise<boolean> {
    return this.withLock(() => {
      const removed = this.removeEntry(key);
      if (removed) {
        this.itemGens.set(key, this.itemGen(key) + 1);
        this.evictions.push({at: Date.now(), key, reason});
        if (this.evictions.length > MAX_EVENTS) this.evictions.shift();
      }
      return removed;
    });
  }

  reset(): Promise<void> {
    return this.withLock(() => {
      this.entries.clear();
      this.tagIndex.clear();
      this.tagGens.clear();
      this.itemGens.clear();
      this.lru.clear();
      this.inFlight.clear();
      this.batchesById.clear();
      this.batches = [];
      this.fills = [];
      this.evictions = [];
      this.failingKeys.clear();
      this.fillSeq = 0;
      this.batchSeq = 0;
    });
  }

  // ---- internals -----------------------------------------------------------

  /** Remove an entry and every reverse-index reference it owns. */
  private removeEntry(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.lru.delete(key);
    for (const tag of entry.tags) {
      const refs = this.tagIndex.get(tag);
      if (!refs) continue;
      refs.delete(key);
      if (refs.size === 0) this.tagIndex.delete(tag);
    }
    return true;
  }

  private touchLru(key: string): void {
    this.lru.delete(key);
    this.lru.set(key, true);
  }

  private enforceCapacity(now: number): void {
    while (this.entries.size > this.capacity && this.lru.size > 0) {
      const oldest = this.lru.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      if (this.removeEntry(oldest)) {
        this.itemGens.set(oldest, this.itemGen(oldest) + 1);
        this.evictions.push({at: now, key: oldest, reason: 'capacity'});
      }
    }
  }

  private recordFill(event: FillEvent): void {
    this.fills.push(event);
    if (this.fills.length > MAX_EVENTS) this.fills.shift();
  }

  async setCapacity(capacity: number): Promise<void> {
    const safe = Math.max(1, Math.floor(capacity));
    this.capacity = safe;
    // Synchronous drain so the index never exceeds the new limit.
    await this.withLock(() => this.enforceCapacity(Date.now()));
  }

  // ---- introspection -------------------------------------------------------

  invariant(): CacheInvariant {
    const danglingReferences: string[] = [];
    for (const [tag, refs] of this.tagIndex) {
      for (const key of refs) {
        const entry = this.entries.get(key);
        if (!entry) danglingReferences.push(`${tag} -> ${key} (entry missing)`);
        else if (!entry.tags.includes(tag)) danglingReferences.push(`${tag} -> ${key} (tag not carried)`);
      }
    }
    const missingReferences: string[] = [];
    const staleEntries: string[] = [];
    for (const [key, entry] of this.entries) {
      for (const tag of entry.tags) {
        if (!this.tagIndex.get(tag)?.has(key)) missingReferences.push(`${key} -> ${tag}`);
      }
      if (entry.itemGeneration !== this.itemGen(key)) {
        staleEntries.push(`${key} (item gen ${entry.itemGeneration} != ${this.itemGen(key)})`);
      }
      for (const tag of entry.tags) {
        const current = this.tagGen(tag);
        if (entry.tagGenerations[tag] !== current) {
          staleEntries.push(`${key} (tag ${tag} gen ${entry.tagGenerations[tag]} != ${current})`);
        }
      }
    }
    return {
      ok: danglingReferences.length === 0 && missingReferences.length === 0 && staleEntries.length === 0,
      danglingReferences,
      missingReferences,
      staleEntries,
    };
  }

  snapshot(): CacheSnapshot {
    const now = Date.now();
    const allTags = new Set<string>();
    for (const origin of this.origins.values()) origin.tags.forEach(t => allTags.add(t));
    for (const tag of this.tagGens.keys()) allTags.add(tag);

    return {
      capacity: this.capacity,
      size: this.entries.size,
      origins: this.listOrigins(),
      failingKeys: [...this.failingKeys].sort(),
      entries: [...this.entries.values()].map(({cachedAt, lastAccessAt, ...entry}) => ({
        ...entry,
        cachedAt: new Date(cachedAt).toISOString(),
        lastAccessAt: new Date(lastAccessAt).toISOString(),
        ageMs: now - cachedAt,
      })),
      tagIndex: Object.fromEntries([...this.tagIndex.entries()]
        .map(([tag, refs]) => [tag, [...refs].sort()] as const)
        .sort((a, b) => a[0].localeCompare(b[0]))),
      tagGenerations: Object.fromEntries([...allTags].sort().map(tag => [tag, this.tagGen(tag)])),
      itemGenerations: Object.fromEntries([...this.origins.keys()].sort().map(key => [key, this.itemGen(key)])),
      inFlight: [...this.inFlight.values()].map(fill => ({
        ...fill,
        snapshot: {...fill.snapshot, tagGenerations: {...fill.snapshot.tagGenerations}},
        startedAt: new Date(fill.startedAt).toISOString(),
        elapsedMs: now - fill.startedAt,
      })),
      batches: this.batches.slice().reverse(),
      fills: this.fills.slice().reverse(),
      evictions: this.evictions.slice().reverse(),
      invariant: this.invariant(),
    };
  }
}
