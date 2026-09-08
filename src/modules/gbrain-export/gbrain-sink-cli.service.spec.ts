import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { GbrainCliSink } from './gbrain-sink-cli.service';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { write: jest.Mock; end: jest.Mock };
    stderr: EventEmitter;
  };
  child.stdin = Object.assign(new EventEmitter(), { write: jest.fn(), end: jest.fn() });
  child.stderr = new EventEmitter();
  return child;
}

describe('GbrainCliSink', () => {
  const doc = { entityId: 's1:jid1', markdown: '# hi' };

  beforeEach(() => jest.clearAllMocks());

  it('pipes the markdown to `<cliPath> capture --stdin` and reports delivered on a clean exit', async () => {
    const child = fakeChild();
    (spawn as jest.Mock).mockReturnValue(child);

    const sink = new GbrainCliSink('gbrain');
    const promise = sink.send(doc);
    child.emit('close', 0);

    await expect(promise).resolves.toEqual({ delivered: true });
    expect(spawn).toHaveBeenCalledWith('gbrain', ['capture', '--stdin'], expect.any(Object));
    expect(child.stdin.write).toHaveBeenCalledWith('# hi');
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it('a non-zero exit is reported undelivered with captured stderr as the error', async () => {
    const child = fakeChild();
    (spawn as jest.Mock).mockReturnValue(child);

    const sink = new GbrainCliSink('gbrain');
    const promise = sink.send(doc);
    child.stderr.emit('data', 'boom');
    child.emit('close', 1);

    const result = await promise;
    expect(result.delivered).toBe(false);
    expect(result.error).toBe('boom');
  });

  it('an ENOENT-style spawn error event resolves (not rejects) as undelivered', async () => {
    const child = fakeChild();
    (spawn as jest.Mock).mockReturnValue(child);

    const sink = new GbrainCliSink('/no/such/binary');
    const promise = sink.send(doc);
    child.emit('error', new Error('spawn ENOENT'));

    const result = await promise;
    expect(result.delivered).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  it('a synchronous throw from spawn() itself is caught and reported, not left to crash the caller', async () => {
    (spawn as jest.Mock).mockImplementation(() => {
      throw new Error('cannot spawn');
    });

    const sink = new GbrainCliSink('gbrain');
    const result = await sink.send(doc);

    expect(result.delivered).toBe(false);
    expect(result.error).toContain('cannot spawn');
  });

  it("'error' and 'close' firing for the same failure only resolve the promise once", async () => {
    const child = fakeChild();
    (spawn as jest.Mock).mockReturnValue(child);

    const sink = new GbrainCliSink('gbrain');
    const promise = sink.send(doc);
    child.emit('error', new Error('boom'));
    child.emit('close', 1);

    const result = await promise;
    expect(result.error).toBe('boom');
  });
});
