import { LoadingRows } from '@health/ui';

export default function Loading() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
      <LoadingRows rows={4} />
    </div>
  );
}
