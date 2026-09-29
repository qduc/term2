# Web client LAN/TLS threat model

The `dev` and `start` scripts in `web-client/package.json` bind to `127.0.0.1`
unless an operator opts in to a named LAN host. The
`assertLocalStateChangingRequest` guard in `web-client/lib/server/request-guards.ts`
checks `Host` and `Origin` against loopback unless that opt-in adds named hosts.
The opt-in is the required control for making those checks accept a LAN name;
this branch's `web-client/` still has the hardcoded loopback guard today.

The gateway is reached through its Unix socket. Binding the web client on a LAN
address does not publish the gateway. A LAN listener exposes the signed-in
user's sessions and local-owner settings; it does not expose the gateway socket
or provider keys in the projection.

TLS for a LAN listener is terminated by the operator's terminator in front of
the web client. This tree does not terminate public TLS.
