import { beforeEach, it, expect } from 'vitest';
import { clearDecisionModelListCache, fetchDecisionModels } from './decision-model-listing.js';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fetchFromBodies(bodies: unknown[], urls: string[] = []): typeof fetch {
  let call = 0;
  return (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(String(input));
    const body = bodies[Math.min(call, bodies.length - 1)];
    call++;
    if (typeof body === 'number') return new Response('boom', { status: body });
    return jsonResponse(body);
  }) as typeof fetch;
}

beforeEach(() => {
  clearDecisionModelListCache();
});

it('fetches decisions-modality models and maps id and name, skipping id-less entries', async () => {
  const urls: string[] = [];
  const fetchImpl = fetchFromBodies(
    [
      {
        data: [
          { id: '~typesafe/jev-latest', name: 'TypeSafe: Jev Latest' },
          { id: 'typesafe/jev-1.13', name: 'TypeSafe: Jev 1.13' },
          { name: 'no id here' },
        ],
      },
    ],
    urls,
  );

  const models = await fetchDecisionModels({ fetchImpl });

  expect(models).toEqual([
    { id: '~typesafe/jev-latest', name: 'TypeSafe: Jev Latest' },
    { id: 'typesafe/jev-1.13', name: 'TypeSafe: Jev 1.13' },
  ]);
  expect(urls[0]).toBe('https://openrouter.ai/api/v1/models?output_modalities=decisions');
});

it('serves repeated reads from the cache within the TTL', async () => {
  let fetches = 0;
  const fetchImpl = (async () => {
    fetches++;
    return jsonResponse({ data: [{ id: '~typesafe/jev-latest', name: 'Jev Latest' }] });
  }) as typeof fetch;
  let nowMs = 1_000;
  const now = () => nowMs;

  await fetchDecisionModels({ fetchImpl, now });
  nowMs += 5 * 60_000;
  const second = await fetchDecisionModels({ fetchImpl, now });

  expect(second).toEqual([{ id: '~typesafe/jev-latest', name: 'Jev Latest' }]);
  expect(fetches).toBe(1);
});

it('refetches after the TTL expires', async () => {
  let fetches = 0;
  const fetchImpl = (async () => {
    fetches++;
    return jsonResponse({ data: [{ id: `typesafe/jev-${fetches}` }] });
  }) as typeof fetch;
  let nowMs = 1_000;
  const now = () => nowMs;

  await fetchDecisionModels({ fetchImpl, now });
  nowMs += 61 * 60_000;
  const second = await fetchDecisionModels({ fetchImpl, now });

  expect(second).toEqual([{ id: 'typesafe/jev-2' }]);
  expect(fetches).toBe(2);
});

it('returns null on HTTP failure and does not cache the failure', async () => {
  const urls: string[] = [];
  const fetchImpl = fetchFromBodies([500, { data: [{ id: 'typesafe/jev-1.13' }] }], urls);

  const failed = await fetchDecisionModels({ fetchImpl });
  const recovered = await fetchDecisionModels({ fetchImpl });

  expect(failed).toBeNull();
  expect(recovered).toEqual([{ id: 'typesafe/jev-1.13' }]);
  expect(urls.length).toBe(2);
});

it('returns null when the payload has no model array', async () => {
  const fetchImpl = fetchFromBodies([{ unexpected: true }]);

  const models = await fetchDecisionModels({ fetchImpl });

  expect(models).toBeNull();
});
