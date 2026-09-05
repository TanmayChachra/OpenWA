import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientMapping } from './entities/client-mapping.entity';
import { ClientMappingService } from './client-mapping.service';
import { ClientMappingController } from './client-mapping.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ClientMapping], 'data')],
  controllers: [ClientMappingController],
  providers: [ClientMappingService],
  exports: [ClientMappingService],
})
export class ClientMappingModule {}
