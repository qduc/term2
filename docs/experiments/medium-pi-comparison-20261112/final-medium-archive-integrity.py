"""Passive streaming verification of the sealed archive; no extraction/execution."""
from pathlib import Path,PurePosixPath
import tarfile,hashlib,json
archive=Path('docs/experiments/medium-pi-comparison-20261112/evidence.tar.xz');expected='222adbeb7e96440e871991da7a5d5b5f3ca57999a3d4d8aa91fd3a83ba2ad231';assert archive.stat().st_size==28492816;assert hashlib.sha256(archive.read_bytes()).hexdigest()==expected
seen={};manifest=None;selected={};totalbytes=0
required={'verifier/final-passive-acceptance.md','verifier/final-medium-accounting-audit.json','verifier/medium-native-audit-campaign-v3.json','verifier/medium-grade-audit-campaign-v3.json','verifier/environment-recovery-receipt-audit-2.json','campaign-v3/environment-resume-lineage-2.json','campaign-v3/environment-resume-lineage.json','campaign-v3/protocol-lineage.json','campaign-v3/thread-404-continuation.json','diagnostics/live-v3-detached.txt','diagnostics/live-v3-after-thread-404.txt','diagnostics/cap30-transition-applied.txt','campaign-v3/wire-live/ledger.json','campaign-v3/summary.json'}
with tarfile.open(archive,'r|xz') as tar:
 for member in tar:
  assert member.isfile(),member.name
  name=member.name;p=PurePosixPath(name);assert not p.is_absolute() and '..' not in p.parts;assert name not in seen,name
  stream=tar.extractfile(member);h=hashlib.sha256();length=0;keep=name=='evidence-manifest.json' or name in required or (name.startswith('campaign-v3/runs/') and name.endswith('/result.json')) or name in ['campaign-v3/protocol-live.json','campaign-v3/protocol-live.cap15.json','campaign-v3/protocol-live.before-environment-restart.json','campaign-v3/protocol-live.before-second-environment-restart.json'];chunks=[]
  while True:
   data=stream.read(1024*1024)
   if not data:break
   h.update(data);length+=len(data)
   if keep:chunks.append(data)
  assert length==member.size;seen[name]={'bytes':length,'sha256':h.hexdigest()};totalbytes+=length
  if keep:
   raw=b''.join(chunks)
   if name=='evidence-manifest.json':manifest=json.loads(raw)
   else:selected[name]=raw
assert manifest is not None;assert len(manifest)==5502 and len(seen)==5503;assert set(manifest)==set(seen)-{'evidence-manifest.json'}
for name,record in manifest.items():assert record==seen[name],name
assert required<=set(seen),required-set(seen)
ledger=json.loads(selected['campaign-v3/wire-live/ledger.json']);medium=[r for r in ledger if r.get('runId','').startswith('medium-live-')];assert len(medium)==2058;assert sum(not e.get('priced') for e in medium)==6
requests=[n for n in seen if n.startswith('campaign-v3/wire-live/') and n.endswith('-request.json')];responses=[n for n in seen if n.startswith('campaign-v3/wire-live/') and n.endswith('-response.json')];assert len(requests)==2058 and len(responses)==2053
for row in medium:
 assert 'campaign-v3/wire-live/'+row['id']+'-request.json' in seen
 response='campaign-v3/wire-live/'+row['id']+'-response.json'
 if row['status']=='transport_error_reservation_retained':assert response not in seen and row['error']=='fetch failed'
 else:assert response in seen
results=[n for n in seen if n.startswith('campaign-v3/runs/') and n.endswith('/result.json')];assert len(results)==18;assert all(not json.loads(selected[n])['qualityPass'] for n in results)
for n in results:
 root=n.rsplit('/',1)[0]
 for file in ['manifest.json','candidate-source.json','candidate.patch','stdout.jsonl','stderr.txt','grade.json','contracts.json','supplement.json','prepared.json','prompt.txt']:assert root+'/'+file in seen,(root,file)
for name in ['campaign-v3/environment-resume-lineage.json','campaign-v3/environment-resume-lineage-2.json']:
 line=json.loads(selected[name]);partial='campaign-v3/runs/'+line['oldRunId']+'/';assert partial+'environment-interrupted.json' in seen and partial+'interrupted-candidate-source.json' in seen
for name in ['frozen-v3-producer','frozen-v3-cap30-producer','frozen-v3-environment-recovery-producer','frozen-v3-second-environment-recovery-producer']:
 for file in ['run.mjs','budget-gateway.mjs','grade.py','prepare.py','task.md','launch.mjs']:assert name+'/'+file in seen,(name,file)
summary=json.loads(selected['campaign-v3/summary.json']);assert summary['completedRuns']==18 and summary['plannedRuns']==20;assert len(summary['unstartedPlanIds'])==2
out={'passiveOnly':True,'archiveSha256':expected,'archiveBytes':archive.stat().st_size,'archiveFiles':len(seen),'manifestCoveredFiles':len(manifest),'allNamesSizesSha256Match':True,'safeUniqueRegularFilePaths':True,'expandedBytesHashed':totalbytes,'requiredFinalReceiptsAndRecoveryLogsPresent':True,'completedPrimaryResults':len(results),'all18ArtifactGradesFalse':True,'mediumNativeAttemptRecords':len(medium),'nativeRequestCaptures':len(requests),'nativeResponseCaptures':len(responses),'fiveTransportAttemptsCorrectlyHaveNoResponse':True,'allSixMediumUnknownUsageRowsRetained':True,'bothInterruptedSourceReceiptsAndLineagesPresent':True,'allFrozenProducerVersionsPresent':True,'fullLedgerRetained':True,'noExtractionModelsTestsGradesOrProviderCalls':True,'scope':'Sealed archive integrity and required evidence membership only. No recursive repackaging or new execution.'};Path('.handoff/verifier/final-medium-archive-integrity.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
