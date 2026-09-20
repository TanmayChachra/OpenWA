import { ApiPropertyOptional } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { ToStrictBoolean } from '../../../common/utils/strict-boolean';

export class TriggerGbrainExportDto {
  @ApiPropertyOptional({ description: 'Limit the run to one WhatsApp session. Omit to export every session.' })
  @IsOptional()
  @IsString()
  sessionId?: string;

  @ApiPropertyOptional({
    description:
      "Backfill override: export this many days of history regardless of each contact/group's checkpoint. " +
      'Omit to use the normal delta-since-last-export behavior.',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  lookbackDays?: number;

  @ApiPropertyOptional({
    description: 'Render every document but skip the sink and leave checkpoints untouched. For previewing output.',
    default: false,
  })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  dryRun?: boolean;
}

export class GbrainExportDocumentResultDto {
  @Expose() entityId!: string;
  @Expose() sessionId!: string;
  @Expose() jid!: string;
  @Expose() name!: string;
  @Expose() messageCount!: number;
  @Expose() delivered!: boolean;
  @Expose() error?: string;
  @Expose() markdown!: string;
}

export class GbrainExportRunResultDto {
  @Expose() dryRun!: boolean;
  @Expose() sink!: 'cli' | 'webhook';
  @Expose() exportedAt!: string;
  @Expose() documentsRendered!: number;
  @Expose() documentsDelivered!: number;
  @Expose() documentsFailed!: number;
  @Expose() documents!: GbrainExportDocumentResultDto[];
}
