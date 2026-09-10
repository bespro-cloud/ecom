import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export type AlertTone = 'info' | 'success' | 'warning' | 'error';

const TONES: Record<AlertTone, { container: string; title: string }> = {
  info: { container: 'bg-sky-50 ring-sky-200 text-sky-900', title: 'text-sky-900' },
  success: {
    container: 'bg-emerald-50 ring-emerald-200 text-emerald-900',
    title: 'text-emerald-900',
  },
  warning: { container: 'bg-amber-50 ring-amber-200 text-amber-900', title: 'text-amber-900' },
  error: { container: 'bg-red-50 ring-red-200 text-red-900', title: 'text-red-900' },
};

export interface AlertProps {
  tone?: AlertTone;
  title?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Errors and warnings are announced assertively; informational messages
 * politely. Getting this wrong either interrupts the user for nothing or lets
 * a failure pass unnoticed.
 */
export function Alert({ tone = 'info', title, children, className }: AlertProps) {
  const isUrgent = tone === 'error' || tone === 'warning';
  return (
    <div
      role={isUrgent ? 'alert' : 'status'}
      aria-live={isUrgent ? 'assertive' : 'polite'}
      className={clsx('rounded-lg p-4 text-sm ring-1 ring-inset', TONES[tone].container, className)}
    >
      {title ? <p className={clsx('font-semibold', TONES[tone].title)}>{title}</p> : null}
      <div className={title ? 'mt-1' : undefined}>{children}</div>
    </div>
  );
}

export interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 px-6 py-12 text-center">
      {icon ? <div className="mx-auto mb-3 text-slate-400">{icon}</div> : null}
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{description}</p>
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

/** Skeleton placeholder. Hidden from assistive technology — it conveys nothing. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={clsx('animate-pulse rounded bg-slate-200', className)} />
  );
}

export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-14 w-full" />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
