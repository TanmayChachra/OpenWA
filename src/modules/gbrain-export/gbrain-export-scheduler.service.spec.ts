import { ConfigService } from '@nestjs/config';
import { GbrainExportSchedulerService } from './gbrain-export-scheduler.service';
import { GbrainExportService } from './gbrain-export.service';

const fakeConfig = (values: Record<string, unknown>) =>
  ({ get: (key: string, fallback: unknown) => (key in values ? values[key] : fallback) }) as unknown as ConfigService;

describe('GbrainExportSchedulerService', () => {
  afterEach(() => jest.useRealTimers());

  it('does not schedule a timer when disabled (the default)', () => {
    const run = jest.fn();
    const svc = new GbrainExportSchedulerService({ run } as unknown as GbrainExportService, fakeConfig({}));

    jest.useFakeTimers();
    svc.onModuleInit();
    jest.advanceTimersByTime(48 * 60 * 60_000);
    svc.onModuleDestroy();

    expect(run).not.toHaveBeenCalled();
  });

  it('does not schedule a timer when enabled but scheduleIntervalMs is 0 (manual-trigger-only mode)', () => {
    const run = jest.fn();
    const svc = new GbrainExportSchedulerService(
      { run } as unknown as GbrainExportService,
      fakeConfig({ 'gbrainExport.enabled': true, 'gbrainExport.scheduleIntervalMs': 0 }),
    );

    jest.useFakeTimers();
    svc.onModuleInit();
    jest.advanceTimersByTime(48 * 60 * 60_000);
    svc.onModuleDestroy();

    expect(run).not.toHaveBeenCalled();
  });

  it('runs on the configured interval when enabled, and stops after onModuleDestroy', () => {
    const run = jest.fn().mockResolvedValue({});
    const svc = new GbrainExportSchedulerService(
      { run } as unknown as GbrainExportService,
      fakeConfig({ 'gbrainExport.enabled': true, 'gbrainExport.scheduleIntervalMs': 60_000 }),
    );

    jest.useFakeTimers();
    svc.onModuleInit();
    jest.advanceTimersByTime(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({});

    svc.onModuleDestroy();
    run.mockClear();
    jest.advanceTimersByTime(60_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('a slow run guards against overlap: a tick firing mid-run is a no-op', async () => {
    let resolveRun!: () => void;
    const run = jest.fn().mockReturnValue(new Promise<void>(resolve => (resolveRun = resolve)));
    const svc = new GbrainExportSchedulerService(
      { run } as unknown as GbrainExportService,
      fakeConfig({ 'gbrainExport.enabled': true, 'gbrainExport.scheduleIntervalMs': 1000 }),
    );

    jest.useFakeTimers();
    svc.onModuleInit();
    jest.advanceTimersByTime(1000); // starts the first (never-resolving-yet) run
    jest.advanceTimersByTime(1000); // a second tick while the first is still in flight
    expect(run).toHaveBeenCalledTimes(1);

    resolveRun();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(1000); // now idle again, so this tick does start a new run
    expect(run).toHaveBeenCalledTimes(2);

    svc.onModuleDestroy();
  });
});
