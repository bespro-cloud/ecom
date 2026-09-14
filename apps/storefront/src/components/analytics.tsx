'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

/**
 * First-party analytics, in the browser.
 *
 * The whole file is written on one assumption: **what somebody browses on a
 * supplements site is health-adjacent information about them.** So this does
 * several things that an ordinary analytics snippet does not.
 *
 * **It sends nothing until the visitor says yes.** Not a page view, not a
 * heartbeat, not a "consent pending" ping. Silence is not consent, and a
 * beacon fired before the banner is answered has already collected the thing
 * the banner was asking about.
 *
 * **It stops before it starts if the browser has opted out.** Global Privacy
 * Control is checked here as well as on the server, so a visitor whose browser
 * sends GPC never even has a session id generated locally.
 *
 * **The session id lives in `sessionStorage`, not `localStorage`, and not a
 * cookie.** It dies when the tab closes. Anything that survives across visits
 * is the beginning of a profile, and there is no business question here that
 * needs one.
 *
 * **It never reports a purchase.** Conversions are recorded server-side from a
 * real order. A conversion a browser can claim is a conversion anybody can
 * claim.
 *
 * There is no third-party script on this site, no pixel, no tag manager and no
 * advertising identifier. That is not an oversight to be filled in later.
 */

const SESSION_KEY = 'hc_analytics_session';
const CONSENT_KEY = 'hc_analytics_consent';
const FLUSH_DELAY_MS = 2000;

type ClientEventType =
  | 'page_view'
  | 'product_view'
  | 'search_performed'
  | 'add_to_cart'
  | 'remove_from_cart'
  | 'checkout_started';

interface QueuedEvent {
  type: ClientEventType;
  url: string;
  productId?: string;
  quantity?: number;
  occurredAt: string;
}

/** Whether the browser has asked, at the browser level, not to be measured. */
function browserOptsOut(): boolean {
  if (typeof navigator === 'undefined') return true;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean; doNotTrack?: string };
  if (nav.globalPrivacyControl === true) return true;
  if (nav.doNotTrack === '1') return true;
  if ((window as unknown as { doNotTrack?: string }).doNotTrack === '1') return true;
  return false;
}

export function readConsent(): boolean | null {
  try {
    const stored = window.localStorage.getItem(CONSENT_KEY);
    if (stored === 'granted') return true;
    if (stored === 'denied') return false;
    return null;
  } catch {
    // Private browsing, or storage blocked. Treated as "not answered", which
    // means nothing is collected.
    return null;
  }
}

export function writeConsent(granted: boolean): void {
  try {
    window.localStorage.setItem(CONSENT_KEY, granted ? 'granted' : 'denied');
  } catch {
    // Nothing to do. Without storage the banner reappears next visit, which is
    // the safe failure: it asks again rather than assuming.
  }
  window.dispatchEvent(new CustomEvent('hc:consent-changed', { detail: granted }));
}

function sessionId(): string | null {
  try {
    const existing = window.sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.sessionStorage.setItem(SESSION_KEY, created);
    return created;
  } catch {
    return null;
  }
}

/** The current visit's id, for the server to record a conversion against. */
export function currentAnalyticsSessionId(): string | null {
  if (browserOptsOut() || readConsent() !== true) return null;
  try {
    return window.sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

/**
 * The campaign labels for this visit, read once from the landing URL.
 *
 * Kept in `sessionStorage` so a customer who lands on a campaign link, browses
 * for ten minutes and then checks out is still attributed to that campaign.
 * Five named parameters and nothing else — the rest of the query string is not
 * read, let alone kept.
 */
const CAMPAIGN_KEY = 'hc_campaign';

export function captureCampaign(): void {
  try {
    if (window.sessionStorage.getItem(CAMPAIGN_KEY)) return;
    const params = new URLSearchParams(window.location.search);
    const campaign = {
      source: params.get('utm_source'),
      medium: params.get('utm_medium'),
      campaign: params.get('utm_campaign'),
    };
    if (!campaign.source && !campaign.medium && !campaign.campaign) return;
    window.sessionStorage.setItem(CAMPAIGN_KEY, JSON.stringify(campaign));
  } catch {
    // Attribution is a nice-to-have. Losing it breaks nothing.
  }
}

export function readCampaign(): {
  channel?: string;
  source?: string;
  medium?: string;
  campaign?: string;
} {
  try {
    const raw = window.sessionStorage.getItem(CAMPAIGN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { source?: string; medium?: string; campaign?: string };
    return {
      channel: parsed.medium ?? parsed.source ?? undefined,
      source: parsed.source ?? undefined,
      medium: parsed.medium ?? undefined,
      campaign: parsed.campaign ?? undefined,
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

let queue: QueuedEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0) return;
  if (browserOptsOut() || readConsent() !== true) {
    queue = [];
    return;
  }

  const id = sessionId();
  if (!id) {
    queue = [];
    return;
  }

  const body = JSON.stringify({
    sessionId: id,
    consent: true,
    events: queue.slice(0, 50),
    ...(document.referrer ? { referrer: document.referrer } : {}),
  });
  queue = [];

  // `fetch` with `keepalive` rather than `sendBeacon`.
  //
  // `sendBeacon` cannot set headers, so it could not carry the CSRF token — and
  // a signed-in visitor holds a CSRF cookie, so the API would refuse the
  // request. The alternative was to exempt this endpoint from CSRF, which would
  // have meant weakening a site-wide protection for the benefit of analytics.
  // `keepalive` survives the page closing, which was the only reason to want
  // `sendBeacon` in the first place.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const csrf = document.cookie.match(/(?:^|;\s*)hc_csrf=([^;]+)/)?.[1];
  if (csrf) headers['X-CSRF-Token'] = decodeURIComponent(csrf);

  void fetch('/api/proxy/api/v1/analytics/collect', {
    method: 'POST',
    headers,
    body,
    keepalive: true,
    credentials: 'same-origin',
  }).catch(() => undefined);
}

/**
 * Records an event, if the visitor agreed to be measured.
 *
 * Safe to call from anywhere and from any state. Called before consent, it does
 * nothing and keeps nothing — there is no pending buffer waiting to be
 * retroactively sent the moment somebody clicks accept.
 */
export function track(
  type: ClientEventType,
  options: { productId?: string; quantity?: number } = {},
): void {
  if (typeof window === 'undefined') return;
  if (browserOptsOut() || readConsent() !== true) return;

  queue.push({
    type,
    // The full URL is sent and the *server* strips the query string. The client
    // is not trusted to have removed it, and the server does not assume it did.
    url: window.location.pathname + window.location.search,
    ...(options.productId ? { productId: options.productId } : {}),
    ...(options.quantity ? { quantity: options.quantity } : {}),
    occurredAt: new Date().toISOString(),
  });

  if (queue.length >= 20) {
    flush();
    return;
  }
  if (!timer) timer = setTimeout(flush, FLUSH_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** Records a page view on every navigation, once consent exists. */
export function AnalyticsPageViews() {
  const pathname = usePathname();

  useEffect(() => {
    captureCampaign();
    track('page_view');
  }, [pathname]);

  useEffect(() => {
    const onHide = () => flush();
    // `visibilitychange` rather than `unload`: browsers have been removing
    // `unload` for years and it never fired reliably on mobile.
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  return null;
}

/**
 * The consent banner.
 *
 * Two buttons of equal weight. There is no pre-ticked box, no "legitimate
 * interest" toggle buried behind a link, and declining is one click rather than
 * a journey through a preference centre — all of which are patterns regulators
 * have named, and none of which would survive a look at this file anyway.
 */
export function AnalyticsConsentBanner() {
  const [decision, setDecision] = useState<boolean | null | 'unknown'>('unknown');

  const decide = useCallback((granted: boolean) => {
    writeConsent(granted);
    setDecision(granted);
    if (granted) {
      captureCampaign();
      track('page_view');
    }
  }, []);

  useEffect(() => {
    // A browser-level opt-out means there is nothing to ask about: honouring it
    // and then asking anyway would be asking someone to repeat themselves.
    if (browserOptsOut()) {
      setDecision(false);
      return;
    }
    setDecision(readConsent());
  }, []);

  if (decision !== null) return null;

  return (
    <div
      role="region"
      aria-label="Analytics preferences"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-slate-200 bg-white p-4 shadow-lg"
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-slate-700">
          We&rsquo;d like to count visits to see which pages are useful. It stays with us — no
          advertising networks, no profile of you, and nothing that identifies you. We don&rsquo;t
          record which products you looked at against your name, and we never will.{' '}
          <a href="/pages/privacy" className="font-medium text-brand-700 underline">
            How we handle data
          </a>
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => decide(false)}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
          >
            No thanks
          </button>
          <button
            type="button"
            onClick={() => decide(true)}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            That&rsquo;s fine
          </button>
        </div>
      </div>
    </div>
  );
}

/** Fires a product view. Rendered on a product page. */
export function TrackProductView({ productId }: { productId: string }) {
  const ref = useRef<string | null>(null);

  useEffect(() => {
    // Guarded so React's development double-render does not count two views.
    if (ref.current === productId) return;
    ref.current = productId;
    track('product_view', { productId });
  }, [productId]);

  return null;
}
