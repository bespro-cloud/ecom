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
  Query,
  Req,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import {
  adminProductQuerySchema,
  changeProductStatusSchema,
  createCategorySchema,
  createIngredientSchema,
  createProductSchema,
  ingredientSourceSchema,
  ingredientWarningSchema,
  setProductCategoriesSchema,
  setProductDisclaimersSchema,
  setProductImagesSchema,
  setProductIngredientsSchema,
  setProductWarningsSchema,
  updateCategorySchema,
  updateIngredientSchema,
  updateProductSchema,
  uuidSchema,
} from '@health/validation';
import type {
  AdminProductQuery,
  ChangeProductStatusInput,
  CreateCategoryInput,
  CreateIngredientInput,
  CreateProductInput,
  IngredientSourceInput,
  IngredientWarningInput,
  SetProductCategoriesInput,
  SetProductDisclaimersInput,
  SetProductImagesInput,
  SetProductIngredientsInput,
  SetProductWarningsInput,
  UpdateCategoryInput,
  UpdateIngredientInput,
  UpdateProductInput,
} from '@health/validation';
import type { AuthenticatedPrincipal, Paginated, PublishReadiness } from '@health/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { zodBody, ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestContextFrom } from '../../common/request-context.js';
import { ProductsService } from './products/products.service.js';
import type { AdminProductView } from './products/product.view.js';
import { CategoriesService, type CategoryView } from './categories/categories.service.js';
import { IngredientsService, type IngredientView } from './ingredients/ingredients.service.js';

const ingredientQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(200).optional(),
  allergensOnly: z.coerce.boolean().optional(),
});

/**
 * Catalogue administration.
 *
 * Permission split worth noting: `PRODUCT_WRITE` edits a draft, but
 * `PRODUCT_PUBLISH` is what moves a listing between statuses. Someone can be
 * trusted to write product copy without being trusted to put it in front of
 * customers.
 */
@ApiTags('Catalogue administration')
@Controller({ path: 'admin/catalogue', version: '1' })
export class AdminCatalogueController {
  constructor(
    private readonly products: ProductsService,
    private readonly categories: CategoriesService,
    private readonly ingredients: IngredientsService,
  ) {}

  private actor(principal: AuthenticatedPrincipal, request: Request) {
    return {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    };
  }

  // --- products ------------------------------------------------------------

  @Get('products')
  @RequirePermissions('PRODUCT_READ')
  @ApiOperation({ summary: 'List products, including drafts' })
  async listProducts(
    @Query(zodBody(adminProductQuerySchema)) query: AdminProductQuery,
  ): Promise<Paginated<AdminProductView>> {
    return this.products.list(query);
  }

  @Get('products/:id')
  @RequirePermissions('PRODUCT_READ')
  @ApiOperation({ summary: 'Fetch a product with all its relationships' })
  async findProduct(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<AdminProductView> {
    return this.products.findById(id);
  }

  @Post('products')
  @RequirePermissions('PRODUCT_WRITE')
  @ApiOperation({
    summary: 'Create a product',
    description:
      'Always created as a draft. There is no path that produces a publicly visible listing in one step.',
  })
  async createProduct(
    @Body(zodBody(createProductSchema)) input: CreateProductInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<AdminProductView> {
    return this.products.create(input, this.actor(principal, request));
  }

  @Patch('products/:id')
  @RequirePermissions('PRODUCT_WRITE')
  @ApiOperation({
    summary: 'Update a product',
    description:
      'Changing a compliance-relevant field re-opens the listing for review and withdraws it if it was live.',
  })
  async updateProduct(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(updateProductSchema)) input: UpdateProductInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<AdminProductView> {
    return this.products.update(id, input, this.actor(principal, request));
  }

  @Get('products/:id/readiness')
  @RequirePermissions('PRODUCT_READ')
  @ApiOperation({
    summary: 'Evaluate the publishing checklist',
    description:
      'Shows what is blocking publication. Checks belonging to a later phase are reported as not-yet-enforced rather than counted as passes.',
  })
  async readiness(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<PublishReadiness> {
    return this.products.evaluateReadiness(id);
  }

  @Put('products/:id/status')
  @RequirePermissions('PRODUCT_PUBLISH')
  @ApiOperation({
    summary: 'Change a product status',
    description:
      'Publication is gated: the checklist is evaluated here, against current data, not when the screen was rendered. Withdrawing a live listing requires a reason.',
  })
  async changeStatus(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(changeProductStatusSchema)) input: ChangeProductStatusInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<{ product: AdminProductView; readiness: PublishReadiness | null }> {
    return this.products.changeStatus(id, input, this.actor(principal, request));
  }

  @Put('products/:id/ingredients')
  @RequirePermissions('PRODUCT_WRITE')
  @ApiOperation({
    summary: 'Set a product’s ingredients',
    description: 'Changing the formulation re-opens the compliance approval.',
  })
  async setIngredients(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(setProductIngredientsSchema)) input: SetProductIngredientsInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<AdminProductView> {
    return this.products.setIngredients(id, input, this.actor(principal, request));
  }

  @Put('products/:id/categories')
  @RequirePermissions('PRODUCT_WRITE')
  @ApiOperation({ summary: 'Set a product’s categories' })
  async setCategories(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(setProductCategoriesSchema)) input: SetProductCategoriesInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<AdminProductView> {
    return this.products.setCategories(id, input, this.actor(principal, request));
  }

  @Put('products/:id/images')
  @RequirePermissions('PRODUCT_WRITE')
  @ApiOperation({
    summary: 'Set a product’s images',
    description:
      'Replaces the whole set. Alternative text is required on every image. Replacing a label or facts-panel photograph re-opens the compliance approval, because that is what the reviewer read.',
  })
  async setImages(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(setProductImagesSchema)) input: SetProductImagesInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<AdminProductView> {
    return this.products.setImages(id, input, this.actor(principal, request));
  }

  @Put('products/:id/warnings')
  @RequirePermissions('PRODUCT_WRITE')
  @ApiOperation({
    summary: 'Set a product’s warnings',
    description:
      'Replaces the whole set, and always re-opens the compliance approval. Warning text is written by a person; nothing here generates it.',
  })
  async setWarnings(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(setProductWarningsSchema)) input: SetProductWarningsInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<AdminProductView> {
    return this.products.setWarnings(id, input, this.actor(principal, request));
  }

  @Put('products/:id/disclaimers')
  @RequirePermissions('PRODUCT_WRITE')
  @ApiOperation({
    summary: 'Set a product’s disclaimers',
    description:
      'Replaces the whole set, and always re-opens the compliance approval. The text is stored on the listing so it shows the wording that was approved.',
  })
  async setDisclaimers(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(setProductDisclaimersSchema)) input: SetProductDisclaimersInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<AdminProductView> {
    return this.products.setDisclaimers(id, input, this.actor(principal, request));
  }

  @Delete('products/:id')
  @RequirePermissions('PRODUCT_WRITE')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a product',
    description:
      'Soft delete — products appear on historical orders. A live listing must be withdrawn first, so the reason is recorded.',
  })
  @ApiNoContentResponse({ description: 'The product was removed from the catalogue.' })
  async removeProduct(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<void> {
    await this.products.remove(id, this.actor(principal, request));
  }

  // --- categories ----------------------------------------------------------

  @Get('categories')
  @RequirePermissions('CATEGORY_READ')
  @ApiOperation({ summary: 'List categories, including inactive ones' })
  async listCategories(): Promise<{ data: CategoryView[] }> {
    return { data: await this.categories.list(true) };
  }

  @Post('categories')
  @RequirePermissions('CATEGORY_WRITE')
  @ApiOperation({ summary: 'Create a category' })
  async createCategory(
    @Body(zodBody(createCategorySchema)) input: CreateCategoryInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<CategoryView> {
    return this.categories.create(input, this.actor(principal, request));
  }

  @Patch('categories/:id')
  @RequirePermissions('CATEGORY_WRITE')
  @ApiOperation({
    summary: 'Update a category',
    description: 'Moving one re-points its whole subtree, in a single transaction.',
  })
  async updateCategory(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(updateCategorySchema)) input: UpdateCategoryInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<CategoryView> {
    return this.categories.update(id, input, this.actor(principal, request));
  }

  @Delete('categories/:id')
  @RequirePermissions('CATEGORY_WRITE')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an empty category' })
  async removeCategory(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<void> {
    await this.categories.remove(id, this.actor(principal, request));
  }

  // --- ingredients ---------------------------------------------------------

  @Get('ingredients')
  @RequirePermissions('INGREDIENT_READ')
  @ApiOperation({ summary: 'Search ingredients' })
  async listIngredients(
    @Query(zodBody(ingredientQuerySchema)) query: z.infer<typeof ingredientQuerySchema>,
  ): Promise<Paginated<IngredientView>> {
    return this.ingredients.list(query);
  }

  @Get('ingredients/:id')
  @RequirePermissions('INGREDIENT_READ')
  @ApiOperation({ summary: 'Fetch an ingredient' })
  async findIngredient(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<IngredientView> {
    return this.ingredients.findById(id);
  }

  @Post('ingredients')
  @RequirePermissions('INGREDIENT_WRITE')
  @ApiOperation({ summary: 'Create an ingredient' })
  async createIngredient(
    @Body(zodBody(createIngredientSchema)) input: CreateIngredientInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<IngredientView> {
    return this.ingredients.create(input, this.actor(principal, request));
  }

  @Patch('ingredients/:id')
  @RequirePermissions('INGREDIENT_WRITE')
  @ApiOperation({
    summary: 'Update an ingredient',
    description:
      'Changing the allergen flag re-opens the compliance approval of every product containing it.',
  })
  async updateIngredient(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(updateIngredientSchema)) input: UpdateIngredientInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<IngredientView> {
    return this.ingredients.update(id, input, this.actor(principal, request));
  }

  @Post('ingredients/:id/sources')
  @RequirePermissions('INGREDIENT_WRITE')
  @ApiOperation({ summary: 'Record where an ingredient is sourced from' })
  async addSource(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(ingredientSourceSchema)) input: IngredientSourceInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<IngredientView> {
    return this.ingredients.addSource(id, input, this.actor(principal, request));
  }

  @Post('ingredients/:id/warnings')
  @RequirePermissions('INGREDIENT_WRITE')
  @ApiOperation({
    summary: 'Add a warning to an ingredient',
    description:
      'Inherited by every product containing it, and therefore re-opens their compliance approvals and withdraws the published ones.',
  })
  async addWarning(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(ingredientWarningSchema)) input: IngredientWarningInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<IngredientView> {
    return this.ingredients.addWarning(id, input, this.actor(principal, request));
  }

  @Delete('ingredients/:id/warnings/:warningId')
  @RequirePermissions('INGREDIENT_WRITE')
  @ApiOperation({
    summary: 'Remove a warning',
    description: 'The removed text is kept in the audit record.',
  })
  async removeWarning(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('warningId', new ZodValidationPipe(uuidSchema)) warningId: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<IngredientView> {
    return this.ingredients.removeWarning(id, warningId, this.actor(principal, request));
  }

  @Delete('ingredients/:id')
  @RequirePermissions('INGREDIENT_WRITE')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an unused ingredient' })
  async removeIngredient(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<void> {
    await this.ingredients.remove(id, this.actor(principal, request));
  }
}
