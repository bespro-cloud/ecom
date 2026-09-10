import Link from 'next/link';
import { Button, Card } from '@health/ui';
import { currentUser } from '@/lib/session';

export default async function HomePage() {
  const user = await currentUser();

  return (
    <>
      <section className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
          <div className="max-w-prose">
            <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">
              United States
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
              Wellness products, documented properly.
            </h1>
            <p className="mt-6 text-lg leading-relaxed text-slate-600">
              Every product we list carries its full ingredient record, its manufacturing and lot
              details, and a plain-language summary of what the available evidence does — and does
              not — support. Nothing is published until a qualified reviewer has signed it off.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              {user ? (
                <Link href="/account">
                  <Button size="lg">Go to your account</Button>
                </Link>
              ) : (
                <>
                  <Link href="/register">
                    <Button size="lg">Create an account</Button>
                  </Link>
                  <Link href="/login">
                    <Button size="lg" variant="secondary">
                      Sign in
                    </Button>
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
          How we handle what we sell
        </h2>
        <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <Card as="article">
            <h3 className="text-base font-semibold text-slate-900">Reviewed before publication</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              A product cannot be listed until its ingredients, warnings, documentation and any
              claims have passed a recorded compliance review. The review history is kept
              permanently.
            </p>
          </Card>
          <Card as="article">
            <h3 className="text-base font-semibold text-slate-900">Traceable to the lot</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              Stock is tracked by batch and expiry date, and orders are filled from the
              earliest-expiring eligible lot. If a lot is ever withdrawn, we know exactly who
              received it.
            </p>
          </Card>
          <Card as="article">
            <h3 className="text-base font-semibold text-slate-900">Careful about claims</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              We describe what a product contains and cite the evidence we hold. We do not tell you
              it will treat, cure or prevent anything, because that is not something a retailer can
              honestly say.
            </p>
          </Card>
        </div>

        <div className="mt-12 rounded-xl bg-white p-6 ring-1 ring-slate-200">
          <h2 className="text-base font-semibold text-slate-900">A note on health information</h2>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-slate-600">
            Nothing on this site is medical advice, and none of it is a substitute for speaking to a
            qualified healthcare professional. If you are pregnant, nursing, taking medication or
            managing a health condition, talk to your clinician before adding a supplement.
          </p>
        </div>
      </section>
    </>
  );
}
