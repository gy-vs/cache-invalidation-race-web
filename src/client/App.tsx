import {useCallback, useEffect, useState} from 'react';
import {
  AlertTriangle,
  Ban,
  Database,
  FlaskConical,
  Layers,
  RefreshCw,
  Trash2,
  Zap,
} from 'lucide-react';

type Condition = {instanceId:number;itemGen:number;tagGens:Record<string,number>};
type Entry = {key:string;tags:string[];revision:number;storedAt:number;condition:Condition};
type Inflight = {key:string;startedAt:number;delayMs:number;condition:Condition};
type Batch = {
  id:string;ts:string|number;idemKey:string|null;tags:string[];
  deltas:{tag:string;from:number;to:number}[];
  removedKeys:string[];inflightKeys:string[];replayed:boolean;
};
type EventRow = {seq:number;ts:number;kind:string;message:string;data?:unknown};
type OriginRow = {id:string;name:string;tags:string[];revision:number;updatedAt:string;willFail:boolean};
type Consistency = {dangling:string[];unindexed:string[];extraIndexRefs:string[];generationMismatch:string[]};
type State = {
  epoch:number;instanceId:number;now:number;capacity:number;
  stats:{hits:number;misses:number;joins:number;suppressed:number;fillFailures:number;evictions:number;invalidations:number;fillsStarted:number};
  tagGenerations:Record<string,number>;
  itemGenerations:Record<string,number>;
  tags:{tag:string;generation:number;members:string[]}[];
  entries:Entry[];inflight:Inflight[];batches:Batch[];events:EventRow[];
  consistency:Consistency;
};

const eventTone:Record<string,string> = {
  'fill-started':'ev-muted','fill-committed':'ev-hit','fill-suppressed':'ev-supp',
  'fill-failed':'ev-fail',invalidation:'ev-inv',eviction:'ev-muted',reset:'ev-reset',
  fault:'ev-fail','origin-update':'ev-muted',
};

export default function App(){
  const [state,setState] = useState<State|null>(null);
  const [origins,setOrigins] = useState<OriginRow[]>([]);
  const [selected,setSelected] = useState('alpha');
  const [detail,setDetail] = useState<{cache:'hit'|'miss'|'suppressed';revision:number;content:string;reason?:unknown}&Record<string,unknown>|null>(null);
  const [draftTags,setDraftTags] = useState('site');
  const [idemKey,setIdemKey] = useState('');
  const [delay,setDelay] = useState(300);
  const [busy,setBusy] = useState<string|null>(null);
  const [notice,setNotice] = useState<{tone:string;text:string}|null>(null);

  const refresh = useCallback(async()=>{
    const [s,o] = await Promise.all([
      fetch('/api/cache/state').then(r=>r.json()),
      fetch('/api/experiments').then(r=>r.json()),
    ]);
    setState(s as State);
    setOrigins(o as OriginRow[]);
  },[]);

  useEffect(()=>{refresh()},[refresh]);
  // Poll fast while fills are in flight, slower when idle — two open pages
  // therefore observe each other's batches and suppressed fills live.
  useEffect(()=>{
    const active = (state?.inflight.length??0)>0;
    const id = setInterval(refresh,active?200:800);
    return ()=>clearInterval(id);
  },[refresh,state?.inflight.length,state?.instanceId]);

  async function post(path:string,body:unknown,label:string){
    setBusy(label);
    try{
      const r = await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const value = await r.json().catch(()=>({}));
      return {ok:r.ok,status:r.status,headers:r.headers,value};
    }finally{
      setBusy(null);
      await refresh();
    }
  }

  async function fill(key:string){
    setBusy('fill:'+key);
    setNotice(null);
    try{
      const r = await fetch(`/api/cache/objects/${key}?delayMs=${delay}`);
      const value = await r.json();
      const xc = r.headers.get('x-cache')??'';
      setDetail({...value,cache:value.cache ?? xc});
      if(xc==='MISS_SUPPRESSED')setNotice({tone:'supp',text:`旧 generation 回源已被丢弃（${key}），失效内容未被写回`});
      else if(xc==='MISS_FAILED')setNotice({tone:'fail',text:`${key} 回源失败，缓存未写入`});
      else if(xc==='HIT')setNotice({tone:'hit',text:`${key} 命中缓存`});
      else setNotice({tone:'miss',text:`${key} 回源完成并写入（MISS）`});
    }finally{
      setBusy(null);
      refresh();
    }
  }

  async function invalidate(){
    const tags = draftTags.split(',').map(t=>t.trim()).filter(Boolean);
    const r = await post('/api/cache/invalidate',{tags,idemKey:idemKey||undefined},'inv');
    if(r?.ok){
      const b = r.value as Batch;
      setNotice(b.replayed
        ?{tone:'muted',text:`批次 ${b.id} 幂等重放：generation 未变化，无重复删除`}
        :{tone:'inv',text:`批次 ${b.id} 失效 ${b.tags.join('、')}；移除 ${b.removedKeys.length} 项，标记 ${b.inflightKeys.length} 个在途回源`});
    }
  }

  async function evict(key:string|null){
    const r = await post('/api/cache/evict',key?{key}:{},'evict');
    if(r&&!r.ok)setNotice({tone:'fail',text:key?`${key} 当前不在缓存中`:'缓存为空，无可驱逐项'});
  }
  async function resetAll(){
    await post('/api/cache/reset',{},'reset');
    setDetail(null);setNotice({tone:'muted',text:'实验台已重置'});
  }
  async function toggleFault(o:OriginRow){
    await post(`/api/cache/objects/${o.id}/fault`,{willFail:!o.willFail},'fault');
  }

  const consistent = state && ['dangling','unindexed','extraIndexRefs','generationMismatch']
    .every(k=>state.consistency[k as keyof Consistency].length===0);
  const origin = origins.find(o=>o.id===selected);

  return <main className="shell">
    <header className="topbar">
      <FlaskConical size={20}/><strong>HTTP 缓存失效实验台</strong>
      <small>surrogate key · generation 写入条件 · 原子主存/索引更新</small>
      <span className="spacer"/>
      <span className={consistent?'badge ok':'badge bad'}>
        {consistent?'索引一致':<><AlertTriangle size={13}/>索引异常</>}
      </span>
      <button className="ghost" onClick={resetAll} disabled={busy!==null}><RefreshCw size={14}/>重置</button>
    </header>

    {notice&&<div className={`notice ${notice.tone}`} onClick={()=>setNotice(null)}>{notice.text}</div>}

    <section className="workspace">
      {/* left: origin objects + controls */}
      <aside className="pane">
        <h2><Database size={15}/>回源对象</h2>
        <div className="ctl">
          <label>回源延迟 <b>{delay}ms</b></label>
          <input type="range" min={20} max={2000} step={20} value={delay} onChange={e=>setDelay(Number(e.target.value))}/>
        </div>
        <div className="list">
          {origins.map(o=>(
            <button key={o.id} className={o.id===selected?'active item':'item'} onClick={()=>setSelected(o.id)}>
              <span className="row1"><b>{o.id}</b>{o.willFail&&<span className="fault"><Ban size={12}/>故障</span>}</span>
              <span className="muted">{o.name}</span>
              <span className="tags">{o.tags.map(t=><em key={t}>{t}</em>)}</span>
              <span className="row-actions">
                <button className="mini primary" disabled={busy!==null} onClick={e=>{e.stopPropagation();fill(o.id)}}><Zap size={12}/>{busy==='fill:'+o.id?'回源中…':'获取'}</button>
                <button className="mini" onClick={e=>{e.stopPropagation();toggleFault(o)}}>{o.willFail?'恢复':'故障'}</button>
              </span>
            </button>
          ))}
        </div>
        <div className="evict-row">
          <button className="mini" disabled={busy!==null||!state?.entries.length} onClick={()=>evict(null)}><Trash2 size={12}/>LRU 驱逐一项</button>
          <span className="muted">缓存容量 {state?.capacity}</span>
        </div>
      </aside>

      {/* middle: cache + invalidation */}
      <section className="pane middle">
        <h2><Layers size={15}/>缓存状态与失效控制</h2>

        <div className="grid2">
          <div className="card">
            <h3>缓存条目（主存）</h3>
            {state?.entries.length===0&&<p className="muted">主存为空</p>}
            {state?.entries.map(e=>(
              <div className="entry" key={e.key}>
                <div className="row1"><b>{e.key}</b><span className="gen">item#{e.condition.itemGen}</span>
                  <span className="muted">rev {e.revision}</span>
                  <button className="mini x" disabled={busy!==null} onClick={()=>evict(e.key)}>驱逐</button>
                </div>
                <div className="tags">{e.tags.map(t=>{
                  const liveGen = state.tagGenerations[t];
                  const stale = e.condition.tagGens[t]!==liveGen;
                  return <em key={t} className={stale?'stale':''}>{t}@{e.condition.tagGens[t]}{stale&&' ✗'}</em>;
                })}</div>
              </div>
            ))}
          </div>
          <div className="card">
            <h3>反向标签索引 → 成员</h3>
            {state?.tags.map(t=>(
              <div className="idxrow" key={t.tag}>
                <em>{t.tag}</em><span className="gen">gen {t.generation}</span>
                <span className="members">{t.members.length?t.members.join(', '):<i className="muted">∅</i>}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card inflight-card">
          <h3>在途回源</h3>
          {!state||state.inflight.length===0
            ? <p className="muted">无在途请求</p>
            : state.inflight.map(f=>(
              <div className="inflight" key={f.key}>
                <RefreshCw size={13} className="spin"/>
                <b>{f.key}</b>
                <span className="muted">捕获条件：item#{f.condition.itemGen} · {Object.entries(f.condition.tagGens).map(([t,g])=>`${t}@${g}`).join(' ')}</span>
                <span className="muted">延迟 {f.delayMs}ms</span>
              </div>
            ))}
        </div>

        <div className="card inv-card">
          <h3>按 surrogate key 失效</h3>
          <div className="inv-form">
            <input value={draftTags} onChange={e=>setDraftTags(e.target.value)} placeholder="标签，逗号分隔，如 blog, v3"/>
            <input className="idem" value={idemKey} onChange={e=>setIdemKey(e.target.value)} placeholder="幂等键（可选，重放同批次）"/>
            <button className="primary" disabled={busy!==null||!draftTags.trim()} onClick={invalidate}>失效这批标签</button>
          </div>
          <p className="hint">多标签交集项会在同一事务内从所有标签集合删除；在途回源完成时若 generation 已变将被丢弃。</p>
        </div>

        {state&&!consistent&&<div className="consistency-errors">
          <AlertTriangle size={14}/> 一致性检查失败：{JSON.stringify(state.consistency)}
        </div>}
      </section>

      {/* right: batches, suppressed fills, events */}
      <aside className="pane right">
        <h2>失效批次 / 事件流</h2>
        <div className="statline">
          <span><b>{state?.stats.hits??0}</b>HIT</span>
          <span><b>{state?.stats.misses??0}</b>MISS</span>
          <span className="supp"><b>{state?.stats.suppressed??0}</b>被抑制填充</span>
          <span><b>{state?.stats.fillFailures??0}</b>失败</span>
          <span><b>{state?.stats.evictions??0}</b>驱逐</span>
        </div>

        <h3>失效批次</h3>
        {state?.batches.length===0&&<p className="muted">尚无批次</p>}
        <div className="batches">
          {state?.batches.map(b=>(
            <div key={b.id+b.ts} className={`batch ${b.replayed?'replayed':''}`}>
              <div className="row1"><b>{b.id}</b>{b.replayed&&<span className="tag-pill replay">幂等重放</span>}
                <span className="muted">{b.tags.map(t=>`${t}@${state.tagGenerations[t]}`).join(' ')}</span>
              </div>
              <div className="muted small">
                删除 {b.removedKeys.length?b.removedKeys.join(', '):'无'}
                {b.inflightKeys.length>0&&<> · 抑制在途 {b.inflightKeys.join(', ')}</>}
              </div>
            </div>
          ))}
        </div>

        <h3>最近响应</h3>
        {detail?<pre className="detail">{JSON.stringify(detail,null,2)}</pre>:<p className="muted">点击“获取”查看响应头 x-cache 与抑制原因</p>}

        <h3>事件流</h3>
        <div className="events">
          {state?.events.slice(0,40).map(ev=>(
            <div key={ev.seq} className={`event ${eventTone[ev.kind]??''}`}>
              <span className="evkind">{ev.kind}</span>{ev.message}
            </div>
          ))}
        </div>
        <p className="muted small">打开两个页面同时操作：彼此的批次、驱逐与被抑制填充会实时出现（{origin?`当前选中 ${origin.id}`:''}）。</p>
      </aside>
    </section>
  </main>;
}
