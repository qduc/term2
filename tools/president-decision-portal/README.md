# President decision portal

Small dependency-free LAN portal for recording the current Contract 11 owner decisions.

Run it only on the approved private network host:

```sh
PRESIDENT_PORTAL_HOST=192.168.0.88 node tools/president-decision-portal/server.mjs
```

The process creates a private runtime directory at
`/home/qduc/.agents/runtime/president-decision-portal/` containing its generated
access token and append-only `decisions.jsonl` ledger. It binds to one exact LAN
address and rejects clients outside `192.168.0.*`.

This portal records decisions; it does not itself authorize production changes,
Git operations, or channel activation. A separately approved Operations notification
contract is required before browser submissions may wake an agent session.
