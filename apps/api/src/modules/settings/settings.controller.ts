import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { updateSystemSettingSchema, upsertFeatureFlagSchema } from '@health/validation';
import type { UpdateSystemSettingInput, UpsertFeatureFlagInput } from '@health/validation';
import type { AuthenticatedPrincipal } from '@health/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireMfa, RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { requestContextFrom } from '../../common/request-context.js';
import { SettingsService, type SystemSettingView } from './settings.service.js';
import { FeatureFlagsService, type FeatureFlagView } from './feature-flags.service.js';

@ApiTags('System settings')
@Controller({ path: 'system', version: '1' })
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly flags: FeatureFlagsService,
  ) {}

  @Get('settings')
  @RequirePermissions('SYSTEM_SETTINGS')
  @ApiOperation({ summary: 'List editable system settings' })
  async listSettings(): Promise<{ data: SystemSettingView[] }> {
    return { data: await this.settings.list() };
  }

  @Put('settings/:key')
  @RequirePermissions('SYSTEM_SETTINGS')
  @RequireMfa()
  @ApiOperation({
    summary: 'Change a system setting',
    description: 'Requires a written reason, which is stored in the audit trail.',
  })
  async updateSetting(
    @Param('key') key: string,
    @Body(zodBody(updateSystemSettingSchema)) input: UpdateSystemSettingInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<SystemSettingView> {
    return this.settings.update(key, input, {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    });
  }

  @Get('feature-flags')
  @RequirePermissions('SYSTEM_SETTINGS')
  @ApiOperation({ summary: 'List feature flags and their rollout state' })
  async listFlags(): Promise<{ data: FeatureFlagView[] }> {
    return { data: await this.flags.list() };
  }

  @Put('feature-flags/:key')
  @RequirePermissions('SYSTEM_SETTINGS')
  @RequireMfa()
  @ApiOperation({
    summary: 'Create or update a feature flag',
    description:
      'Rollout is deterministic per subject, so a customer sees a consistent experience across requests.',
  })
  async upsertFlag(
    @Param('key') key: string,
    @Body(zodBody(upsertFeatureFlagSchema)) input: UpsertFeatureFlagInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<FeatureFlagView> {
    return this.flags.upsert(key, input, {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    });
  }
}
