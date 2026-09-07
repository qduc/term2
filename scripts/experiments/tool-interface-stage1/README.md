# Stage1 tool-interface benchmark driver

Paired real-model protocol for the Stage1 `run_code` header candidate vs baseline `76e51d24`.
Full protocol: `docs/research/tool-interface-stage1-protocol.md`.

Do not launch paid cells until the candidate hash is final and parent/Claude give `--go`.

```bash
node scripts/experiments/tool-interface-stage1/driver.mjs preflight --output-dir /home/qduc/.agents/runtime/tool-interface-stage1
node scripts/experiments/tool-interface-stage1/driver.mjs run --go --output-dir /home/qduc/.agents/runtime/tool-interface-stage1
```

