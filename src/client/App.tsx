import {useCallback, useEffect, useRef, useState} from 'react';
import {
  Activity, AlertTriangle, Ban, CheckCircle2, Database, Eraser, FlaskConical,
  Layers, RefreshCw, Send, ShieldAlert, Tags, Zap,
} from 'lucide-react';

type OriginRecord = { key: string; body: string; tags: string[]; rev: number; updatedAt: string };
type Entry = {
  key: string; body: string; tags: string[]; originRev: number;
  itemGeneration: number; tagGenerations: Record<string, number>;
  fillId: string; cachedAt: string; lastAccessAt: string; ageMs: number; hits: number; size: number;
};
type InFlight = {
  fillId: string; key: string; startedAt: string; elapsedMs: number; delayMs: number;
  snapshot: { itemGeneration: number; tags: string[]; tagGenerations: Record<string, number> };
};
type Batch = {
  id: string; at: number; tags: string[]; keys: string[]; affectedKeys: string[];
  generations: Record<string, number>; duplicateCount: number;
};
type FillEvent = {
  fillId: string; at: number; key: string; status: 'stored' | 'suppressed' | 'failed';
  reason?: string; durationMs: number; originRev?: number;
  snapshot?: { itemGeneration: number; tagGenerations: Record<string, number> };
};
type Eviction = { at: number; key: string; reason: 'manual' | 'capacity' };
type Snapshot = {
  capacity: number; size: number; origins: OriginRecord[]; failingKeys: string[];
  entries: Entry[]; tagIndex: Record<string, string[]>;
  tagGenerations: Record<string, number>; itemGenerations: Record<string, number>;
  inFlight: InFlight[]; batches: Batch[]; fills: FillEvent[]; evictions: Eviction[];
  invariant: { ok: boolean; danglingReferences: string[]; missingReferences: string[]; staleEntries: string[] };
};

type Toast = { id: number; kind: 'hit' | 'miss' | 'suppressed' | 'failed' | 'info'; text: string };

const POLL_MS = 800;

function ago(ms: number): string {
  if (ms < 1000) return `${ms}ms ago`;
  return `${Math.round(ms / 100) / 10}s ago`;
}

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [tagsInput, setTagsInput] = useState('news');
  const [keysInput, setKeysInput] = useState('');
  const [batchInput, setBatchInput] = useState('');
  const [capacityInput, setCapacityInput] = useState('8');
  const [edits, setEdits] = useState<Record<string, { body: string; tags: string }>>({});
  const [busy, setBusy] = useState(false);
  const toastSeq = useRef(0);

  const pushToast = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++toastSeq.current;
    setToasts(prev => [...prev.slice(-4), {id, kind, text}]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/cache/state');
      setSnap(await response.json());
    } catch {
      /* transient poll error */
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  async function run(action: () => Promise<Response>, done?: (value: Response) => void) {
    setBusy(true);
    try {
      const response = await action();
      done?.(response);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function fetchKey(key: string) {
    // Simulated round trip: long enough for the user to invalidate mid-flight.
    run(
      () => fetch(`/api/cache/${key}?delay=1200`),
      async response => {
        if (response.status === 502) {
          const body = await response.json();
          pushToast('failed', `Origin fill FAILED for ${key} (${body.error}) — nothing written`);
          return;
        }
        const body = await response.json();
        if (body.cacheStatus === 'HIT') pushToast('hit', `HIT ${key} rev ${body.originRev}`);
        else if (body.cacheStatus === 'MISS') pushToast('miss', `MISS ${key}: fill ${body.fillId} stored`);
        else pushToast('suppressed', `SUPPRESSED ${key}: fill ${body.fillId} discarded (${body.suppressedReason})`);
      },
    );
  }

  function invalidate() {
    const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);
    const keys = keysInput.split(',').map(k => k.trim()).filter(Boolean);
    run(
      () => fetch('/api/cache/invalidate', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({tags, keys, batchId: batchInput.trim() || undefined}),
      }),
      async response => {
        const body = await response.json();
        if (body.duplicated) {
          pushToast('info', `Batch ${body.id} replay — idempotent, generations unchanged (dup #${body.duplicateCount})`);
        } else {
          pushToast('info', `Batch ${body.id}: evicted [${body.affectedKeys.join(', ') || 'none'}]${
            tags.length ? ` tag gens ${tags.map(t => `${t}=${body.generations[t]}`).join(' ')}` : ''}`);
        }
      },
    );
  }

  function evict(key: string) {
    run(() => fetch(`/api/cache/${key}/evict`, {method: 'POST'}), async response => {
      const body = await response.json();
      pushToast(body.removed ? 'info' : 'hit', `Evict ${key}: ${body.removed ? 'removed, item gen bumped' : 'not cached'}`);
    });
  }

  function toggleFail(origin: OriginRecord) {
    const failing = !snap?.failingKeys.includes(origin.key);
    run(
      () => fetch(`/api/cache/${origin.key}/fail-mode`, {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({failing}),
      }),
      () => pushToast('info', `Origin ${origin.key} failure simulation ${failing ? 'ON' : 'OFF'}`),
    );
  }

  function publishOrigin(origin: OriginRecord) {
    const edit = edits[origin.key];
    const tags = (edit?.tags ?? origin.tags.join(', ')).split(',').map(t => t.trim()).filter(Boolean);
    run(
      () => fetch(`/api/cache/${origin.key}/origin`, {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({body: edit?.body ?? origin.body, tags}),
      }),
      () => pushToast('info', `Origin ${origin.key} published rev ${origin.rev + 1} with tags [${tags.join(', ')}] — refresh to revalidate`),
    );
  }

  function setCapacity() {
    run(
      () => fetch('/api/cache/config/capacity', {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({capacity: Number(capacityInput)}),
      }),
      () => pushToast('info', `Cache capacity set to ${capacityInput} (LRU eviction if exceeded)`),
    );
  }

  function reset() {
    run(() => fetch('/api/cache/reset', {method: 'POST'}), () => pushToast('info', 'Workbench reset'));
  }

  const editFor = (origin: OriginRecord) => edits[origin.key] ?? {body: origin.body, tags: origin.tags.join(', ')};
  const fillIcon = (status: FillEvent['status']) =>
    status === 'stored' ? <CheckCircle2 size={13} className="ok"/> :
    status === 'suppressed' ? <ShieldAlert size={13} className="warn"/> : <Ban size={13} className="bad"/>;

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20}/>
        <strong>HTTP Cache Lab</strong>
        <small>Surrogate-key generations &amp; in-flight fill guard</small>
        <span className="spacer"/>
        {snap && (
          <span className={snap.invariant.ok ? 'badge badge-ok' : 'badge badge-bad'}>
            {snap.invariant.ok ? <CheckCircle2 size={14}/> : <AlertTriangle size={14}/>}
            {snap.invariant.ok ? 'index consistent' : 'invariant violated'}
          </span>
        )}
        <span className="badge badge-dim"><Database size={13}/>{snap?.size ?? 0}/{snap?.capacity ?? 8} entries</span>
        <span className="badge badge-dim"><Activity size={13}/>{snap?.inFlight.length ?? 0} in-flight</span>
        <button className="ghost" onClick={refresh} disabled={busy}><RefreshCw size={14}/>Refresh</button>
      </header>

      <section className="grid">
        {/* ---- origins & entries ------------------------------------------ */}
        <div className="col">
          <h2><Layers size={15}/>Origin keys / cache entries</h2>
          {snap?.origins.map(origin => {
            const entry = snap.entries.find(e => e.key === origin.key);
            const edit = editFor(origin);
            const failing = snap.failingKeys.includes(origin.key);
            return (
              <article key={origin.key} className={'card' + (entry ? '' : ' uncached') + (failing ? ' failing' : '')}>
                <div className="card-head">
                  <strong>{origin.key}</strong>
                  <span className="taglist">
                    {origin.tags.map(tag => <em key={tag} className="chip">{tag}</em>)}
                  </span>
                  <span className={entry ? 'status-dot hit' : 'status-dot miss'} title={entry ? 'cached' : 'not cached'}/>
                </div>
                <div className="gen-row">
                  <span>item gen <b>{snap.itemGenerations[origin.key] ?? 0}</b></span>
                  <span>origin rev <b>{origin.rev}</b></span>
                  {entry && <span>stored gen <b>{entry.itemGeneration}</b></span>}
                  {entry && <span>hits <b>{entry.hits}</b></span>}
                  {entry && <span>{ago(entry.ageMs)}</span>}
                </div>
                {entry && (
                  <div className="cond">
                    write condition captured by {entry.fillId}:
                    {' '}{entry.tags.map(t => `${t}=${entry.tagGenerations[t]}`).join(' ')}
                  </div>
                )}
                <textarea
                  aria-label={`${origin.key} body`}
                  value={edit.body}
                  onChange={event => setEdits(prev => ({
                    ...prev, [origin.key]: {...editFor(origin), body: event.target.value},
                  }))}
                  rows={2}
                />
                <label className="field">
                  surrogate tags
                  <input
                    value={edit.tags}
                    onChange={event => setEdits(prev => ({
                      ...prev, [origin.key]: {...editFor(origin), tags: event.target.value},
                    }))}
                  />
                </label>
                <div className="btnrow">
                  <button onClick={() => fetchKey(origin.key)}><Send size={13}/>Fetch (1.2s origin)</button>
                  <button onClick={() => evict(origin.key)} disabled={!entry}><Eraser size={13}/>Evict</button>
                  <button onClick={() => publishOrigin(origin)}><Zap size={13}/>Publish origin</button>
                  <button className={failing ? 'on' : ''} onClick={() => toggleFail(origin)}>
                    <Ban size={13}/>{failing ? 'failure ON' : 'simulate failure'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>

        {/* ---- control + fills ------------------------------------------- */}
        <div className="col">
          <h2><Tags size={15}/>Invalidation batch</h2>
          <div className="card panel">
            <label className="field">
              surrogate tags (comma separated)
              <input value={tagsInput} onChange={e => setTagsInput(e.target.value)} placeholder="news, sports"/>
            </label>
            <label className="field">
              explicit cache keys (comma separated)
              <input value={keysInput} onChange={e => setKeysInput(e.target.value)} placeholder="alpha, delta"/>
            </label>
            <label className="field">
              batch id <small>(same id replays idempotently)</small>
              <input value={batchInput} onChange={e => setBatchInput(e.target.value)} placeholder="auto-generated"/>
            </label>
            <button className="primary wide" onClick={invalidate} disabled={busy}>
              <Zap size={14}/>Invalidate
            </button>
            <p className="hint">
              Invalidating a tag bumps its generation and atomically removes the main-store entry and
              <strong> every</strong> reverse-index reference of each affected key. A fill in flight whose captured
              generation changed is discarded on commit.
            </p>
          </div>

          <div className="card panel compact">
            <div className="inline">
              <label className="field">capacity
                <input value={capacityInput} onChange={e => setCapacityInput(e.target.value)} inputMode="numeric"/>
              </label>
              <button onClick={setCapacity}>Apply LRU cap</button>
              <button className="danger" onClick={reset}><Eraser size={13}/>Reset</button>
            </div>
          </div>

          <h2><Activity size={15}/>Fills</h2>
          <div className="card panel">
            <h3>In flight — write conditions captured at start</h3>
            {snap && snap.inFlight.length === 0 && <p className="muted">none</p>}
            {snap?.inFlight.map(fill => (
              <div key={fill.fillId} className="event inflight">
                <Activity size={13} className="spin"/>
                <b>{fill.key}</b> {fill.fillId}
                <span className="muted">{fill.elapsedMs}/{fill.delayMs}ms</span>
                <code>
                  item={fill.snapshot.itemGeneration}{' '}
                  {fill.snapshot.tags.map(t => `${t}=${fill.snapshot.tagGenerations[t]}`).join(' ')}
                </code>
              </div>
            ))}
            <h3>Completed fills — suppressed write-backs highlighted</h3>
            {snap?.fills.map(fill => (
              <div key={fill.fillId + fill.at} className={`event fill-${fill.status}`}>
                {fillIcon(fill.status)}
                <span className="ev-key">{fill.key}</span>
                <span className={`pill fill-pill-${fill.status}`}>{fill.status}</span>
                <span className="muted">{fill.durationMs}ms</span>
                {fill.reason && <code>{fill.reason}</code>}
                {fill.status === 'stored' && <code>rev {fill.originRev}</code>}
              </div>
            ))}
            {snap && snap.fills.length === 0 && <p className="muted">no fills yet</p>}
          </div>
        </div>

        {/* ---- index + batches ------------------------------------------- */}
        <div className="col">
          <h2><Database size={15}/>Reverse tag index &amp; generations</h2>
          <div className="card panel">
            {snap && Object.keys(snap.tagIndex).length === 0 && <p className="muted">index empty</p>}
            {snap && Object.entries(snap.tagIndex).map(([tag, keys]) => {
              const stale = keys.some(k => {
                const entry = snap.entries.find(e => e.key === k);
                return !entry || entry.tagGenerations[tag] !== snap.tagGenerations[tag];
              });
              return (
                <div key={tag} className="index-row">
                  <em className="chip">{tag}</em>
                  <b>gen {snap.tagGenerations[tag] ?? 0}</b>
                  {stale && <AlertTriangle size={13} className="bad"/>}
                  <span className="index-keys">{keys.join(', ')}</span>
                </div>
              );
            })}
            {snap && (
              <>
                <h3>All known tag generations</h3>
                <div className="gen-cloud">
                  {Object.entries(snap.tagGenerations).map(([tag, gen]) => (
                    <span key={tag} className="chip">{tag}:{gen}</span>
                  ))}
                </div>
              </>
            )}
          </div>

          <h2><ShieldAlert size={15}/>Invalidation batches</h2>
          <div className="card panel">
            {snap && snap.batches.length === 0 && <p className="muted">no batches yet</p>}
            {snap?.batches.map(batch => (
              <div key={batch.id} className="batch">
                <div className="batch-head">
                  <b>{batch.id}</b>
                  <span className="muted">{timeOf(batch.at)}</span>
                  {batch.duplicateCount > 0 && <span className="pill dup">replayed ×{batch.duplicateCount}</span>}
                </div>
                <div className="muted">
                  tags [{batch.tags.join(', ') || '—'}] · keys [{batch.keys.join(', ') || '—'}]
                </div>
                <div>
                  affected <b>[{batch.affectedKeys.join(', ') || 'none'}]</b>
                </div>
                <code>{batch.tags.map(t => `${t}=${batch.generations[t]}`).join(' ') || 'no tag gens'}</code>
              </div>
            ))}
          </div>

          <h2><Eraser size={15}/>Evictions</h2>
          <div className="card panel">
            {snap && snap.evictions.length === 0 && <p className="muted">none</p>}
            {snap?.evictions.slice(0, 8).map((eviction, i) => (
              <div key={i} className="event">
                <Eraser size={13}/><b>{eviction.key}</b>
                <span className={`pill ${eviction.reason === 'capacity' ? 'fill-pill-suppressed' : ''}`}>{eviction.reason}</span>
                <span className="muted">{timeOf(eviction.at)}</span>
              </div>
            ))}
          </div>

          {snap && !snap.invariant.ok && (
            <div className="card panel violation">
              <h3><AlertTriangle size={14}/>Invariant violation</h3>
              <ul>
                {snap.invariant.danglingReferences.map((v, i) => <li key={'d' + i}>dangling: {v}</li>)}
                {snap.invariant.missingReferences.map((v, i) => <li key={'m' + i}>missing: {v}</li>)}
                {snap.invariant.staleEntries.map((v, i) => <li key={'s' + i}>stale: {v}</li>)}
              </ul>
            </div>
          )}
        </div>
      </section>

      <div className="toasts">
        {toasts.map(toast => (
          <div key={toast.id} className={`toast toast-${toast.kind}`}>{toast.text}</div>
        ))}
      </div>
    </main>
  );
}
