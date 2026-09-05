import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientMapping } from './entities/client-mapping.entity';
import { ClientMappingService } from './client-mapping.service';
import { ClientMappingAutoTagService } from './client-mapping-auto-tag.service';
import { ClientMappingController } from './client-mapping.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ClientMapping], 'data')],
  controllers: [ClientMappingController],
  providers: [ClientMappingService, ClientMappingAutoTagService],
  exports: [ClientMappingService, ClientMappingAutoTagService],
})
export class ClientMappingModule {}
