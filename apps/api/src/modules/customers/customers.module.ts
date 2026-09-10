import { Module } from '@nestjs/common';
import { CustomersService } from './customers.service.js';
import { CustomersController } from './customers.controller.js';
import { AddressesService } from '../addresses/addresses.service.js';

@Module({
  controllers: [CustomersController],
  providers: [CustomersService, AddressesService],
  exports: [CustomersService, AddressesService],
})
export class CustomersModule {}
