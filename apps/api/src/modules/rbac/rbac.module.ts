import { Global, Module } from '@nestjs/common';
import { PrivilegedRoleService } from './privileged-role.service.js';
import { RolesService } from './roles.service.js';
import { RolesController } from './roles.controller.js';

@Global()
@Module({
  controllers: [RolesController],
  providers: [PrivilegedRoleService, RolesService],
  exports: [PrivilegedRoleService, RolesService],
})
export class RbacModule {}
