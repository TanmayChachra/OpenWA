import type { GBrainDocument, GBrainSink, GBrainSinkResult } from './gbrain-sink.interface';

/**
 * Delivers via GBrain's ingest webhook, for a deployment where GBrain is only reachable over the
 * network (docs/32 Phase 2): `POST <url>` with `Content-Type: text/markdown` and, when configured,
 * `Authorization: Bearer <token>` — GBrain's own documented ingest contract. Uses the global `fetch`
 * (Node 22+, this project's minimum engine, ships it built in) rather than adding an HTTP client
 * dependency for one outbound call.
 */
export class GbrainWebhookSink implements GBrainSink {
  readonly id = 'webhook' as const;

  constructor(
    private readonly url: string,
    private readonly token: string | undefined,
    private readonly timeoutMs: number,
  ) {}

  async send(doc: GBrainDocument): Promise<GBrainSinkResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/markdown',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: doc.markdown,
        signal: controller.signal,
      });
      if (res.ok) return { delivered: true };
      return { delivered: false, error: `GBrain webhook responded ${res.status} ${res.statusText}` };
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      return { delivered: false, error: aborted ? `GBrain webhook timed out after ${this.timeoutMs}ms` : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
