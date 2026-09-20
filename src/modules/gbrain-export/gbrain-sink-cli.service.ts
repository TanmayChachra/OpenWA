import { spawn } from 'node:child_process';
import type { GBrainDocument, GBrainSink, GBrainSinkResult } from './gbrain-sink.interface';

/**
 * Delivers via GBrain's CLI, for a deployment where GBrain runs on the same host/network as OpenWA
 * (docs/32 Phase 2): `<cliPath> capture --stdin`, piping the rendered markdown on stdin — the exact
 * invocation form GBrain documents (`echo "..." | gbrain capture --stdin`), just via `spawn` instead
 * of a shell pipe so the markdown body never passes through shell interpolation. Not a NestJS
 * `@Injectable()`: constructed by `createGbrainSink` from current config at call time, same as
 * `GbrainWebhookSink`, so there is exactly one place ("which sink is active") to reason about.
 */
export class GbrainCliSink implements GBrainSink {
  readonly id = 'cli' as const;

  constructor(private readonly cliPath: string) {}

  send(doc: GBrainDocument): Promise<GBrainSinkResult> {
    return new Promise(resolve => {
      let settled = false;
      const finish = (result: GBrainSinkResult): void => {
        if (settled) return; // 'error' and a non-zero 'close' can both fire for the same spawn failure
        settled = true;
        resolve(result);
      };

      let child;
      try {
        child = spawn(this.cliPath, ['capture', '--stdin'], { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        // A synchronous spawn throw (e.g. an invalid cliPath) never reaches the 'error' event.
        finish({ delivered: false, error: err instanceof Error ? err.message : String(err) });
        return;
      }

      let stderr = '';
      child.stderr?.on('data', chunk => {
        stderr += String(chunk);
      });
      // ENOENT (binary not found/not executable) surfaces here, not as a non-zero exit code.
      child.on('error', err => {
        finish({ delivered: false, error: err instanceof Error ? err.message : String(err) });
      });
      child.on('close', code => {
        if (code === 0) finish({ delivered: true });
        else finish({ delivered: false, error: stderr.trim() || `gbrain capture exited with code ${code}` });
      });

      child.stdin?.on('error', () => {
        // A broken pipe (the process died before reading stdin) is reported by the 'error'/'close'
        // handlers above too; swallow here so Node's default "unhandled 'error' on stdin" crash
        // never fires for what is already a reported failure.
      });
      child.stdin?.write(doc.markdown);
      child.stdin?.end();
    });
  }
}
