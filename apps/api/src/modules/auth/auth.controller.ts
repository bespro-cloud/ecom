import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import {
  changePasswordSchema,
  loginSchema,
  mfaDisableSchema,
  mfaEnrollConfirmSchema,
  mfaVerifySchema,
  registerSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '@health/validation';
import type {
  ChangePasswordInput,
  LoginInput,
  MfaDisableInput,
  MfaEnrollConfirmInput,
  MfaVerifyInput,
  RegisterInput,
  RequestPasswordResetInput,
  ResetPasswordInput,
  VerifyEmailInput,
} from '@health/validation';
import { ERROR_CODES, type AuthenticatedPrincipal, type PublicUser } from '@health/types';
import { Public } from '../../common/decorators/public.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { MfaEnrollmentExempt } from '../../common/decorators/permissions.decorator.js';
import { zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { AppException } from '../../common/errors/app-exception.js';
import { requestContextFrom } from '../../common/request-context.js';
import { AppConfigService } from '../../infrastructure/config/app-config.service.js';
import { AuthService, type AuthenticatedSession } from './auth.service.js';
import { CredentialsService } from './credentials.service.js';
import { MfaService } from './mfa.service.js';
import { PrincipalService } from './principal.service.js';
import { SessionService } from './session.service.js';
import { clearAuthCookies, CSRF_COOKIE, extractRefreshToken, setAuthCookies } from './cookies.js';

interface SessionResponse {
  user: PublicUser;
  /**
   * Also returned in the body so non-browser clients (mobile, integration
   * tests) can use bearer auth. Browsers should rely on the cookies and ignore
   * this field.
   */
  accessToken: string;
  accessTokenExpiresAt: string;
}

@ApiTags('Authentication')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly credentials: CredentialsService,
    private readonly mfa: MfaService,
    private readonly principals: PrincipalService,
    private readonly sessions: SessionService,
    private readonly config: AppConfigService,
  ) {}

  // -------------------------------------------------------------------------
  // Registration & login
  // -------------------------------------------------------------------------

  @Post('register')
  @Public()
  @RateLimit('sensitive')
  @ApiOperation({
    summary: 'Create a customer account',
    description:
      'Creates the user, the customer record and the consent ledger entries in one transaction, then signs the customer in.',
  })
  @ApiOkResponse({ description: 'The account was created and a session started.' })
  async register(
    @Body(zodBody(registerSchema)) input: RegisterInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponse> {
    const session = await this.auth.register(input, requestContextFrom(request));
    return this.respondWithSession(response, session, request);
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  @RateLimit('auth')
  @ApiOperation({
    summary: 'Sign in',
    description:
      'Returns a session, or an MFA challenge when the account has a second factor. Failures are indistinguishable between "no such account" and "wrong password".',
  })
  @ApiUnauthorizedResponse({ description: 'Email address or password is incorrect.' })
  @ApiTooManyRequestsResponse({ description: 'Too many attempts from this client.' })
  async login(
    @Body(zodBody(loginSchema)) input: LoginInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<
    | SessionResponse
    | { status: 'MFA_REQUIRED'; challengeToken: string; expiresAt: string; methods: string[] }
  > {
    const outcome = await this.auth.login(input, requestContextFrom(request));

    if (outcome.status === 'MFA_REQUIRED') {
      return {
        status: 'MFA_REQUIRED',
        challengeToken: outcome.challengeToken,
        expiresAt: outcome.expiresAt.toISOString(),
        methods: outcome.methods,
      };
    }
    return this.respondWithSession(response, outcome.session, request);
  }

  @Post('mfa/verify')
  @Public()
  @HttpCode(200)
  @RateLimit('auth')
  @ApiOperation({
    summary: 'Complete the second authentication factor',
    description: 'Consumes the single-use challenge token issued by /auth/login.',
  })
  async verifyMfa(
    @Body(zodBody(mfaVerifySchema)) input: MfaVerifyInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponse> {
    const session = await this.auth.verifyMfa(input, requestContextFrom(request));
    return this.respondWithSession(response, session, request);
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  @Post('refresh')
  @Public()
  @HttpCode(200)
  @RateLimit('auth')
  @ApiOperation({
    summary: 'Exchange a refresh token for a new session',
    description:
      'Rotates the refresh token. Presenting an already-used token revokes the entire session family.',
  })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponse> {
    const token = extractRefreshToken(request);
    if (!token) {
      throw AppException.unauthorized(
        ERROR_CODES.SESSION_EXPIRED,
        'Your session has expired. Please sign in again.',
      );
    }
    try {
      const session = await this.auth.refresh(token, requestContextFrom(request));
      return this.respondWithSession(response, session, request);
    } catch (error) {
      // Whatever went wrong, the client's cookies are now useless: clear them
      // so the browser stops replaying a dead token.
      clearAuthCookies(response, this.config);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(204)
  @MfaEnrollmentExempt()
  @ApiOperation({ summary: 'End the current session' })
  @ApiNoContentResponse({ description: 'The session was ended.' })
  async logout(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(principal.sessionId, requestContextFrom(request), principal.userId);
    clearAuthCookies(response, this.config);
  }

  @Post('logout-all')
  @HttpCode(200)
  @MfaEnrollmentExempt()
  @ApiOperation({
    summary: 'End every session for this account',
    description: 'Use after a suspected compromise. Signs the account out on all devices.',
  })
  async logoutAll(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ revokedSessions: number }> {
    const revoked = await this.auth.logoutAll(principal.userId, requestContextFrom(request));
    clearAuthCookies(response, this.config);
    return { revokedSessions: revoked };
  }

  @Get('me')
  @MfaEnrollmentExempt()
  @ApiOperation({ summary: 'The signed-in user, with effective roles and permissions' })
  async me(@CurrentUser() principal: AuthenticatedPrincipal): Promise<PublicUser> {
    const profile = await this.principals.loadProfile(principal.userId);
    if (!profile) throw new UnauthorizedException();
    return this.auth.toPublicUser(profile);
  }

  @Get('sessions')
  @MfaEnrollmentExempt()
  @ApiOperation({ summary: 'List active sessions for the signed-in user' })
  async listSessions(@CurrentUser() principal: AuthenticatedPrincipal): Promise<{
    data: Array<{
      id: string;
      current: boolean;
      issuedAt: string;
      expiresAt: string;
      lastUsedAt: string | null;
      ipAddress: string | null;
      userAgent: string | null;
      mfaSatisfied: boolean;
    }>;
  }> {
    const sessions = await this.sessions.listForUser(principal.userId);
    return {
      data: sessions.map((session) => ({
        id: session.id,
        current: session.id === principal.sessionId,
        issuedAt: session.issuedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        lastUsedAt: session.lastUsedAt?.toISOString() ?? null,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        mfaSatisfied: session.mfaSatisfied,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Credentials
  // -------------------------------------------------------------------------

  @Post('password/forgot')
  @Public()
  @HttpCode(202)
  @RateLimit('sensitive')
  @ApiOperation({
    summary: 'Request a password reset link',
    description:
      'Always returns 202 regardless of whether the address is registered, so the endpoint cannot be used to enumerate accounts.',
  })
  async forgotPassword(
    @Body(zodBody(requestPasswordResetSchema)) input: RequestPasswordResetInput,
    @Req() request: Request,
  ): Promise<{ status: string }> {
    await this.credentials.requestPasswordReset(input.email, requestContextFrom(request));
    return {
      status: 'If an account exists for that address, a password reset link is on its way.',
    };
  }

  @Post('password/reset')
  @Public()
  @HttpCode(204)
  @RateLimit('sensitive')
  @ApiOperation({
    summary: 'Set a new password using a reset token',
    description: 'Consumes the token and revokes every existing session for the account.',
  })
  async resetPassword(
    @Body(zodBody(resetPasswordSchema)) input: ResetPasswordInput,
    @Req() request: Request,
  ): Promise<void> {
    await this.credentials.resetPassword(input.token, input.password, requestContextFrom(request));
  }

  @Post('password/change')
  @HttpCode(204)
  @MfaEnrollmentExempt()
  @ApiOperation({
    summary: 'Change your password',
    description: 'Requires the current password. Signs out every other session.',
  })
  async changePassword(
    @Body(zodBody(changePasswordSchema)) input: ChangePasswordInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<void> {
    await this.credentials.changePassword(
      principal.userId,
      input.currentPassword,
      input.newPassword,
      {
        ...requestContextFrom(request),
        currentSessionId: principal.sessionId,
      },
    );
  }

  @Post('email/verify')
  @Public()
  @HttpCode(204)
  @ApiOperation({ summary: 'Confirm an email address with a verification token' })
  async verifyEmail(
    @Body(zodBody(verifyEmailSchema)) input: VerifyEmailInput,
    @Req() request: Request,
  ): Promise<void> {
    await this.credentials.verifyEmail(input.token, requestContextFrom(request));
  }

  @Post('email/resend')
  @HttpCode(202)
  @RateLimit('sensitive')
  @ApiOperation({ summary: 'Send another email verification link' })
  async resendVerification(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<{ status: string }> {
    await this.credentials.resendVerification(principal.userId, requestContextFrom(request));
    return {
      status: 'A verification email has been sent if the address is not already confirmed.',
    };
  }

  // -------------------------------------------------------------------------
  // MFA management
  // -------------------------------------------------------------------------

  @Get('mfa')
  @MfaEnrollmentExempt()
  @ApiOperation({ summary: 'Multi-factor status for the signed-in user' })
  async mfaStatus(
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<{ enabled: boolean; remainingRecoveryCodes: number }> {
    return this.mfa.status(principal.userId);
  }

  @Post('mfa/enroll')
  @HttpCode(200)
  @MfaEnrollmentExempt()
  @ApiOperation({
    summary: 'Begin TOTP enrolment',
    description:
      'Returns a provisioning URI and the shared secret. Both are shown once and never retrievable again.',
  })
  async startEnrollment(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<{ factorId: string; uri: string; secret: string }> {
    return this.mfa.startEnrollment(principal.userId, requestContextFrom(request));
  }

  @Post('mfa/enroll/confirm')
  @HttpCode(200)
  @MfaEnrollmentExempt()
  @ApiOperation({
    summary: 'Activate a pending TOTP factor',
    description:
      'Returns single-use recovery codes. They are displayed once and cannot be re-read.',
  })
  @ApiBody({ description: 'The factor id from /auth/mfa/enroll plus a current code.' })
  async confirmEnrollment(
    @Body(zodBody(mfaEnrollConfirmSchema)) input: MfaEnrollConfirmInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<{ recoveryCodes: string[] }> {
    return this.mfa.completeEnrollment(principal.userId, input.factorId, input.code, {
      ...requestContextFrom(request),
      currentSessionId: principal.sessionId,
    });
  }

  @Post('mfa/recovery-codes')
  @HttpCode(200)
  @MfaEnrollmentExempt()
  @ApiOperation({ summary: 'Replace the recovery codes for this account' })
  async regenerateRecoveryCodes(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<{ recoveryCodes: string[] }> {
    const recoveryCodes = await this.mfa.regenerateRecoveryCodes(
      principal.userId,
      requestContextFrom(request),
    );
    return { recoveryCodes };
  }

  @Post('mfa/disable')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Turn off multi-factor authentication',
    description:
      'Requires both the current password and a current code. Refused outright for roles where MFA is mandatory.',
  })
  async disableMfa(
    @Body(zodBody(mfaDisableSchema)) input: MfaDisableInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<void> {
    await this.mfa.disable(principal.userId, input, requestContextFrom(request));
  }

  // -------------------------------------------------------------------------

  private respondWithSession(
    response: Response,
    session: AuthenticatedSession,
    request?: Request,
  ): SessionResponse {
    // Reuse the caller's existing CSRF value when it has one. Minting a new
    // token on every session response would churn the cookie on each refresh
    // and could race a request that read the previous value a moment earlier.
    const existing = (request as (Request & { cookies?: Record<string, string> }) | undefined)
      ?.cookies?.[CSRF_COOKIE];
    const csrfToken =
      typeof existing === 'string' && existing.length >= 32
        ? existing
        : randomBytes(32).toString('base64url');
    setAuthCookies(response, this.config, {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      csrfToken,
    });
    return {
      user: session.user,
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
    };
  }
}
