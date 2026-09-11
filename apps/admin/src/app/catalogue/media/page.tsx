import type { Metadata } from 'next';
import { Alert, Card, EmptyState, PageHeader } from '@health/ui';
import { listMedia } from '@/lib/catalogue';
import { currentUser } from '@/lib/session';
import { formatDateTime } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { MediaUploader } from '@/components/media-uploader';

export const metadata: Metadata = { title: 'Media' };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function MediaPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'PRODUCT_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="PRODUCT_READ" />
      </ConsoleShell>
    );
  }

  const media = await listMedia();

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Media"
          description="Product photography, labels and facts panels. Files are stored under a key derived from their contents, so the same image uploaded twice is one stored object."
        />

        <Alert tone="info">
          Every upload is decoded before it is trusted, re-encoded to strip camera metadata
          (including GPS coordinates), and served with a content type derived from the bytes rather
          than the filename. SVG is rejected: it is a document format that can carry script.
        </Alert>

        {hasPermission(user, 'PRODUCT_WRITE') ? (
          <Card>
            <h2 className="text-lg font-semibold text-slate-900">Upload</h2>
            <div className="mt-4">
              <MediaUploader />
            </div>
          </Card>
        ) : null}

        <Card>
          <h2 className="text-lg font-semibold text-slate-900">Library</h2>
          {media.length === 0 ? (
            <EmptyState title="Nothing uploaded yet" description="Upload the first image above." />
          ) : (
            <ul className="mt-4 grid gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {media.map((item) => (
                <li key={item.id} className="rounded-lg ring-1 ring-slate-200">
                  {item.url ? (
                    // A plain <img>: media is served from a configurable
                    // object-storage origin.
                    <img
                      src={item.renditions.small ?? item.url}
                      alt={item.filename}
                      className="aspect-square w-full rounded-t-lg object-cover"
                    />
                  ) : (
                    <div className="flex aspect-square items-center justify-center rounded-t-lg bg-slate-100 text-xs text-slate-500">
                      unavailable
                    </div>
                  )}
                  <div className="p-2 text-xs">
                    <p className="truncate font-medium text-slate-800" title={item.filename}>
                      {item.filename}
                    </p>
                    <p className="text-slate-500">
                      {item.width ?? '?'}×{item.height ?? '?'} · {formatBytes(item.byteSize)}
                    </p>
                    <p className="text-slate-500">{formatDateTime(item.createdAt)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </ConsoleShell>
  );
}
