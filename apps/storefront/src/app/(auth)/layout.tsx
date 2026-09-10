import Link from 'next/link';
import { publicConfig } from '@/lib/env';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[calc(100vh-13rem)] max-w-md flex-col justify-center px-4 py-12 sm:px-6">
      <div className="mb-8 text-center">
        <Link href="/" className="text-sm font-medium text-brand-700 hover:text-brand-800">
          ← Back to {publicConfig.siteName}
        </Link>
      </div>
      {children}
    </div>
  );
}
