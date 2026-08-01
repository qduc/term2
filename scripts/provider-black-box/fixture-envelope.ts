import { readFile } from 'node:fs/promises';

export type FixtureTransport = 'http-sse' | 'http-json' | 'websocket';
export type FixtureWireFamily = 'openai-responses' | 'openai-chat' | 'anthropic' | 'google' | 'ai-sdk' | string;

export type HttpRequestFrame = {
  seq: number;
  kind: 'http-request';
  method: string;
  urlPath: string;
  headers: Record<string, string>;
  body: unknown;
};
export type HttpResponseHeadFrame = {
  seq: number;
  kind: 'http-response-head';
  status: number;
  headers: Record<string, string>;
};
export type SseEventFrame = { seq: number; kind: 'sse-event'; event?: string; data: string };
export type JsonBodyFrame = { seq: number; kind: 'json-body'; body: unknown };
export type WsMessageFrame = { seq: number; kind: 'ws-message'; direction: 'send' | 'receive'; data: unknown };
export type FixtureFrame = HttpRequestFrame | HttpResponseHeadFrame | SseEventFrame | JsonBodyFrame | WsMessageFrame;

export type FixtureEnvelopeV1 = {
  schemaVersion: 1;
  kind: 'real-traffic-recording';
  provider: string;
  wireFamily: FixtureWireFamily;
  transport: FixtureTransport;
  capture: {
    sdkPackage: string;
    apiSdkVersion: string;
    model: string;
    modelFamily: string;
    capturedAt: string;
    recorderVersion: string;
    probeScenario: string;
  };
  turns: Array<{ frames: FixtureFrame[] }>;
  placeholders: Record<string, string>;
};

const frameKinds = new Set<FixtureFrame['kind']>([
  'http-request',
  'http-response-head',
  'sse-event',
  'json-body',
  'ws-message',
]);
const transports = new Set<FixtureTransport>(['http-sse', 'http-json', 'websocket']);

export function validateFixtureEnvelope(value: unknown): FixtureEnvelopeV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'real-traffic-recording')
    throw new Error('Invalid fixture envelope: expected schemaVersion 1 real-traffic-recording');
  for (const key of ['provider', 'wireFamily'] as const) requireString(value[key], key);
  if (!transports.has(value.transport as FixtureTransport)) throw new Error('Invalid fixture envelope transport');
  if (!isRecord(value.capture)) throw new Error('Invalid fixture envelope capture');
  for (const key of [
    'sdkPackage',
    'apiSdkVersion',
    'model',
    'modelFamily',
    'capturedAt',
    'recorderVersion',
    'probeScenario',
  ])
    requireString(value.capture[key], `capture.${key}`);
  if (!Array.isArray(value.turns) || value.turns.length === 0) throw new Error('Invalid fixture envelope turns');
  if (!isRecord(value.placeholders)) throw new Error('Invalid fixture envelope placeholders');

  const placeholderValues = new Set<string>();
  for (const [dynamic, stable] of Object.entries(value.placeholders)) {
    if (!dynamic || typeof stable !== 'string' || stable.length === 0) throw new Error('Invalid placeholder mapping');
    if (placeholderValues.has(stable)) throw new Error(`Placeholder collision: ${stable}`);
    placeholderValues.add(stable);
  }

  for (const [turnIndex, turn] of value.turns.entries()) {
    if (!isRecord(turn) || !Array.isArray(turn.frames)) throw new Error(`Invalid fixture turn ${turnIndex}`);
    let previous = -1;
    const seenSequences = new Set<number>();
    for (const frame of turn.frames) {
      validateFrame(frame);
      if (seenSequences.has(frame.seq)) throw new Error(`Duplicate frame sequence: ${frame.seq}`);
      if (frame.seq <= previous) throw new Error(`Frame sequences must increase in turn ${turnIndex}`);
      previous = frame.seq;
      seenSequences.add(frame.seq);
    }
  }

  // Only placeholder-shaped tokens (<digits>) are cross-referenced by the
  // placeholder map. Angle-bracketed text in payloads (<b>, Array<string>, XML)
  // is ordinary content and must not be rejected as an unmapped reference.
  const allowedTokens = new Set<string>();
  for (const stable of placeholderValues) {
    allowedTokens.add(stable);
    for (const token of stable.matchAll(/<\d+>/g)) allowedTokens.add(token[0]);
  }
  const serialized = JSON.stringify(value.turns);
  for (const token of serialized.matchAll(/<\d+>/g)) {
    if (!allowedTokens.has(token[0])) throw new Error(`Unmapped placeholder reference: ${token[0]}`);
  }
  return value as FixtureEnvelopeV1;
}

export async function readFixtureEnvelope(path: string): Promise<FixtureEnvelopeV1> {
  return validateFixtureEnvelope(JSON.parse(await readFile(path, 'utf8')));
}

export function parseFixtureEnvelope(text: string): FixtureEnvelopeV1 {
  return validateFixtureEnvelope(JSON.parse(text));
}

function validateFrame(value: unknown): asserts value is FixtureFrame {
  if (!isRecord(value) || typeof value.seq !== 'number' || !Number.isInteger(value.seq) || value.seq < 0)
    throw new Error('Invalid fixture frame sequence');
  if (typeof value.kind !== 'string' || !frameKinds.has(value.kind as FixtureFrame['kind']))
    throw new Error(`Invalid fixture frame kind: ${String(value.kind)}`);
  if (value.kind === 'http-request') {
    requireString(value.method, 'http-request.method');
    requireString(value.urlPath, 'http-request.urlPath');
    requireRecordOfStrings(value.headers, 'http-request.headers');
  } else if (value.kind === 'http-response-head') {
    if (typeof value.status !== 'number' || !Number.isInteger(value.status)) throw new Error('Invalid response status');
    requireRecordOfStrings(value.headers, 'http-response-head.headers');
  } else if (value.kind === 'sse-event') {
    requireString(value.data, 'sse-event.data');
    if (value.event !== undefined) requireString(value.event, 'sse-event.event');
  } else if (value.kind === 'ws-message') {
    if (value.direction !== 'send' && value.direction !== 'receive') throw new Error('Invalid websocket direction');
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid fixture ${name}`);
}
function requireRecordOfStrings(value: unknown, name: string): asserts value is Record<string, string> {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== 'string'))
    throw new Error(`Invalid fixture ${name}`);
}
