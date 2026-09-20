import { GbrainExportController } from './gbrain-export.controller';
import { GbrainExportService } from './gbrain-export.service';

describe('GbrainExportController', () => {
  it('POST /gbrain-export/run forwards the body straight to the service and returns its result', async () => {
    const runResult = {
      dryRun: true,
      sink: 'cli',
      exportedAt: '2026-01-01T00:00:00.000Z',
      documentsRendered: 1,
      documentsDelivered: 1,
      documentsFailed: 0,
      documents: [],
    } as const;
    const run = jest.fn().mockResolvedValue(runResult);
    const controller = new GbrainExportController({ run } as unknown as GbrainExportService);

    const dto = { sessionId: 's1', lookbackDays: 7, dryRun: true };
    const result = await controller.run(dto);

    expect(run).toHaveBeenCalledWith(dto);
    expect(result).toBe(runResult);
  });
});
