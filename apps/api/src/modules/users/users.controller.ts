import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  acceptStaffInviteSchema,
  inviteStaffUserSchema,
  listUsersQuerySchema,
  setUserRolesSchema,
  updateStaffUserSchema,
  uuidSchema,
} from '@health/validation';
import type {
  AcceptStaffInviteInput,
  InviteStaffUserInput,
  ListUsersQuery,
  SetUserRolesInput,
  UpdateStaffUserInput,
} from '@health/validation';
import type { AuthenticatedPrincipal, Paginated } from '@health/types';
import { Public } from '../../common/decorators/public.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireMfa, RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { zodBody, ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestContextFrom } from '../../common/request-context.js';
import { UsersService, type UserView } from './users.service.js';

@ApiTags('Users')
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('USER_READ')
  @ApiOperation({ summary: 'Search staff and customer accounts' })
  @ApiOkResponse({ description: 'A page of users.' })
  async list(
    @Query(zodBody(listUsersQuerySchema)) query: ListUsersQuery,
  ): Promise<Paginated<UserView>> {
    return this.users.list(query);
  }

  @Get(':id')
  @RequirePermissions('USER_READ')
  @ApiOperation({ summary: 'Fetch one account' })
  async findOne(@Param('id', new ZodValidationPipe(uuidSchema)) id: string): Promise<UserView> {
    return this.users.findById(id);
  }

  @Post('invite')
  @RequirePermissions('USER_WRITE')
  @RequireMfa()
  @ApiOperation({
    summary: 'Invite a staff user',
    description:
      'Creates an INVITED account with no password and emails a single-use invitation. Administrators never set another user’s password.',
  })
  async invite(
    @Body(zodBody(inviteStaffUserSchema)) input: InviteStaffUserInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<UserView> {
    return this.users.invite(input, {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    });
  }

  @Post('invite/accept')
  @Public()
  @HttpCode(204)
  @RateLimit('sensitive')
  @ApiOperation({ summary: 'Accept a staff invitation and set a password' })
  async acceptInvite(
    @Body(zodBody(acceptStaffInviteSchema)) input: AcceptStaffInviteInput,
    @Req() request: Request,
  ): Promise<void> {
    await this.users.acceptInvite(
      input.token,
      input.password,
      requestContextFrom(request).correlationId,
    );
  }

  @Patch(':id')
  @RequirePermissions('USER_WRITE')
  @ApiOperation({
    summary: 'Update an account',
    description: 'Suspending or deactivating an account revokes its sessions immediately.',
  })
  async update(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(updateStaffUserSchema)) input: UpdateStaffUserInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<UserView> {
    return this.users.update(id, input, {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    });
  }

  @Put(':id/roles')
  @RequirePermissions('USER_MANAGE')
  @RequireMfa()
  @ApiOperation({
    summary: 'Replace a user’s roles',
    description:
      'Requires a written reason, cannot be used on your own account, and revokes the affected user’s sessions so the change takes effect at once.',
  })
  async setRoles(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(setUserRolesSchema)) input: SetUserRolesInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<UserView> {
    return this.users.setRoles(id, input, {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    });
  }

  @Post(':id/revoke-sessions')
  @RequirePermissions('USER_MANAGE')
  @RequireMfa()
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign a user out of every device' })
  async revokeSessions(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<{ revokedSessions: number }> {
    return this.users.revokeSessions(id, {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    });
  }
}
