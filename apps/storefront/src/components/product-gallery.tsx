'use client';

import { useState } from 'react';
import type { CatalogueImage } from '@/lib/catalogue';

/**
 * Product photography.
 *
 * The label and facts-panel images are given explicit captions rather than
 * being mixed anonymously into the gallery: they are the pictures a customer
 * uses to check a dosage or an allergen, and finding them should not depend on
 * recognising a thumbnail.
 *
 * The first image renders eagerly with no client state, so the page is complete
 * before hydration — a listing that needs JavaScript to show its label would be
 * a poor way to present safety information.
 */

const ROLE_CAPTIONS: Record<string, string> = {
  LABEL: 'Product label',
  FACTS_PANEL: 'Supplement facts panel',
  CERTIFICATE: 'Certificate',
};

export function ProductGallery({
  images,
  productName,
}: {
  images: Array<CatalogueImage & { role: string }>;
  productName: string;
}) {
  const [selected, setSelected] = useState(0);

  if (images.length === 0) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-xl bg-slate-100 text-sm text-slate-500">
        No photograph of {productName} yet.
      </div>
    );
  }

  const current = images[Math.min(selected, images.length - 1)]!;
  const caption = ROLE_CAPTIONS[current.role];

  return (
    <div>
      <figure className="overflow-hidden rounded-xl bg-white ring-1 ring-slate-200">
        {/* A plain <img>: media is served from a configurable object-storage
            origin, which next/image would need allow-listed at build time, and
            the renditions are already sized by the pipeline. */}
        <img
          src={current.renditions.large ?? current.url}
          alt={current.altText}
          width={current.width ?? undefined}
          height={current.height ?? undefined}
          className="aspect-square w-full object-contain"
        />
        {caption ? (
          <figcaption className="border-t border-slate-200 px-4 py-2 text-sm text-slate-600">
            {caption}
          </figcaption>
        ) : null}
      </figure>

      {images.length > 1 ? (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Other photographs">
          {images.map((image, index) => (
            <li key={`${image.url}-${index}`}>
              <button
                type="button"
                onClick={() => setSelected(index)}
                aria-pressed={index === selected}
                aria-label={`Show ${ROLE_CAPTIONS[image.role] ?? image.altText}`}
                className={`overflow-hidden rounded-lg ring-2 transition ${
                  index === selected ? 'ring-brand-600' : 'ring-transparent hover:ring-slate-300'
                }`}
              >
                {/* Plain <img>, for the reason given above. */}
                <img
                  src={image.renditions.thumb ?? image.url}
                  alt=""
                  width={72}
                  height={72}
                  loading="lazy"
                  className="h-18 w-18 object-cover"
                  style={{ width: 72, height: 72 }}
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
