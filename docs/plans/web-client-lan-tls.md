# Web client LAN/TLS threat model

The `dev` and `start` scripts in `web-client/package.json` pass `-H` from
`chooseListenHost` in `web-client/lib/server/listen-host.js`. It reads the
comma-separated `TERM2_WEB_CLIENT_ALLOWED_HOSTS` value: when it is unset or
empty, or when it contains no accepted entry—including `0.0.0.0`, `::`, `*`,
or any other rejected entry—the listen address remains `127.0.0.1`; otherwise,
the first accepted host is the listen address. The
`assertLocalStateChangingRequest` guard in
`web-client/lib/server/request-guards.ts` allows loopback plus every accepted
host in that list for `Host` and `Origin`; it does not allow every host.

The gateway is reached through its Unix socket. Binding the web client on a LAN
address does not publish the gateway. A LAN listener exposes the signed-in
user's sessions and local-owner settings; it does not expose the gateway socket
or provider keys in the projection.

TLS for a LAN listener is terminated by the operator's terminator in front of
the web client. This tree does not terminate public TLS.
