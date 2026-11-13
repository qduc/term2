#!/usr/bin/env python3
"""Independent settled-evidence audit; no provider calls."""
import sys,json,pathlib,hashlib,datetime,collections,re
root=pathlib.Path(sys.argv[1]);wire=root/'wire-live'
if (wire/'active.lock').exists():raise SystemExit('Refusing final audit while coordinator active')
ledger=json.loads((wire/'ledger.json').read_text());protocol=json.loads((root/'protocol.json').read_text())
errors=[];runs={};totalnano=0;uncertain=0
fail=lambda cond,msg:errors.append(msg) if not cond else None
seen=set();calls={};ret=[];previousPhysicalFinished=None
for e in ledger:
 i=e['id'];run=e['runId'];aff=run.endswith('-affinity')
 if previousPhysicalFinished is not None:fail(e['startedAt']>=previousPhysicalFinished,'overlapping physical dispatch '+i)
 previousPhysicalFinished=e.get('finishedAt')
 fail(i not in seen,'duplicate physical id '+i);seen.add(i)
 b=json.loads((wire/(i+'-request.json')).read_text());events=json.loads((wire/(i+'-response.json')).read_text())
 term=[x['response'] for x in events if x.get('type') in ['response.completed','response.failed','response.incomplete']]
 fail(len(term)==1,'terminal event count '+i)
 if len(term)!=1:uncertain+=e['reservedUsd'];continue
 t=term[0];u=t.get('usage');fail(u==e.get('usage'),'usage mismatch '+i)
 fail(e.get('requestSha256')==e.get('outgoingBodySha256'),'relay body altered '+i)
 fail(hashlib.sha256(json.dumps(b,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()==e.get('requestSha256'),'retained body cannot reconstruct raw hash '+i)
 hin=e.get('incomingHeaders',{});hout=e.get('outgoingHeaders',{})
 fail('session-id' not in hin,'ambient affinity '+i)
 fail(hout.get('session-id')==(b.get('prompt_cache_key') if aff else None),'header treatment '+i)
 fail({k:v for k,v in hout.items() if k!='session-id'}==hin,'other header altered '+i)
 fail(b.get('model')=='gpt-6-luna' and b.get('stream') is True and b.get('max_output_tokens')==32000,'model/transport/output '+i)
 fail(b.get('reasoning',{}).get('effort')=='medium','effort '+i)
 fail('store' not in b,'store '+i)
 configs=[x for x in b.get('input',[]) if x.get('type')=='configuration_update']
 fail(len(configs)==1 and configs[0].get('reasoning',{}).get('effort')=='medium','native effort '+i)
 r=runs.setdefault(run,{'runId':run,'arm':'affinity' if aff else 'baseline','requests':0,'input':0,'fresh':0,'cacheRead':0,'cacheWrite':0,'output':0,'nanoUsd':0,'largestContext':0,'zeroReadContinuations':[],'gapsMs':[],'httpMs':0,'toolCalls':0,'requestedUnsandboxedShellCalls':0,'sandboxMissingDependencyResults':0,'approvalDeniedResults':0,'toolErrors':[],'terminalStatus':[]})
 first=r['requests']==0
 if not first:
  fail(b.get('previous_response_id')==r['_responseId'],'chaining '+i)
  fail(b.get('prompt_cache_key')==r['_cacheKey'],'cache key changed '+i)
  fail(not any(x.get('type')=='additional_tools' for x in b.get('input',[])),'repeated tools '+i)
  r['gapsMs'].append(round((datetime.datetime.fromisoformat(e['startedAt'].replace('Z','+00:00'))-datetime.datetime.fromisoformat(r['_finished'].replace('Z','+00:00'))).total_seconds()*1000,3))
 else:
  fail('previous_response_id' not in b,'initial chaining '+i)
  tools=[x for x in b.get('input',[]) if x.get('type')=='additional_tools'];fail(len(tools)==1,'initial native tools '+i)
  r['_tools']=tools;r['_cacheKey']=b.get('prompt_cache_key')
  r['initialCacheWrite']=u.get('input_tokens_details',{}).get('cache_write_tokens') if u else None
  r['initialCacheRead']=u.get('input_tokens_details',{}).get('cached_tokens') if u else None
  r['initialInput']=u.get('input_tokens') if u else None
  r['normalizedInitialBodySha256']=hashlib.sha256(json.dumps({k:v for k,v in b.items() if k!='prompt_cache_key'},sort_keys=True,separators=(',',':')).encode()).hexdigest()
 r['_responseId']=t.get('id');r['_finished']=e.get('finishedAt');r['terminalStatus'].append(t.get('status'))
 r['requests']+=1
 if not u:uncertain+=e['reservedUsd'];continue
 details=u.get('input_tokens_details',{});fail('cached_tokens' in details and 'cache_write_tokens' in details,'missing native cache counters '+i)
 read=details.get('cached_tokens',0);write=details.get('cache_write_tokens',0);fresh=u['input_tokens']-read-write
 rates=[200,20,250,750] if u['input_tokens']>272000 else [100,10,125,500]
 if b.get('prompt_cache_retention') in ['12h','24h']:rates[2]*=2
 nano=fresh*rates[0]+read*rates[1]+write*rates[2]+u['output_tokens']*rates[3]
 totalnano+=nano;r['nanoUsd']+=nano
 fail(abs(nano/1e9-e['priced']['usd'])<1e-12,'price mismatch '+i)
 fail(e.get('status')=='metered' and e.get('httpStatus')==200,'unmetered/HTTP '+i)
 r['input']+=u['input_tokens'];r['fresh']+=fresh;r['cacheRead']+=read;r['cacheWrite']+=write;r['output']+=u['output_tokens'];r['largestContext']=max(r['largestContext'],read+write)
 if not first and read==0:r['zeroReadContinuations'].append(i)
 r['httpMs']+=round((datetime.datetime.fromisoformat(e['finishedAt'].replace('Z','+00:00'))-datetime.datetime.fromisoformat(e['startedAt'].replace('Z','+00:00'))).total_seconds()*1000,3)
 for out in t.get('output',[]):
  if out.get('type')=='function_call':
   calls[out['call_id']]={'request':i,'name':out.get('name'),'arguments':out.get('arguments','')};r['toolCalls']+=1
   try:
    args=json.loads(out.get('arguments','{}'))
    if out.get('name')=='shell' and args.get('sandbox')=='unsandboxed':r['requestedUnsandboxedShellCalls']+=1
   except Exception:pass
 for inp in b.get('input',[]):
  if inp.get('type')=='function_call_output':
   text=str(inp.get('output',''));call=calls.get(inp.get('call_id'),{})
   if 'Shell sandbox unavailable (missing_dependency)' in text:r['sandboxMissingDependencyResults']+=1
   if text.startswith('Tool execution was not approved.'):r['approvalDeniedResults']+=1
   rec={'responseRequest':i,'callId':inp.get('call_id'),**call,'output':text};ret.append(rec)
   if text.startswith('Tool execution was not approved.') or text.startswith('Error:') or text.startswith('exit ') and not text.startswith('exit 0'):
    r['toolErrors'].append({k:v for k,v in rec.items() if k!='arguments'})
for r in runs.values():
 r['writesAboveLargestContext']=r['cacheWrite']-r['largestContext'];r['usd']=r['nanoUsd']/1e9
 r['observedSkillRead']=any(x.get('responseRequest') in [e['id'] for e in ledger if e['runId']==r['runId']] and 'Read the task' in x['output'] and 'Do not mutate caller inputs' in x['output'] for x in ret)
 r['observedPublicTestSuccess']=any(x.get('responseRequest') in [e['id'] for e in ledger if e['runId']==r['runId']] and ('pass 2' in x['output'] and 'fail 0' in x['output'] and x['output'].startswith('exit 0\n') and '--test' in x.get('arguments','')) for x in ret)
 for k in list(r):
  if k.startswith('_'):del r[k]
 resultfile=root/'runs'/r['runId']/'result.json'
 if resultfile.exists():
  result=json.loads(resultfile.read_text());r['qualityPass']=result.get('qualityPass');r['grade']=result.get('grade');r['elapsedMsIncludingGrading']=result.get('elapsedMs');r['childElapsedMs']=result.get('childElapsedMs');r['runnerAgentSkillRead']=result.get('agentSkillRead');r['runnerAgentPublicTestSuccess']=result.get('agentPublicTestSuccess');r['interrupted']=result.get('interrupted',False)
  artifact=root/'runs'/r['runId']/'artifact'
  manifest=json.loads((root/'runs'/r['runId']/'manifest.json').read_text())
  for name,digest0 in manifest.get('initialFiles',{}).items():
   if not name.startswith('src/'):
    f=artifact/name;fail(f.exists() and hashlib.sha256(f.read_bytes()).hexdigest()==digest0,'protected seed changed '+r['runId']+'/'+name)
  public=artifact/'test/public.test.mjs'
  caseNames=re.findall(r"test\('([^']+)'",public.read_text()) if public.exists() else []
  runIds={e['id'] for e in ledger if e['runId']==r['runId']}
  toolReturns=[x for x in ret if x.get('responseRequest') in runIds]
  def successPublic(x):
   try:args=json.loads(x.get('arguments','{}'))
   except Exception:return False
   txt=x['output']
   return x.get('name')=='shell' and bool(re.search(r'node\s+--test|(?:npm|pnpm)\s+(?:run\s+)?test',args.get('command',''))) and txt.startswith('exit 0\n') and bool(re.search(r'\bpass [1-9][0-9]*\b',txt)) and bool(re.search(r'\bfail 0\b',txt)) and bool(caseNames) and all(name in txt for name in caseNames)
  r['independentExactPublicTestSuccess']=any(successPublic(x) for x in toolReturns)
  r['independentExactSkillRead']=any('node-contracts' in x.get('arguments','') and 'SKILL.md' in x.get('arguments','') and 'Read the task' in x['output'] and 'Do not mutate caller inputs' in x['output'] for x in toolReturns)
  for name,digest in result.get('files',{}).items():
   f=artifact/name;fail(f.exists() and hashlib.sha256(f.read_bytes()).hexdigest()==digest,'artifact missing/changed '+r['runId']+'/'+name)
 else:errors.append('missing finalized run '+r['runId'])
prefix=protocol.get('cohort','')+'-'
clean=[r for r in runs.values() if r['runId'].startswith(prefix)]
starting=(root/'starting-ledger.json').read_bytes();fail(hashlib.sha256(starting).hexdigest()==protocol.get('priorLedgerSha256'),'starting ledger SHA mismatch')
fail(json.loads(starting)==ledger[:24],'prior24 entries changed')
fail(len(clean)==len(protocol['plannedRuns']),'planned run count mismatch')
fail({r['runId'] for r in clean}=={r['id'] for r in protocol['plannedRuns']},'planned run IDs mismatch')
for r in clean:
 fail(r['independentExactSkillRead'] and r['independentExactPublicTestSuccess'],'missing actual skill/public test '+r['runId'])
 fail(r['runnerAgentSkillRead'] and r['runnerAgentPublicTestSuccess'],'runner capability guard '+r['runId'])
 fail(r['sandboxMissingDependencyResults']==0 and r['approvalDeniedResults']==0 and r['requestedUnsandboxedShellCalls']==0,'capability errors '+r['runId'])
summary={}
for arm in ['baseline','affinity']:
 rows=[r for r in clean if r['arm']==arm]
 summary[arm]={'runs':len(rows),**{k:sum(r[k] for r in rows) for k in ['requests','input','fresh','cacheRead','cacheWrite','output','nanoUsd','writesAboveLargestContext','httpMs','toolCalls','requestedUnsandboxedShellCalls','sandboxMissingDependencyResults','approvalDeniedResults']},'zeroReadContinuations':sum(len(r['zeroReadContinuations']) for r in rows),'toolErrors':sum(len(r['toolErrors']) for r in rows),'externalRubricPasses':sum(r.get('qualityPass') is True for r in rows),'childElapsedMs':sum(r.get('childElapsedMs') or 0 for r in rows)}
 summary[arm]['usd']=summary[arm]['nanoUsd']/1e9
pairs=[]
for spec in protocol['plannedRuns']:
 if spec['arm']!='baseline':continue
 base=runs.get(spec['id']);treat=runs.get(spec['id'].removesuffix('-baseline')+'-affinity')
 if base is None or treat is None:
  pairs.append({'task':spec['task'],'rep':spec['rep'],'incomplete':True});continue
 equal=base['normalizedInitialBodySha256']==treat['normalizedInitialBodySha256'];fail(equal,'initial matched bodies differ '+spec['id'])
 pairs.append({'task':spec['task'],'rep':spec['rep'],'equalInitialBodiesExceptCacheKey':equal,**{k:{'baseline':base[k],'affinity':treat[k],'affinityMinusBaseline':treat[k]-base[k]} for k in ['requests','input','cacheRead','cacheWrite','output','nanoUsd','httpMs','writesAboveLargestContext','childElapsedMs']}})
cleanNano=sum(r['nanoUsd'] for r in clean)
physicalOrder=[]
for e in ledger[24:]:
 if not physicalOrder or physicalOrder[-1]!=e['runId']:physicalOrder.append(e['runId'])
fail(physicalOrder==[r['id'] for r in protocol['plannedRuns']],'realized order differs')
fail(all(len({runs[r['id']]['normalizedInitialBodySha256'] for r in protocol['plannedRuns'] if r['task']==task and r['id'] in runs})==1 for task in {r['task'] for r in protocol['plannedRuns']}),'repetition initial body mismatch')
out={'verdict':'accept' if not errors else 'reject','verdictScope':'native accounting, transport, protocol and capability evidence','errors':errors,'cumulativeConfirmedNativeRequests':len(ledger),'cumulativeNativeUsagePriceEstimateUsd':totalnano/1e9,'cumulativeUncertainExposureUsd':uncertain,'priorRequests':24,'priorEstimateUsd':(totalnano-cleanNano)/1e9,'cleanNativeRequests':sum(r['requests'] for r in clean),'cleanNativeUsagePriceEstimateUsd':cleanNano/1e9,'summary':summary,'pairs':pairs,'cleanRuns':clean,'priorRuns':[r for r in runs.values() if not r['runId'].startswith(prefix)],'realizedRunOrder':physicalOrder,'limitations':['Rates applied independently with integer nanodollar arithmetic; provider invoice unavailable','Scripted fixtures and hosted CI excluded','Small stochastic task sample cannot establish equivalence or general cache-routing causality','Old capability-failed runs excluded from clean efficiency arms but retained in cumulative spending']}
print(json.dumps(out,indent=2))
