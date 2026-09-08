import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { GbrainExportService } from './gbrain-export.service';
import { GbrainExportRunResultDto, TriggerGbrainExportDto } from './dto/gbrain-export.dto';

/**
 * Manual trigger + backfill for the GBrain scheduled export (docs/32 Phase 2). Deployment-global
 * like `ClientMappingController` (no `:sessionId` in the path), gated the same way: unscoped ADMIN
 * key only — see `global-route-fence-coverage.spec.ts` for why every global route needs one of
 * those two fences.
 */
@ApiTags('gbrain-export')
@Controller('gbrain-export')
@RequireRole(ApiKeyRole.ADMIN)
@RequireUnscopedKey()
export class GbrainExportController {
  constructor(private readonly gbrainExport: GbrainExportService) {}

  @Post('run')
  @ApiOperation({
    summary:
      'Run a GBrain export now: every mapped contact, its delta since the last successful export (or ' +
      'lookbackDays days back for a manual backfill). dryRun renders every document without touching the ' +
      'sink or any checkpoint, for previewing exactly what a real run would send.',
  })
  @ApiResponse({ status: 200, type: GbrainExportRunResultDto })
  async run(@Body() dto: TriggerGbrainExportDto): Promise<GbrainExportRunResultDto> {
    return this.gbrainExport.run(dto);
  }
}
