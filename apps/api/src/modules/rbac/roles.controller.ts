import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createRoleSchema, updateRoleSchema, uuidSchema } from '@health/validation';
import type { CreateRoleInput, UpdateRoleInput } from '@health/validation';
import type { AuthenticatedPrincipal } from '@health/types';
import type { Request } from 'express';
import { RequireMfa, RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { zodBody, ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestContextFrom } from '../../common/request-context.js';
import { RolesService, type RoleView } from './roles.service.js';

@ApiTags('Roles')
@Controller({ path: 'roles', version: '1' })
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermissions('ROLE_READ')
  @ApiOperation({ summary: 'List roles with their permissions' })
  @ApiOkResponse({ description: 'All roles, system roles first.' })
  async list(): Promise<{ data: RoleView[] }> {
    return { data: await this.roles.list() };
  }

  @Get('permissions')
  @RequirePermissions('ROLE_READ')
  @ApiOperation({
    summary: 'List the permission catalogue',
    description: 'The complete set of permissions a role can grant, for building the role editor.',
  })
  listPermissions(): { data: ReturnType<RolesService['listPermissionCatalogue']> } {
    return { data: this.roles.listPermissionCatalogue() };
  }

  @Post()
  @RequirePermissions('ROLE_MANAGE')
  @RequireMfa()
  @ApiOperation({
    summary: 'Create a custom role',
    description: 'System roles are defined in code; only custom roles can be created here.',
  })
  async create(
    @Body(zodBody(createRoleSchema)) input: CreateRoleInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<RoleView> {
    return this.roles.create(input, {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    });
  }

  @Put(':id')
  @RequirePermissions('ROLE_MANAGE')
  @RequireMfa()
  @ApiOperation({ summary: 'Update a custom role' })
  async update(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(updateRoleSchema)) input: UpdateRoleInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<RoleView> {
    return this.roles.update(id, input, {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    });
  }

  @Delete(':id')
  @RequirePermissions('ROLE_MANAGE')
  @RequireMfa()
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an unused custom role' })
  @ApiNoContentResponse({ description: 'The role was deleted.' })
  async remove(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<void> {
    await this.roles.remove(id, {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    });
  }
}
