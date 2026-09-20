import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientMapping } from '../client-mapping/entities/client-mapping.entity';
import { Message } from '../message/entities/message.entity';
import { GbrainExportState } from './entities/gbrain-export-state.entity';
import { GbrainExportService } from './gbrain-export.service';
import { GbrainExportSchedulerService } from './gbrain-export-scheduler.service';
import { GbrainExportController } from './gbrain-export.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ClientMapping, Message, GbrainExportState], 'data')],
  controllers: [GbrainExportController],
  providers: [GbrainExportService, GbrainExportSchedulerService],
  exports: [GbrainExportService],
})
export class GbrainExportModule {}
