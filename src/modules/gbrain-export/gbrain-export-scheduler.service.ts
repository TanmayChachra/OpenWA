import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../common/services/logger.service';
import { GbrainExportService } from './gbrain-export.service';

/**
 * Drives the `daily` export profile (docs/32 Phase 2). Mirrors `PendingMessageReaperService`'s
 * lifecycle exactly: a raw `setInterval` started on module init (so the first run is one interval
 * after boot, not immediately at startup — a restart never doubles up on a run that just happened),
 * cleared on destroy, overlap-guarded so a slow run can never stack a second one on top of itself.
 *
 * There is no cron expression here on purpose (see `gbrainExport.scheduleIntervalMs`'s doc comment
 * in `configuration.ts`): this codebase's other periodic sweeps are all plain intervals, not a cron
 * parser, and the interval itself — default 24h — IS the cadence. A profile that genuinely needs a
 * calendar-aware schedule (e.g. "the first of the month") is future scope, not this one.
 */
@Injectable()
export class GbrainExportSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('GbrainExportSchedulerService');
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly gbrainExport: GbrainExportService,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  onModuleInit(): void {
    const enabled = this.configService?.get<boolean>('gbrainExport.enabled', false) ?? false;
    const intervalMs = this.configService?.get<number>('gbrainExport.scheduleIntervalMs', 24 * 60 * 60_000) ?? 0;
    if (!enabled) {
      this.logger.log('GBrain export disabled (GBRAIN_EXPORT_ENABLED is not true)');
      return;
    }
    if (intervalMs <= 0) {
      this.logger.log('GBrain export scheduler disabled (GBRAIN_EXPORT_INTERVAL_MS <= 0); manual trigger still works');
      return;
    }
    this.timer = setInterval(() => {
      this.runIfIdle().catch(err =>
        this.logger.error('Scheduled GBrain export failed', err instanceof Error ? err.stack : String(err)),
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async runIfIdle(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.gbrainExport.run({});
    } finally {
      this.running = false;
    }
  }
}
