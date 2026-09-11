import { Module } from '@nestjs/common';
import { PagesService } from './pages.service.js';
import { SeoService } from './seo.service.js';
import { ContentController } from './content.controller.js';

@Module({
  controllers: [ContentController],
  providers: [PagesService, SeoService],
  exports: [PagesService, SeoService],
})
export class ContentModule {}
