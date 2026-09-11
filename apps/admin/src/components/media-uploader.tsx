'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Alert, Button } from '@health/ui';

/**
 * Uploading an image.
 *
 * Goes through this app's own proxy route, as every other request does, so the
 * access token stays in an httpOnly cookie the browser attaches itself. The
 * body is `multipart/form-data` rather than JSON, which is why this does not
 * use `clientRequest` — the CSRF header is still attached by hand.
 *
 * The type check here is a courtesy that saves a round trip. The real decision
 * is made server-side by decoding the bytes: a filename and a declared content
 * type are both attacker-controlled, and neither is evidence of anything.
 */
function readCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)hc_csrf=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

const ACCEPTED = 'image/jpeg,image/png,image/webp,image/avif,image/gif';

export function MediaUploader() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);

  async function upload(file: File): Promise<void> {
    setUploading(true);
    setError(null);
    setUploaded(null);

    try {
      const body = new FormData();
      body.append('file', file);

      const csrf = readCsrfToken();
      const response = await fetch('/api/proxy/api/v1/media/images', {
        method: 'POST',
        headers: csrf ? { 'X-CSRF-Token': csrf } : {},
        body,
      });

      const payload = (await response.json()) as {
        id?: string;
        filename?: string;
        error?: { message?: string; details?: Array<{ message: string }> };
      };

      if (!response.ok) {
        setError(
          payload.error?.details?.[0]?.message ??
            payload.error?.message ??
            'That file could not be uploaded.',
        );
        return;
      }

      setUploaded(payload.filename ?? 'the image');
      if (inputRef.current) inputRef.current.value = '';
      router.refresh();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="media-file" className="block text-sm font-medium text-slate-900">
          Image file
        </label>
        <p className="mt-1 text-sm text-slate-500">
          JPEG, PNG, WebP, AVIF or GIF. Camera metadata is stripped on upload.
        </p>
        <input
          id="media-file"
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          disabled={uploading}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
          className="mt-2 block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-800"
        />
      </div>

      {uploading ? (
        <Button loading disabled>
          Uploading
        </Button>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {uploaded ? <Alert tone="success">Uploaded {uploaded}.</Alert> : null}
    </div>
  );
}
