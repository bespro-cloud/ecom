import { Module } from '@nestjs/common';
import { PagesService } from './pages.service.js';
import { SeoService } from './seo.service.js';
import { ContentController } from './content.controller.js';
import { GrowthModule } from '../growth/growth.module.js';

@Module({
  imports: [GrowthModule],
  controllers: [ContentController],
  providers: [PagesService, SeoService],
  exports: [PagesService, SeoService],
})
export class ContentModule {}
