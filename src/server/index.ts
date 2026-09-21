import express from 'express';
import {fileURLToPath} from 'node:url';
import {CacheStore, HttpError} from './cache.js';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary cache simulations',revision:3,content:'cache simulations: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary cache simulations',revision:5,content:'cache simulations: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

export function createApp(options:{capacity?:number}={}){
  const app=express();
  const cache=new CacheStore({capacity:options.capacity});
  app.use(express.json({limit:'1mb'}));

  app.get('/api/bootstrap',(_req,res)=>res.json({family:"http-cache",count:rows.length}));
  app.get('/api/experiments',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/experiments/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/experiments/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/experiments/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});

  // ---- HTTP cache with surrogate-key invalidation -------------------------

  /** Full cache + reverse index state for the workbench UI / invariants. */
  app.get('/api/cache/state',(_req,res)=>res.json(cache.snapshot()));

  /** Read-through fetch. Header X-Cache-Status: HIT | MISS | SUPPRESSED | FAIL */
  app.get('/api/cache/:key',async(req,res,next)=>{
    try{
      const query=req.query;
      const result=await cache.fetch(req.params.key,{
        delayMs:query.delay!==undefined?Number(query.delay):undefined,
        fail:query.fail==='1'||query.fail==='true',
        refresh:query.refresh==='1'||query.refresh==='true',
      });
      res.set('X-Cache-Status',result.status);
      if(result.status==='HIT'||result.status==='MISS'){
        const {entry}=result;
        res.set('ETag',`"${entry.originRev}"`);
        res.set('Surrogate-Key',entry.tags.join(' '));
        res.set('X-Fill-Id',entry.fillId);
        res.json({key:entry.key,body:entry.body,tags:entry.tags,originRev:entry.originRev,
          fillId:entry.fillId,cacheStatus:result.status,
          writeCondition:{itemGeneration:entry.itemGeneration,tagGenerations:entry.tagGenerations}});
      }else if(result.status==='SUPPRESSED'){
        // Origin bytes delivered to this request only; the write-back was dropped.
        res.set('X-Fill-Id',result.fillId);
        res.json({key:result.key,body:result.origin.body,tags:result.origin.tags,originRev:result.origin.rev,
          fillId:result.fillId,cacheStatus:'SUPPRESSED',suppressedReason:result.reason,
          note:'origin bytes served to this request; write-back discarded because a captured generation moved'});
      }else{
        res.status(502).json({key:result.key,cacheStatus:'FAIL',fillId:result.fillId,error:result.error});
      }
    }catch(error){
      if(error instanceof HttpError)return res.status(error.status).json({error:error.code});
      next(error);
    }
  });

  /** Invalidate by surrogate tags and/or explicit cache keys (idempotent batch). */
  app.post('/api/cache/invalidate',async(req,res)=>{
    const body=req.body??{};
    const batch=await cache.invalidate({tags:body.tags,keys:body.keys,batchId:body.batchId});
    res.status(200).json({...batch,duplicated:batch.duplicated});
  });

  /** Evict a single entry (LRU-style manual eviction). */
  app.post('/api/cache/:key/evict',async(req,res)=>{
    const removed=await cache.evict(req.params.key);
    res.json({key:req.params.key,removed});
  });

  /** Publish origin changes: new body and/or surrogate tags (tag reuse demo). */
  app.post('/api/cache/:key/origin',(req,res)=>{
    const body=req.body??{};
    const origin=cache.upsertOrigin(req.params.key,{body:body.body,tags:body.tags});
    res.json(origin);
  });

  /** Toggle simulated origin failure for a key (fill failure demo). */
  app.post('/api/cache/:key/fail-mode',(req,res)=>{
    cache.setOriginFailure(req.params.key,Boolean(req.body?.failing));
    res.json({key:req.params.key,failing:Boolean(req.body?.failing)});
  });

  app.post('/api/cache/config/capacity',async(req,res)=>{
    const capacity=Math.max(1,Math.floor(Number(req.body?.capacity)||cache.capacity));
    await cache.setCapacity(capacity);
    res.json({capacity:cache.capacity});
  });

  app.post('/api/cache/reset',(_req,res)=>{cache.reset();res.json({ok:true})});

  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
