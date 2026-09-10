import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  addressSchema,
  updateAddressSchema,
  updateMarketingPreferencesSchema,
  updateProfileSchema,
  uuidSchema,
} from '@health/validation';
import type {
  AddressInput,
  UpdateAddressInput,
  UpdateMarketingPreferencesInput,
  UpdateProfileInput,
} from '@health/validation';
import type { AuthenticatedPrincipal } from '@health/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { AllowUserTypes } from '../../common/decorators/permissions.decorator.js';
import { zodBody, ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestContextFrom } from '../../common/request-context.js';
import { CustomersService, type CustomerProfileView } from './customers.service.js';
import { AddressesService, type AddressView } from '../addresses/addresses.service.js';

/**
 * Customer self-service.
 *
 * Every route resolves the customer from the authenticated session. There is
 * deliberately no `/customers/:id` route here — an admin-facing equivalent
 * lives behind CUSTOMER_READ in the users module.
 */
@ApiTags('Customer account')
@Controller({ path: 'me', version: '1' })
@AllowUserTypes('CUSTOMER')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly addresses: AddressesService,
  ) {}

  @Get('profile')
  @ApiOperation({ summary: 'Fetch your customer profile' })
  async getProfile(@CurrentUser() principal: AuthenticatedPrincipal): Promise<CustomerProfileView> {
    return this.customers.getProfile(principal.userId);
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Update your name and phone number' })
  async updateProfile(
    @Body(zodBody(updateProfileSchema)) input: UpdateProfileInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<CustomerProfileView> {
    return this.customers.updateProfile(principal.userId, input, requestContextFrom(request));
  }

  @Put('preferences/marketing')
  @ApiOperation({
    summary: 'Update marketing preferences',
    description: 'Each change is appended to the immutable consent ledger.',
  })
  async updateMarketing(
    @Body(zodBody(updateMarketingPreferencesSchema)) input: UpdateMarketingPreferencesInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<CustomerProfileView> {
    return this.customers.updateMarketingPreferences(
      principal.userId,
      input,
      requestContextFrom(request),
    );
  }

  @Get('consents')
  @ApiOperation({ summary: 'Your consent history' })
  async listConsents(@CurrentUser() principal: AuthenticatedPrincipal) {
    return { data: await this.customers.listConsents(principal.userId) };
  }

  @Get('addresses')
  @ApiOperation({ summary: 'List your saved addresses' })
  async listAddresses(
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<{ data: AddressView[] }> {
    return { data: await this.addresses.list(principal.userId) };
  }

  @Post('addresses')
  @ApiOperation({ summary: 'Save a new address' })
  async createAddress(
    @Body(zodBody(addressSchema)) input: AddressInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<AddressView> {
    return this.addresses.create(principal.userId, input, requestContextFrom(request));
  }

  @Patch('addresses/:id')
  @ApiOperation({ summary: 'Update a saved address' })
  async updateAddress(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(updateAddressSchema)) input: UpdateAddressInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<AddressView> {
    return this.addresses.update(principal.userId, id, input, requestContextFrom(request));
  }

  @Delete('addresses/:id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a saved address',
    description: 'Soft delete — historical orders keep the address they shipped to.',
  })
  @ApiNoContentResponse({ description: 'The address was removed.' })
  async removeAddress(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<void> {
    await this.addresses.remove(principal.userId, id, requestContextFrom(request));
  }
}
