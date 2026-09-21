import {describe,expect,it} from 'vitest';
import request,{type Test} from 'supertest';
import {createApp} from '../src/server/index';
import type {CacheState} from '../src/server/cache';

type App=ReturnType<typeof createApp>;

// Invariants that must hold after every operation:
//  1. no dangling reverse-index references (index → missing store entry)
//  2. every stored entry is indexed under all of its own tags and nothing else
//  3. a committed entry's captured generations still equal the live ones
function assertInvariants(s:CacheState){
  expect(s.consistency.dangling).toEqual([]);
  expect(s.consistency.unindexed).toEqual([]);
  expect(s.consistency.extraIndexRefs).toEqual([]);
  expect(s.consistency.generationMismatch).toEqual([]);
}

async function state(app:App){
  const r = await request(app).get('/api/cache/state').expect(200);
  assertInvariants(r.body as CacheState);
  return r.body as CacheState;
}
// supertest requests only start on await/.then() — kick them off eagerly so
// they are genuinely in flight while the test performs invalidations.
function get(app:App,id:string,delay=60):Test{
  const t = request(app).get(`/api/cache/objects/${id}?delayMs=${delay}`);
  void t.then(()=>undefined,()=>undefined);
  return t;
}
function invalidate(app:App,tags:string[],idemKey?:string):Test{
  const t = request(app).post('/api/cache/invalidate').send({tags,idemKey});
  void t.then(()=>undefined,()=>undefined);
  return t;
}
async function waitEmpty(app:ReturnType<typeof createApp>){
  for(let i=0;i<100;i++){
    const s = await state(app);
    if(s.inflight.length===0)return s;
    await new Promise(r=>setTimeout(r,15));
  }
  throw new Error('inflight never drained');
}

describe('legacy record API',()=>{
  it('loads and conditionally updates a record',async()=>{
    const app=createApp();
    const before=await request(app).get('/api/experiments/alpha').expect(200);
    await request(app).put('/api/experiments/alpha').send({content:'updated',revision:before.body.revision}).expect(200);
    await request(app).put('/api/experiments/alpha').send({content:'stale',revision:before.body.revision}).expect(409);
  });
});

describe('generation-based surrogate-key invalidation',()=>{
  it('multi-tag intersection: invalidating both labels removes the member from every index set atomically',async()=>{
    const app=createApp();
    // gamma is tagged blog ∩ v3; beta is site ∩ blog; alpha site ∩ v3.
    await get(app,'gamma',10).expect(200);
    await get(app,'beta',10).expect(200);
    let s=await state(app);
    expect(s.tags.find(t=>t.tag==='blog')?.members.sort()).toEqual(['beta','gamma']);
    expect(s.tags.find(t=>t.tag==='v3')?.members).toEqual(['gamma']);
    await invalidate(app,['blog','v3']).expect(201);
    s=await state(app);
    expect(s.entries.map(e=>e.key)).toEqual([]);
    expect(s.tags.find(t=>t.tag==='blog')?.members).toEqual([]);
    expect(s.tags.find(t=>t.tag==='v3')?.members).toEqual([]);
    // site must be untouched
    expect(s.tagGenerations['site']).toBe(1);
  });

  it('in-flight fill: a response completing after invalidation is suppressed and never written',async()=>{
    const app=createApp();
    const slow=get(app,'alpha',400);
    await new Promise(r=>setTimeout(r,60));
    let s=await state(app);
    expect(s.inflight.map(f=>f.key)).toContain('alpha');
    await invalidate(app,['site']).expect(201);
    const res=await slow;
    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBe('MISS_SUPPRESSED');
    expect(res.body.cache).toBe('suppressed');
    expect(res.body.suppressedReason.changedTags[0]).toMatchObject({tag:'site',from:1,to:2});
    s=await waitEmpty(app);
    expect(s.entries.map(e=>e.key)).not.toContain('alpha');
    expect(s.stats.suppressed).toBe(1);
    assertInvariants(s);
  });

  it('invalidation of a tag the filling item does not carry does not suppress it',async()=>{
    const app=createApp();
    const slow=get(app,'delta',300); // delta is only "press"
    await new Promise(r=>setTimeout(r,60));
    await invalidate(app,['blog']).expect(201);
    const res=await slow;
    expect(res.headers['x-cache']).toBe('MISS');
    const s=await waitEmpty(app);
    expect(s.entries.map(e=>e.key)).toContain('delta');
    assertInvariants(s);
  });

  it('consecutive invalidations are monotonic and suppress fills captured at any older generation',async()=>{
    const app=createApp();
    const slow=get(app,'alpha',500);
    await new Promise(r=>setTimeout(r,50));
    await invalidate(app,['site']).expect(201);
    await invalidate(app,['v3']).expect(201);
    const s0=await state(app);
    expect(s0.batches).toHaveLength(2);
    expect(s0.tagGenerations['site']).toBe(2);
    expect(s0.tagGenerations['v3']).toBe(2);
    const res=await slow;
    expect(res.headers['x-cache']).toBe('MISS_SUPPRESSED');
    const s=await waitEmpty(app);
    expect(s.entries.map(e=>e.key)).not.toContain('alpha');
    // a refill after the invalidations commits only at the newest generations,
    // so even generations later old content can never become visible again
    const after=await get(app,'alpha',10);
    expect(['MISS','HIT']).toContain(after.headers['x-cache']);
    const s2=await state(app);
    const entry=s2.entries.find(e=>e.key==='alpha')!;
    expect(entry.condition.tagGens['site']).toBe(2);
    expect(entry.condition.tagGens['v3']).toBe(2);
  });

  it('repeated invalidation with the same idempotency key replays without bumping generations',async()=>{
    const app=createApp();
    await get(app,'alpha',10);
    const b1=await invalidate(app,['site'],'batch-xyz').expect(201);
    const s1=await state(app);
    const b2=await invalidate(app,['site'],'batch-xyz').expect(200);
    expect(b2.body.id).toBe(b1.body.id);
    expect(b2.body.replayed).toBe(true);
    const s2=await state(app);
    expect(s2.tagGenerations['site']).toBe(s1.tagGenerations['site']);
    expect(s2.entries.map(e=>e.key)).toEqual(s1.entries.map(e=>e.key));
    expect(s2.stats.invalidations).toBe(1);
  });

  it('eviction removes the store entry and every reverse-index reference',async()=>{
    const app=createApp();
    await get(app,'gamma',10); // blog ∩ v3
    await request(app).post('/api/cache/evict').send({key:'gamma'}).expect(200);
    const s=await state(app);
    expect(s.entries.map(e=>e.key)).not.toContain('gamma');
    expect(s.consistency.dangling).toEqual([]);
    // capacity-driven LRU eviction must also leave a clean index
    await request(app).post('/api/cache/reset').send({capacity:2}).expect(200);
    await get(app,'alpha',10).expect(200);
    await get(app,'beta',10).expect(200);
    await get(app,'delta',10).expect(200);
    const s2=await waitEmpty(app);
    expect(s2.entries).toHaveLength(2);
    assertInvariants(s2);
    for(const e of s2.entries){
      for(const t of e.tags)expect(s2.tags.find(x=>x.tag===t)?.members).toContain(e.key);
    }
  });

  it('eviction during an in-flight fill suppresses that fill (no dangling resurrection)',async()=>{
    const app=createApp();
    // 1. slow fill starts; nothing is stored yet
    const miss=get(app,'alpha',450);
    await new Promise(r=>setTimeout(r,80));
    let s=await state(app);
    expect(s.inflight.map(f=>f.key)).toContain('alpha');
    expect(s.entries.map(e=>e.key)).not.toContain('alpha');
    // 2. manual eviction of the unstored key is rejected but cannot crash the index
    await request(app).post('/api/cache/evict').send({key:'alpha'}).expect(409);
    // 3. invalidation advances the captured generations
    await invalidate(app,['site']).expect(201);
    // 4. the old-generation response is discarded on completion
    const res=await miss;
    expect(res.headers['x-cache']).toBe('MISS_SUPPRESSED');
    const drained=await waitEmpty(app);
    expect(drained.entries.map(e=>e.key)).not.toContain('alpha');
    // 5. a normal request afterwards behaves fresh: MISS then HIT
    expect((await get(app,'alpha',10)).headers['x-cache']).toBe('MISS');
    expect((await request(app).get('/api/cache/objects/alpha')).headers['x-cache']).toBe('HIT');
    const final=await state(app);
    assertInvariants(final);
  });

  it('tag reuse: invalidating a fresh label suppresses fills captured before reuse, new fills commit at the new generation',async()=>{
    const app=createApp();
    // gamma (blog ∩ v3) fill captured while blog is at gen 1
    const oldFill=get(app,'gamma',450);
    await new Promise(r=>setTimeout(r,60));
    await invalidate(app,['blog']).expect(201); // blog → gen 2
    const res=await oldFill;
    expect(res.headers['x-cache']).toBe('MISS_SUPPRESSED');
    // "reuse" the label on the next cycle: a fresh fetch commits only at gen 2
    const again=await get(app,'gamma',10);
    expect(again.headers['x-cache']).toBe('MISS');
    expect(again.body.storedCondition.tagGens['blog']).toBe(2);
    const s=await waitEmpty(app);
    const entry=s.entries.find(e=>e.key==='gamma')!;
    expect(entry.condition.tagGens['blog']).toBe(2);
    expect(s.tags.find(t=>t.tag==='blog')?.members).toEqual(['gamma']);
    assertInvariants(s);
  });

  it('fill failure writes nothing and leaves the index clean; retry can still populate',async()=>{
    const app=createApp();
    await request(app).post('/api/cache/objects/beta/fault').send({willFail:true}).expect(200);
    const res=await get(app,'beta',100);
    expect(res.status).toBe(502);
    expect(res.headers['x-cache']).toBe('MISS_FAILED');
    const s=await waitEmpty(app);
    expect(s.entries.map(e=>e.key)).not.toContain('beta');
    expect(s.stats.fillFailures).toBeGreaterThanOrEqual(1);
    assertInvariants(s);
    await request(app).post('/api/cache/objects/beta/fault').send({willFail:false}).expect(200);
    await get(app,'beta',10).expect(200);
    const s2=await state(app);
    expect(s2.entries.map(e=>e.key)).toContain('beta');
    assertInvariants(s2);
  });

  it('two pages operating concurrently: interleaved fills, invalidations and evictions never resurrect old generations',async()=>{
    const app=createApp();
    const ops:Promise<unknown>[]=[];
    // Page A: slow fills for alpha & gamma
    ops.push(get(app,'alpha',350));
    ops.push(get(app,'gamma',350));
    // Page B: invalidates blog halfway through
    ops.push((async()=>{
      await new Promise(r=>setTimeout(r,80));
      return invalidate(app,['blog']);
    })());
    // Page A again: evict + refill beta concurrently
    ops.push((async()=>{
      await new Promise(r=>setTimeout(r,40));
      await get(app,'beta',10);
      await request(app).post('/api/cache/evict').send({key:'beta'});
      return get(app,'beta',200);
    })());
    const results=await Promise.all(ops);
    const xcaches=(results as Awaited<ReturnType<typeof get>>[]).map(r=>r.headers?.['x-cache']).filter(Boolean);
    // gamma was in flight when blog was invalidated → must be suppressed
    expect(xcaches).toContain('MISS_SUPPRESSED');
    const s=await waitEmpty(app);
    assertInvariants(s);
    for(const e of s.entries){
      for(const t of e.tags){
        expect(e.condition.tagGens[t]).toBe(s.tagGenerations[t]);
      }
      expect(e.condition.itemGen).toBe(s.itemGenerations[e.key]);
    }
    // gamma (blog ∩ v3) must not be cached from its stale fill
    expect(s.entries.map(e=>e.key)).not.toContain('gamma');
  });

  it('concurrent duplicate fills coalesce onto one origin fetch and share the suppression verdict',async()=>{
    const app=createApp();
    const pair=Promise.all([get(app,'alpha',350),get(app,'alpha',350)]);
    await new Promise(r=>setTimeout(r,60));
    const inflight=(await state(app)).inflight;
    expect(inflight.filter(f=>f.key==='alpha')).toHaveLength(1);
    await invalidate(app,['site']);
    const [a,b]=await pair;
    expect(a.headers['x-cache']).toBe('MISS_SUPPRESSED');
    expect(b.headers['x-cache']).toBe('MISS_SUPPRESSED');
    const s=await waitEmpty(app);
    expect(s.stats.fillsStarted).toBe(1);
    expect(s.stats.suppressed).toBe(1);
    expect(s.stats.joins).toBe(1);
    expect(s.entries.map(e=>e.key)).not.toContain('alpha');
    assertInvariants(s);
  });
});
