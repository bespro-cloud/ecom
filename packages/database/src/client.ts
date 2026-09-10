import { PrismaClient, Prisma } from '../generated/client/index.js';

export { Prisma, PrismaClient };
export * from '../generated/client/index.js';

export interface DatabaseClientOptions {
  databaseUrl: string;
  /** Emits query events so the caller can log slow statements. */
  logQueries?: boolean;
  statementTimeoutMs?: number;
}

/**
 * Builds the Prisma client with connection settings applied through the URL,
 * which is the only place Prisma accepts them.
 */
export function buildDatabaseUrl(base: string, poolSize: number, timeoutMs: number): string {
  const url = new URL(base);
  if (!url.searchParams.has('connection_limit')) {
    url.searchParams.set('connection_limit', String(poolSize));
  }
  if (!url.searchParams.has('pool_timeout')) {
    url.searchParams.set('pool_timeout', '10');
  }
  if (!url.searchParams.has('statement_cache_size')) {
    url.searchParams.set('statement_cache_size', '100');
  }
  url.searchParams.set('socket_timeout', String(Math.ceil(timeoutMs / 1000) + 5));
  return url.toString();
}

export function createPrismaClient(options: DatabaseClientOptions): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: options.databaseUrl } },
    log: options.logQueries
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ]
      : [
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ],
  });
}

/** Transaction client type — anything that can run queries inside a transaction. */
export type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/** Either a pooled client or an open transaction. Services accept both. */
export type DbClient = PrismaClient | TransactionClient;

export const PRISMA_ERRORS = {
  UNIQUE_CONSTRAINT: 'P2002',
  FOREIGN_KEY_CONSTRAINT: 'P2003',
  RECORD_NOT_FOUND: 'P2025',
  TRANSACTION_CONFLICT: 'P2034',
} as const;

export function isUniqueConstraintError(
  error: unknown,
  target?: string,
): error is Prisma.PrismaClientKnownRequestError {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== PRISMA_ERRORS.UNIQUE_CONSTRAINT) return false;
  if (!target) return true;
  const meta = error.meta as { target?: string[] | string } | undefined;
  const fields = Array.isArray(meta?.target) ? meta.target : meta?.target ? [meta.target] : [];
  return fields.some((field) => field.includes(target));
}

export function isNotFoundError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === PRISMA_ERRORS.RECORD_NOT_FOUND
  );
}

/**
 * True when Postgres refused the write because of the append-only trigger on
 * audit_logs / customer_consents. Surfaced distinctly so it is never mistaken
 * for a transient failure and retried.
 */
export function isAppendOnlyViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const message = String(
    (error.meta as { message?: string } | undefined)?.message ?? error.message,
  );
  return message.includes('append-only');
}
