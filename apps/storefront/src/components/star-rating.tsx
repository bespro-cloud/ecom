/**
 * A star rating, drawn rather than spelled out.
 *
 * The visible stars are `aria-hidden` and the real value is in the text label,
 * because a screen reader announcing "star star star star star" is worse than
 * useless. Nothing here rounds a rating up: a 4.4 shows four filled stars and
 * the number says 4.4.
 */
export function StarRating({
  value,
  label,
  size = 'md',
}: {
  value: number;
  label?: string;
  size?: 'sm' | 'md';
}) {
  const filled = Math.floor(value);
  const dimension = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';

  return (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden className="inline-flex">
        {[1, 2, 3, 4, 5].map((star) => (
          <svg
            key={star}
            viewBox="0 0 20 20"
            className={`${dimension} ${star <= filled ? 'text-amber-500' : 'text-slate-300'}`}
            fill="currentColor"
          >
            <path d="M10 1.5l2.6 5.27 5.82.85-4.21 4.1.99 5.79L10 14.78l-5.2 2.73.99-5.79-4.21-4.1 5.82-.85L10 1.5z" />
          </svg>
        ))}
      </span>
      <span className="sr-only">{label ?? `${value} out of 5`}</span>
    </span>
  );
}
