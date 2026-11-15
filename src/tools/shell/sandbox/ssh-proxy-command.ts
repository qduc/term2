import http from 'node:http';

const [, , host, targetPort] = process.argv;
const port = Number(targetPort);
const proxyUrl = process.env.HTTPS_PROXY;

function fail(message: string): void {
  process.stderr.write(`Sandbox SSH proxy: ${message}\n`);
  process.exitCode = 1;
}

if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !proxyUrl) {
  fail('invalid destination or missing sandbox proxy');
} else {
  const proxy = new URL(proxyUrl);
  const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const destination = `${address}:${port}`;
  const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString(
    'base64',
  );
  const request = http.request({
    hostname: proxy.hostname,
    port: proxy.port,
    path: destination,
    method: 'CONNECT',
    headers: { Host: destination, 'Proxy-Authorization': `Basic ${auth}` },
  });
  request.once('connect', (response, socket, head) => {
    if (response.statusCode !== 200) {
      fail(`CONNECT returned ${response.statusCode}`);
      socket.destroy();
      return;
    }
    socket.once('error', () => fail('connection closed unexpectedly'));
    socket.once('close', () => process.stdin.pause());
    if (head.length) socket.unshift(head);
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });
  request.once('error', () => fail('could not reach the sandbox proxy'));
  request.end();
}
