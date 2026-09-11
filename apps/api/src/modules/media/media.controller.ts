import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { uuidSchema } from '@health/validation';
import { z } from 'zod';
import type { AuthenticatedPrincipal } from '@health/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { zodBody, ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestContextFrom } from '../../common/request-context.js';
import { AppException } from '../../common/errors/app-exception.js';
import { MediaService, type MediaView, type UploadedFile as MediaUpload } from './media.service.js';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

@ApiTags('Media')
@Controller({ path: 'media', version: '1' })
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('images')
  @RequirePermissions('PRODUCT_WRITE')
  @RateLimit('sensitive')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload an image',
    description:
      'The file is decoded before it is trusted, re-encoded to strip EXIF, and stored under a key derived from its content — so the same file uploaded twice produces one object.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  async uploadImage(
    @UploadedFile() file: MediaUpload | undefined,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<MediaView> {
    if (!file) {
      throw AppException.validation([{ path: 'file', message: 'Choose a file to upload.' }]);
    }
    return this.media.uploadImage(file, {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    });
  }

  @Get()
  @RequirePermissions('PRODUCT_READ')
  @ApiOperation({ summary: 'List recently uploaded media' })
  async list(
    @Query(zodBody(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ): Promise<{ data: MediaView[] }> {
    return { data: await this.media.list(query.limit) };
  }

  @Get(':id')
  @RequirePermissions('PRODUCT_READ')
  @ApiOperation({ summary: 'Fetch one media record' })
  async findOne(@Param('id', new ZodValidationPipe(uuidSchema)) id: string): Promise<MediaView> {
    return this.media.findById(id);
  }

  @Delete(':id')
  @RequirePermissions('PRODUCT_WRITE')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a media record',
    description:
      'Soft delete. The stored object is left in place because keys are content-addressed and another record may reference the same bytes.',
  })
  async remove(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<void> {
    await this.media.remove(id, {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    });
  }
}
