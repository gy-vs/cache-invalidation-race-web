import express from 'express';
import {fileURLToPath} from 'node:url';
import {createCacheEngine, type FetchOutcome} from './cache';

export function createApp(){
  const app=express();
  const cache = createCacheEngine({capacity:3});
  app.use(express.json({limit:'1mb'}));

  // --- legacy record endpoints (kept compatible) ---------------------------
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"http-cache",count:cache.listOrigins().length}));
  app.get('/api/experiments',(_req,res)=>res.json(cache.listOrigins()));
  app.get('/api/experiments/:id',(req,res)=>{
    const row=cache.getOrigin(req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    res.set('ETag',String(row.revision)).json(row);
  });
  app.put('/api/experiments/:id',(req,res)=>{
    const before=cache.getOrigin(req.params.id);
    if(!before)return res.status(404).json({error:'not_found'});
    const outcome=cache.updateOrigin(req.params.id,String(req.body.content??''),Number(req.body.revision));
    if(outcome.kind==='not_found')return res.status(404).json({error:'not_found'});
    if(outcome.kind==='conflict')return res.status(409).json({error:'revision_conflict',current:outcome.current});
    res.json(outcome.object);
  });
  app.post('/api/experiments/:id/analyze',async(req,res)=>{
    const row=cache.getOrigin(req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));
    res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]});
  });

  // --- cache workbench endpoints -------------------------------------------
  app.get('/api/cache/state',(_req,res)=>res.json(cache.state()));

  // GET through the cache: HIT / MISS / MISS_SUPPRESSED / MISS_FAILED.
  // delayMs only applies to an actual origin fetch, not to hits or coalesced joins.
  app.get('/api/cache/objects/:id',async(req,res)=>{
    const delay = clampInt(req.query.delayMs, 0, 10000, 60);
    if(!cache.getOrigin(req.params.id))return res.status(404).json({error:'not_found'});
    const outcome: FetchOutcome = await cache.fetchObject(req.params.id,delay);
    respondWithOutcome(res,outcome);
  });

  // Surrogate-key invalidation batch. Idempotent via ?idemKey=.
  app.post('/api/cache/invalidate',(req,res)=>{
    const tags = Array.isArray(req.body?.tags)
      ? req.body.tags.map((tag:unknown)=>String(tag))
      : typeof req.body?.tags==='string'
        ? req.body.tags.split(',').map((tag:string)=>tag.trim())
        : [];
    const idemKey = typeof req.body?.idemKey==='string'&&req.body.idemKey?req.body.idemKey:null;
    const result = cache.invalidate(tags,idemKey);
    if('error' in result)return res.status(400).json(result);
    res.status(result.replayed?200:201).json(result);
  });

  app.post('/api/cache/evict',(req,res)=>{
    const key = typeof req.body?.key==='string'?req.body.key:null;
    if(key&&!cache.getOrigin(key))return res.status(404).json({error:'not_found'});
    const evicted = cache.evict(key);
    if(!evicted&&key)return res.status(409).json({error:'not_cached',key});
    res.json({evicted:evicted ?? null,state:cache.state()});
  });

  app.post('/api/cache/reset',(req,res)=>{
    const capacity = typeof req.body?.capacity==='number'?req.body.capacity:undefined;
    res.json(cache.reset(capacity));
  });

  app.put('/api/cache/objects/:id',(req,res)=>{
    const outcome = cache.updateOrigin(
      req.params.id,
      String(req.body?.content??''),
      Number(req.body?.revision),
    );
    if(outcome.kind==='not_found')return res.status(404).json({error:'not_found'});
    if(outcome.kind==='conflict')return res.status(409).json({error:'revision_conflict',current:outcome.current});
    res.json(outcome.object);
  });

  app.post('/api/cache/objects/:id/fault',(req,res)=>{
    const ok = cache.setFault(req.params.id,Boolean(req.body?.willFail));
    if(!ok)return res.status(404).json({error:'not_found'});
    res.json({id:req.params.id,willFail:Boolean(req.body?.willFail)});
  });

  return app;
}

function clampInt(value:unknown,min:number,max:number,fallback:number){
  const n=Number(value);
  if(!Number.isFinite(n))return fallback;
  return Math.min(max,Math.max(min,Math.trunc(n)));
}

function respondWithOutcome(res:express.Response,outcome:FetchOutcome){
  if(outcome.result==='error'){
    return res.status(502).set('x-cache','MISS_FAILED').json({error:outcome.error});
  }
  if(outcome.result==='suppressed'){
    return res
      .set('x-cache','MISS_SUPPRESSED')
      .set('x-cache-key',outcome.object.id)
      .json({...outcome.object,cache:'suppressed',suppressedReason:outcome.reason});
  }
  res
    .set('x-cache',outcome.result==='hit'?'HIT':'MISS')
    .set('x-cache-key',outcome.object.id)
    .json({...outcome.object,cache:outcome.result,storedCondition:outcome.entry.condition});
}

if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
