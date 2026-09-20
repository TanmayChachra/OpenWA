import { GbrainWebhookSink } from './gbrain-sink-webhook.service';

type FakeResponse = { ok: boolean; status: number; statusText: string };

const asResponse = (value: FakeResponse): Response => value as unknown as Response;

describe('GbrainWebhookSink', () => {
  const doc = { entityId: 's1:jid1', markdown: '# hi' };
  let originalFetch: typeof fetch;
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('POSTs the markdown body with a text/markdown content type and no auth header when no token is set', async () => {
    fetchMock.mockResolvedValue(asResponse({ ok: true, status: 200, statusText: 'OK' }));

    const sink = new GbrainWebhookSink('https://brain.example/ingest', undefined, 5000);
    const result = await sink.send(doc);

    expect(result).toEqual({ delivered: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://brain.example/ingest');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('# hi');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('text/markdown');
    expect(headers.Authorization).toBeUndefined();
  });

  it('adds a Bearer Authorization header when a token is configured', async () => {
    fetchMock.mockResolvedValue(asResponse({ ok: true, status: 200, statusText: 'OK' }));

    const sink = new GbrainWebhookSink('https://brain.example/ingest', 'tok123', 5000);
    await sink.send(doc);

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok123');
  });

  it('a non-2xx response is reported as undelivered with the status in the error', async () => {
    fetchMock.mockResolvedValue(asResponse({ ok: false, status: 500, statusText: 'Internal Server Error' }));

    const sink = new GbrainWebhookSink('https://brain.example/ingest', undefined, 5000);
    const result = await sink.send(doc);

    expect(result.delivered).toBe(false);
    expect(result.error).toContain('500');
  });

  it('a network throw is reported as undelivered rather than rejecting the promise', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const sink = new GbrainWebhookSink('https://brain.example/ingest', undefined, 5000);
    const result = await sink.send(doc);

    expect(result.delivered).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('an aborted (timed-out) request reports a timeout-specific error', async () => {
    fetchMock.mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    const sink = new GbrainWebhookSink('https://brain.example/ingest', undefined, 5000);
    const result = await sink.send(doc);

    expect(result.delivered).toBe(false);
    expect(result.error).toContain('timed out');
  });
});
