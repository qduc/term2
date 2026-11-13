#!/usr/bin/env python3
"""Independent settled-evidence audit; no provider calls."""
import sys,json,pathlib,hashlib,datetime,collections
root=pathlib.Path(sys.argv[1]);wire=root/'wire-live'
if (wire/'active.lock').exists():raise SystemExit('Refusing final audit while coordinator active')
ledger=json.loads((wire/'ledger.json').read_text());protocol=json.loads((root/'protocol.json').read_text())
errors=[];runs={};totalnano=0;uncertain=0
fail=lambda cond,msg:errors.append(msg) if not cond else None
seen=set();calls={};ret=[]
for e in ledger:
 i=e['id'];run=e['runId'];aff=run.endswith('-affinity')
 fail(i not in seen,'duplicate physical id '+i);seen.add(i)
 b=json.loads((wire/(i+'-request.json')).read_text());events=json.loads((wire/(i+'-response.json')).read_text())
 term=[x['response'] for x in events if x.get('type') in ['response.completed','response.failed','response.incomplete']]
 fail(len(term)==1,'terminal event count '+i)
 if len(term)!=1:uncertain+=e['reservedUsd'];continue
 t=term[0];u=t.get('usage');fail(u==e.get('usage'),'usage mismatch '+i)
 fail(e.get('requestSha256')==e.get('outgoingBodySha256'),'relay body altered '+i)
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
 r['observedPublicTestSuccess']=any(x.get('responseRequest') in [e['id'] for e in ledger if e['runId']==r['runId']] and ('# pass 2' in x['output'] or '# tests 2' in x['output'] and '# fail 0' in x['output']) for x in ret)
 for k in list(r):
  if k.startswith('_'):del r[k]
 resultfile=root/'runs'/r['runId']/'result.json'
 if resultfile.exists():
  result=json.loads(resultfile.read_text());r['qualityPass']=result.get('qualityPass');r['grade']=result.get('grade');r['elapsedMsIncludingGrading']=result.get('elapsedMs')
  artifact=root/'runs'/r['runId']/'artifact'
  for name,digest in result.get('files',{}).items():
   f=artifact/name;fail(f.exists() and hashlib.sha256(f.read_bytes()).hexdigest()==digest,'artifact missing/changed '+r['runId']+'/'+name)
 else:errors.append('missing finalized run '+r['runId'])
summary={}
for arm in ['baseline','affinity']:
 rows=[r for r in runs.values() if r['arm']==arm]
 summary[arm]={'runs':len(rows),**{k:sum(r[k] for r in rows) for k in ['requests','input','fresh','cacheRead','cacheWrite','output','nanoUsd','writesAboveLargestContext','httpMs','toolCalls','requestedUnsandboxedShellCalls','sandboxMissingDependencyResults','approvalDeniedResults']},'zeroReadContinuations':sum(len(r['zeroReadContinuations']) for r in rows),'toolErrors':sum(len(r['toolErrors']) for r in rows)}
 summary[arm]['usd']=summary[arm]['nanoUsd']/1e9
out={'verdict':'accept' if not errors else 'reject','verdictScope':'native accounting and retained artifact integrity only','experimentVerdict':'inconclusive; stopped capability guardrail failure','capabilityGuardrail':'failed; sandbox dependency missing and requested public tests denied','errors':errors,'confirmedNativeRequests':len(ledger),'nativeUsagePriceEstimateUsd':totalnano/1e9,'uncertainExposureUsd':uncertain,'summary':summary,'runs':list(runs.values()),'limitations':['Rates applied independently with integer nanodollar arithmetic; provider invoice unavailable','Scripted fixtures and hosted CI excluded','Tool errors may violate capability guardrail; inspect run details','Small stochastic task sample cannot establish equivalence or general cache-routing causality']}
print(json.dumps(out,indent=2))
