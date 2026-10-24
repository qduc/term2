from pathlib import Path
import subprocess,os,time,json
p=Path(__file__).resolve().parent
root=p.parents[4]
baseenv=os.environ.copy()
baseenv['NODE_OPTIONS']='--import '+(p/'network-deny.mjs').as_uri()+' --import '+(p/'git-metadata-loader.mjs').as_uri()
serial='313:1:2:2:2:2:2:2:2:2:2:5:5:5:5:5:5:5:5:8:8:11:11'
commands=[
('installed-default',['pnpm','verify:generated','--seed','424242'],False),
('history-separate',['pnpm','verify:generated','--target','history','--runs','1000','--seed','123456'],False),
('queue-additional',['pnpm','verify:generated','--target','queue','--runs','10000','--seed','8675309'],False),
('help',['pnpm','verify:generated','--help'],False),
('bad-target',['pnpm','verify:generated','--target','typo'],False),
('bad-runs',['pnpm','verify:generated','--runs','0'],False),
('bad-seed',['pnpm','verify:generated','--seed','2147483648'],False),
('bad-property',['pnpm','verify:generated','--property','missing'],False),
('path-without-property',['pnpm','verify:generated','--seed','424242','--path','6:0'],False),
('serial-replay-green',['pnpm','verify:generated','--property','queue.serial-actions','--seed','424242','--path',serial,'--runs','1000'],False),
('restore-replay-green',['pnpm','verify:generated','--property','queue.restore-pause','--seed','424242','--path','6:0','--runs','1000'],False),
('base-generated',['pnpm','verify:generated','--target','queue','--seed','424242'],True),
('base-serial-replay',['pnpm','verify:generated','--property','queue.serial-actions','--seed','424242','--path',serial,'--runs','1000'],True),
('base-restore-replay',['pnpm','verify:generated','--property','queue.restore-pause','--seed','424242','--path','6:0','--runs','1000'],True),
('output-write',['pnpm','verify:generated','--target','history','--runs','20','--seed','424242','--output',str(p/'output-report.json')],False),
('output-refuse-overwrite',['pnpm','verify:generated','--target','history','--runs','20','--seed','424242','--output',str(p/'output-report.json')],False),
]
records=[]
for name,cmd,baseline in commands:
 cmd=['node','--import','tsx','scripts/generated-verification/run.mjs',*cmd[2:]]
 env=baseenv.copy()
 if baseline: env['NODE_OPTIONS']+=' --import '+(p/'base-loader.mjs').as_uri()
 start=time.monotonic()
 result=subprocess.run(cmd,cwd=root,env=env,text=True,capture_output=True,timeout=60)
 (p/(name+'.stdout')).write_text(result.stdout)
 (p/(name+'.stderr')).write_text(result.stderr)
 record={'name':name,'command':cmd,'cwd':str(root),'NODE_OPTIONS':env['NODE_OPTIONS'],'baseControllerOnly':baseline,'exit':result.returncode,'wallSeconds':time.monotonic()-start}
 records.append(record)
 print(json.dumps(record),flush=True)
(p/'commands.json').write_text(json.dumps(records,indent=2)+'\n')
