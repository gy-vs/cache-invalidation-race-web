// HTTP surrogate-key cache engine with generation-checked fills.
//
// Concurrency model:
//   - Every mutation of the store / reverse tag index runs inside `critical`,
//     a serialized critical section. Origin IO never holds the lock.
//   - A fill captures its write condition (per-item generation + per-tag
//     generations) at the moment the origin fetch starts. When the fetch
//     completes, the condition is re-checked inside the same transaction that
//     commits the entry: any advance means the response belonged to an old
//     generation and is discarded (a suppressed fill).
//   - Store entry removal and reverse-index cleanup are always performed
//     together, so intersection members can never leave a dangling index
//     reference behind.

export type OriginObject = {
  id: string;
  name: string;
  tags: string[];
  revision: number;
  content: string;
  updatedAt: string;
  willFail: boolean;
};

export type Condition = {
  instanceId: number;
  itemGen: number;
  tagGens: Record<string, number>;
};

export type CachedEntry = {
  key: string;
  tags: string[];
  revision: number;
  storedAt: number;
  condition: Condition;
};

export type InflightRecord = {
  key: string;
  startedAt: number;
  delayMs: number;
  condition: Condition;
  done: Promise<FetchOutcome>;
};

export type SuppressedReason = {
  changedTags: { tag: string; from: number; to: number }[];
  itemGen: { from: number; to: number };
};

export type FetchOutcome =
  | { result: 'hit' | 'miss'; object: OriginObject; entry: CachedEntry }
  | { result: 'suppressed'; object: OriginObject; reason: SuppressedReason }
  | { result: 'error'; error: string };

export type Batch = {
  id: string;
  ts: number;
  idemKey: string | null;
  tags: string[];
  deltas: { tag: string; from: number; to: number }[];
  removedKeys: string[];
  inflightKeys: string[];
  replayed: boolean;
};

export type CacheEvent = {
  seq: number;
  ts: number;
  kind:
    | 'fill-started'
    | 'fill-committed'
    | 'fill-suppressed'
    | 'fill-failed'
    | 'invalidation'
    | 'eviction'
    | 'reset'
    | 'fault'
    | 'origin-update';
  message: string;
  data?: unknown;
};

export type Stats = {
  hits: number;
  misses: number;
  joins: number;
  suppressed: number;
  fillFailures: number;
  evictions: number;
  invalidations: number;
  fillsStarted: number;
};

export type CacheState = {
  epoch: number;
  instanceId: number;
  now: number;
  capacity: number;
  stats: Stats;
  tagGenerations: Record<string, number>;
  itemGenerations: Record<string, number>;
  tags: { tag: string; generation: number; members: string[] }[];
  entries: CachedEntry[];
  inflight: { key: string; startedAt: number; delayMs: number; condition: Condition }[];
  batches: Batch[];
  events: CacheEvent[];
  consistency: {
    dangling: string[];
    unindexed: string[];
    extraIndexRefs: string[];
    generationMismatch: string[];
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function seedObjects(): OriginObject[] {
  return [
    {
      id: 'alpha',
      name: 'Primary cache simulations',
      tags: ['site', 'v3'],
      revision: 3,
      content: 'cache simulations: alpha\nstate: active',
      updatedAt: new Date(0).toISOString(),
      willFail: false,
    },
    {
      id: 'beta',
      name: 'Secondary cache simulations',
      tags: ['site', 'blog'],
      revision: 5,
      content: 'cache simulations: beta\nstate: review',
      updatedAt: new Date(1000).toISOString(),
      willFail: false,
    },
    {
      // Sits in the intersection of blog ∩ v3 — invalidating both labels must
      // remove it from both index sets in one transaction.
      id: 'gamma',
      name: 'Intersection launch notes',
      tags: ['blog', 'v3'],
      revision: 2,
      content: 'cache simulations: gamma\nstate: draft',
      updatedAt: new Date(2000).toISOString(),
      willFail: false,
    },
    {
      id: 'delta',
      name: 'Press kit',
      tags: ['press'],
      revision: 1,
      content: 'cache simulations: delta\nstate: public',
      updatedAt: new Date(3000).toISOString(),
      willFail: false,
    },
  ];
}

export function createCacheEngine(opts: { capacity?: number } = {}) {
  // --- serialized critical section -----------------------------------------
  let tail: Promise<unknown> = Promise.resolve();
  function critical<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = tail.then(fn, fn);
    // A failure must not poison the chain, but callers still receive it.
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // --- mutable state --------------------------------------------------------
  let objects = new Map<string, OriginObject>();
  let store = new Map<string, CachedEntry>();
  let index = new Map<string, Set<string>>();
  let tagGens = new Map<string, number>();
  let itemGens = new Map<string, number>();
  let inflight = new Map<string, InflightRecord>();
  let batches: Batch[] = [];
  let events: CacheEvent[] = [];
  let capacity = opts.capacity ?? 3;
  let instanceId = 0;
  let epoch = 0;
  let seq = 0;
  let batchSeq = 0;
  const stats: Stats = {
    hits: 0,
    misses: 0,
    joins: 0,
    suppressed: 0,
    fillFailures: 0,
    evictions: 0,
    invalidations: 0,
    fillsStarted: 0,
  };

  const tagGen = (tag: string) => tagGens.get(tag) ?? 1;
  const itemGen = (key: string) => itemGens.get(key) ?? 1;

  function log(kind: CacheEvent['kind'], message: string, data?: unknown) {
    events.push({ seq: ++seq, ts: Date.now(), kind, message, data });
    if (events.length > 200) events = events.slice(-200);
  }

  function reset(nextCapacity?: number) {
    objects = new Map(seedObjects().map((object) => [object.id, structuredClone(object)]));
    store = new Map();
    index = new Map();
    tagGens = new Map();
    itemGens = new Map();
    inflight = new Map();
    batches = [];
    events = [];
    seq = 0;
    batchSeq = 0;
    if (typeof nextCapacity === 'number' && nextCapacity >= 1) capacity = nextCapacity;
    instanceId += 1;
    epoch += 1;
    Object.assign(stats, {
      hits: 0,
      misses: 0,
      joins: 0,
      suppressed: 0,
      fillFailures: 0,
      evictions: 0,
      invalidations: 0,
      fillsStarted: 0,
    });
    log('reset', `缓存已重置（容量 ${capacity}）`);
    return state();
  }
  reset(opts.capacity);

  // --- origin catalog -------------------------------------------------------
  function listOrigins() {
    return [...objects.values()].map((object) => {
      const { content: _content, ...row } = object;
      return row;
    });
  }
  function getOrigin(id: string) {
    return objects.get(id);
  }
  function updateOrigin(id: string, content: string, revision: number) {
    const object = objects.get(id);
    if (!object) return { kind: 'not_found' as const };
    if (revision !== object.revision) return { kind: 'conflict' as const, current: { ...object } };
    object.content = content;
    object.revision += 1;
    object.updatedAt = new Date().toISOString();
    epoch += 1;
    log('origin-update', `回源对象 ${id} 更新至 revision ${object.revision}`);
    return { kind: 'ok' as const, object: { ...object } };
  }
  function setFault(id: string, willFail: boolean) {
    const object = objects.get(id);
    if (!object) return false;
    object.willFail = willFail;
    epoch += 1;
    log('fault', `${id} 回源故障已${willFail ? '开启' : '关闭'}`);
    return true;
  }

  // --- store helpers (call only from a critical section) --------------------
  function removeEntryAtomically(key: string, evictionReason: string): boolean {
    const entry = store.get(key);
    if (!entry) return false;
    store.delete(key);
    // Remove the key from EVERY tag set it belongs to — handling intersection
    // members by iterating the entry's own tag list is what prevents orphaning.
    for (const tag of entry.tags) {
      const members = index.get(tag);
      if (!members) continue;
      members.delete(key);
      if (members.size === 0) index.delete(tag);
    }
    itemGens.set(key, itemGen(key) + 1);
    stats.evictions += 1;
    epoch += 1;
    log('eviction', `条目 ${key} 被驱逐（${evictionReason}）`, { key, reason: evictionReason });
    return true;
  }

  function evictOldest(reason: string) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, entry] of store) {
      if (entry.storedAt < oldestAt) {
        oldestAt = entry.storedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) removeEntryAtomically(oldestKey, reason);
    return oldestKey;
  }

  // --- fill lifecycle -------------------------------------------------------
  function captureCondition(object: OriginObject): Condition {
    return {
      instanceId,
      itemGen: itemGen(object.id),
      tagGens: Object.fromEntries(object.tags.map((tag) => [tag, tagGen(tag)])),
    };
  }

  function startFill(object: OriginObject, delayMs: number): InflightRecord {
    const condition = captureCondition(object);
    const record: InflightRecord = {
      key: object.id,
      startedAt: Date.now(),
      delayMs,
      condition,
      done: null as never,
    };
    record.done = runFill(record);
    inflight.set(object.id, record);
    stats.fillsStarted += 1;
    epoch += 1;
    log('fill-started', `回源开始 ${object.id}，捕获写入条件`, {
      key: object.id,
      condition,
    });
    return record;
  }

  async function runFill(record: InflightRecord): Promise<FetchOutcome> {
    const { key, delayMs } = record;
    try {
      // Origin IO happens outside any lock; invalidations can land here.
      await sleep(delayMs);
      const origin = objects.get(key);
      if (!origin || origin.willFail) throw new Error('origin unavailable');
      const snapshot: OriginObject = { ...origin };
      return await critical(() => commitFill(record, snapshot));
    } catch {
      return await critical(() => {
        if (inflight.get(key) === record) inflight.delete(key);
        stats.fillFailures += 1;
        epoch += 1;
        log('fill-failed', `回源失败 ${key}，未写入缓存`, { key });
        return { result: 'error', error: 'origin_unavailable' } as FetchOutcome;
      });
    }
  }

  function commitFill(record: InflightRecord, origin: OriginObject): FetchOutcome {
    if (inflight.get(record.key) === record) inflight.delete(record.key);

    // A reset retired this whole cache generation: never resurrect old state.
    if (record.condition.instanceId !== instanceId) {
      stats.suppressed += 1;
      epoch += 1;
      log('fill-suppressed', `丢弃 ${record.key} 的过期回源（缓存已重置）`, { key: record.key });
      return {
        result: 'suppressed',
        object: origin,
        reason: {
          changedTags: [],
          itemGen: { from: record.condition.itemGen, to: itemGen(record.key) },
        },
      };
    }

    const changedTags = Object.entries(record.condition.tagGens)
      .map(([tag, from]) => ({ tag, from, to: tagGen(tag) }))
      .filter((delta) => delta.from !== delta.to);
    const currentItemGen = itemGen(record.key);
    const itemChanged = currentItemGen !== record.condition.itemGen;

    if (changedTags.length > 0 || itemChanged) {
      // The write condition moved while the fetch was in flight: committing
      // would resurrect just-invalidated content. Discard the body.
      stats.suppressed += 1;
      epoch += 1;
      const reason: SuppressedReason = {
        changedTags,
        itemGen: { from: record.condition.itemGen, to: currentItemGen },
      };
      log(
        'fill-suppressed',
        `丢弃 ${record.key} 的旧 generation 回源（${
          changedTags.map((d) => `${d.tag} ${d.from}→${d.to}`).join(', ') || '条目已失效'
        }）`,
        { key: record.key, captured: record.condition, reason },
      );
      return { result: 'suppressed', object: origin, reason };
    }

    // Condition still current — commit store + reverse index atomically,
    // evicting LRU entries (which clean their own index refs) for capacity.
    while (store.size >= capacity) {
      const evicted = evictOldest('lru-capacity');
      if (!evicted) break;
    }
    const entry: CachedEntry = {
      key: record.key,
      tags: [...origin.tags],
      revision: origin.revision,
      storedAt: Date.now(),
      condition: { ...record.condition, tagGens: { ...record.condition.tagGens } },
    };
    store.set(entry.key, entry);
    for (const tag of entry.tags) {
      let members = index.get(tag);
      if (!members) {
        members = new Set();
        index.set(tag, members);
      }
      members.add(entry.key);
    }
    stats.misses += 1;
    epoch += 1;
    log('fill-committed', `回源完成并写入 ${entry.key}（revision ${entry.revision}）`, {
      key: entry.key,
      condition: entry.condition,
    });
    return { result: 'miss', object: origin, entry };
  }

  function fetchObject(key: string, delayMs = 40): Promise<FetchOutcome> {
    return critical(() => {
      const object = objects.get(key);
      if (!object) return { result: 'error', error: 'not_found' } as FetchOutcome;
      const hit = store.get(key);
      if (hit) {
        stats.hits += 1;
        epoch += 1;
        const outcome: FetchOutcome = {
          result: 'hit',
          object: { ...object },
          entry: hit,
        };
        return outcome;
      }
      const flying = inflight.get(key);
      if (flying) {
        stats.joins += 1;
        epoch += 1;
        return flying;
      }
      // Return only the record from the critical section (never the fill
      // promise itself) so origin IO does not block other transactions.
      return startFill(object, Math.max(0, delayMs));
    }).then((decision) =>
      isInflightRecord(decision) ? decision.done : (decision as FetchOutcome),
    );
  }

  function isInflightRecord(value: unknown): value is InflightRecord {
    return typeof value === 'object' && value !== null && 'done' in value;
  }

  // --- invalidation ---------------------------------------------------------
  function invalidate(tagsInput: string[], idemKey?: string | null): Batch | { error: string } {
    const tags = [...new Set(tagsInput.map((tag) => String(tag).trim()).filter(Boolean))];
    if (tags.length === 0) return { error: 'tags_required' };

    // Idempotent replay: a retried batch returns the original result without
    // bumping generations or deleting anything a second time.
    if (idemKey) {
      const existing = batches.find((batch) => batch.idemKey === idemKey);
      if (existing) return { ...existing, replayed: true };
    }

    const deltas: Batch['deltas'] = [];
    const removedKeys = new Set<string>();
    const affectedInflight = new Set<string>();

    // Phase 1: advance every tag generation, collecting what they reference.
    for (const tag of tags) {
      const from = tagGen(tag);
      const to = from + 1;
      tagGens.set(tag, to);
      deltas.push({ tag, from, to });
      for (const key of index.get(tag) ?? []) removedKeys.add(key);
      for (const [key, record] of inflight) {
        if (tag in record.condition.tagGens) affectedInflight.add(key);
      }
    }

    // Phase 2: one atomic transaction removes each member from the main store
    // and from ALL of its tag sets (intersection members included).
    for (const key of removedKeys) removeEntryAtomicInvalidation(key);

    // In-flight fills for affected tags also get their item gate advanced, so
    // their completion check fails even if they only look at the item gen.
    for (const key of affectedInflight) {
      if (!removedKeys.has(key)) itemGens.set(key, itemGen(key) + 1);
    }

    const batch: Batch = {
      id: `B${++batchSeq}`,
      ts: Date.now(),
      idemKey: idemKey ?? null,
      tags,
      deltas,
      removedKeys: [...removedKeys].sort(),
      inflightKeys: [...affectedInflight].sort(),
      replayed: false,
    };
    batches.push(batch);
    if (batches.length > 100) batches = batches.slice(-100);
    stats.invalidations += 1;
    epoch += 1;
    log(
      'invalidation',
      `失效批次 ${batch.id}：${tags.join(', ')}（移除 ${removedKeys.size} 项，拦截 ${affectedInflight.size} 个在途回源）`,
      { batch },
    );
    return batch;
  }

  // Invalidated entries do not count as evictions in stats, but they still go
  // through the same atomic store+index cleanup and advance the item gen.
  function removeEntryAtomicInvalidation(key: string) {
    const entry = store.get(key);
    if (!entry) return;
    store.delete(key);
    for (const tag of entry.tags) {
      const members = index.get(tag);
      if (!members) continue;
      members.delete(key);
      if (members.size === 0) index.delete(tag);
    }
    itemGens.set(key, itemGen(key) + 1);
  }

  function evict(key?: string | null) {
    if (key) return removeEntryAtomically(key, 'manual') ? key : null;
    return evictOldest('manual');
  }

  // --- introspection --------------------------------------------------------
  function state(): CacheState {
    const knownTags = new Set<string>();
    for (const object of objects.values()) object.tags.forEach((tag) => knownTags.add(tag));
    for (const tag of tagGens.keys()) knownTags.add(tag);
    for (const tag of index.keys()) knownTags.add(tag);

    const dangling: string[] = [];
    for (const [tag, members] of index) {
      for (const key of members) {
        if (!store.has(key)) dangling.push(`${tag} → ${key}`);
      }
    }
    const unindexed: string[] = [];
    const extraIndexRefs: string[] = [];
    const generationMismatch: string[] = [];
    for (const entry of store.values()) {
      for (const tag of entry.tags) {
        if (!index.get(tag)?.has(entry.key)) unindexed.push(`${entry.key} # ${tag}`);
        if (tagGen(tag) !== entry.condition.tagGens[tag]) {
          generationMismatch.push(`${entry.key} # ${tag}`);
        }
      }
      if (itemGen(entry.key) !== entry.condition.itemGen) {
        generationMismatch.push(`${entry.key} # item`);
      }
      for (const [tag, members] of index) {
        if (members.has(entry.key) && !entry.tags.includes(tag)) {
          extraIndexRefs.push(`${entry.key} # ${tag}`);
        }
      }
    }

    return {
      epoch,
      instanceId,
      now: Date.now(),
      capacity,
      stats: { ...stats },
      tagGenerations: Object.fromEntries([...knownTags].sort().map((tag) => [tag, tagGen(tag)])),
      itemGenerations: Object.fromEntries(
        [...objects.keys()].sort().map((key) => [key, itemGen(key)]),
      ),
      tags: [...knownTags]
        .sort()
        .map((tag) => ({ tag, generation: tagGen(tag), members: [...(index.get(tag) ?? [])].sort() })),
      entries: [...store.values()]
        .map((entry) => ({
          ...entry,
          condition: { ...entry.condition, tagGens: { ...entry.condition.tagGens } },
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      inflight: [...inflight.values()]
        .map((record) => ({
          key: record.key,
          startedAt: record.startedAt,
          delayMs: record.delayMs,
          condition: { ...record.condition, tagGens: { ...record.condition.tagGens } },
        }))
        .sort((a, b) => a.startedAt - b.startedAt),
      batches: [...batches],
      events: [...events].reverse(),
      consistency: {
        dangling: dangling.sort(),
        unindexed: unindexed.sort(),
        extraIndexRefs: extraIndexRefs.sort(),
        generationMismatch: generationMismatch.sort(),
      },
    };
  }

  return {
    state,
    fetchObject,
    invalidate,
    evict,
    reset,
    listOrigins,
    getOrigin,
    updateOrigin,
    setFault,
  };
}

export type CacheEngine = ReturnType<typeof createCacheEngine>;
