import { clsx } from 'clsx';
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  /** Validation message. Its presence puts the field into the error state. */
  error?: string;
  /** Guidance shown under the label; announced along with the field. */
  hint?: string;
}

/**
 * A labelled input.
 *
 * Every input has a real `<label>` bound by id, hints and errors are wired
 * through `aria-describedby`, and errors carry `role="alert"` so they are
 * announced when they appear rather than only being visible.
 */
export function Field({ label, error, hint, className, required, ...rest }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-900">
        {label}
        {required ? (
          <span className="ml-1 text-red-600" aria-hidden="true">
            *
          </span>
        ) : null}
        {required ? <span className="sr-only"> (required)</span> : null}
      </label>
      {hint ? (
        <p id={hintId} className="text-sm text-slate-500">
          {hint}
        </p>
      ) : null}
      <input
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={clsx(
          'block w-full rounded-lg border-0 px-3 py-2.5 text-slate-900 shadow-sm ring-1 ring-inset',
          'placeholder:text-slate-400 focus:ring-2 focus:ring-inset sm:text-sm',
          error ? 'ring-red-500 focus:ring-red-600' : 'ring-slate-300 focus:ring-brand-600',
          className,
        )}
        {...rest}
      />
      {error ? (
        <p id={errorId} role="alert" className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}

export function SelectField({
  label,
  error,
  hint,
  className,
  required,
  children,
  ...rest
}: SelectFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-900">
        {label}
        {required ? <span className="sr-only"> (required)</span> : null}
      </label>
      {hint ? (
        <p id={hintId} className="text-sm text-slate-500">
          {hint}
        </p>
      ) : null}
      <select
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={clsx(
          'block w-full rounded-lg border-0 px-3 py-2.5 text-slate-900 shadow-sm ring-1 ring-inset',
          'focus:ring-2 focus:ring-inset sm:text-sm',
          error ? 'ring-red-500 focus:ring-red-600' : 'ring-slate-300 focus:ring-brand-600',
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      {error ? (
        <p id={errorId} role="alert" className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> {
  label: ReactNode;
  error?: string;
  hint?: string;
}

export function Checkbox({ label, error, hint, className, ...rest }: CheckboxProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div className="space-y-1">
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          aria-invalid={error ? true : undefined}
          aria-describedby={
            [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
          }
          className={clsx(
            'mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600',
            className,
          )}
          {...rest}
        />
        <label htmlFor={id} className="text-sm text-slate-700">
          {label}
        </label>
      </div>
      {hint ? (
        <p id={hintId} className="pl-7 text-sm text-slate-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="pl-7 text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
