import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientMapping } from './entities/client-mapping.entity';
import { ClientMappingService } from './client-mapping.service';
import { ClientMappingIdentityService } from './client-mapping-identity.service';
import { ClientMappingAutoTagService } from './client-mapping-auto-tag.service';
import { ClientMappingController } from './client-mapping.controller';

@Module({
  // EngineRegistry/LidMappingStoreService (ClientMappingIdentityService's collaborators) come from
  // the @Global() EngineModule and HookManager from the @Global() HooksModule - no explicit import
  // needed. Core's SessionModule does not import this module: auto-tag subscribes to the
  // `message:persisted` hook instead (see client-mapping-auto-tag.service.ts).
  imports: [TypeOrmModule.forFeature([ClientMapping], 'data')],
  controllers: [ClientMappingController],
  providers: [ClientMappingService, ClientMappingIdentityService, ClientMappingAutoTagService],
  exports: [ClientMappingService, ClientMappingAutoTagService],
})
export class ClientMappingModule {}
