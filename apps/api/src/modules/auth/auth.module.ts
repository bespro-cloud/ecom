import { Module } from '@nestjs/common';
import { AccessTokenService } from '@health/auth';
import { AppConfigService } from '../../infrastructure/config/app-config.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { CredentialsService } from './credentials.service.js';
import { MfaService } from './mfa.service.js';
import { PrincipalService } from './principal.service.js';
import { SessionService } from './session.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    CredentialsService,
    MfaService,
    PrincipalService,
    SessionService,
    {
      // One AccessTokenService for the process: it validates and caches the
      // signing key material at construction.
      provide: AccessTokenService,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => new AccessTokenService(config.env.SESSION_SECRET),
    },
  ],
  exports: [AuthService, SessionService, PrincipalService, MfaService, AccessTokenService],
})
export class AuthModule {}
