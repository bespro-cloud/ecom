#!/usr/bin/env node
/**
 * Scans tracked files for credentials that look real.
 *
 * This is a last line of defence, not a substitute for keeping secrets out of
 * the repository in the first place. It is deliberately conservative: a false
 * positive costs a minute, a missed key costs a rotation.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'AWS secret access key', re: /\baws_secret_access_key\s*=\s*\S{40}/i },
  { name: 'Stripe live secret key', re: /\bsk_live_[0-9a-zA-Z]{24,}/ },
  { name: 'Stripe live publishable key', re: /\bpk_live_[0-9a-zA-Z]{24,}/ },
  { name: 'Stripe webhook secret', re: /\bwhsec_[0-9a-zA-Z]{32,}/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[0-9A-Za-z]{36,}/ },
  { name: 'Slack token', re: /\bxox[abprs]-[0-9A-Za-z-]{10,}/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[0-9A-Za-z_-]{20,}/ },
  { name: 'OpenAI API key', re: /\bsk-[A-Za-z0-9]{48}\b/ },
  { name: 'Twilio auth token', re: /\bSK[0-9a-fA-F]{32}\b/ },
  { name: 'private key block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'database URL with a real-looking password', re: /postgres(?:ql)?:\/\/[^:\s]+:(?!password|postgres|healthcommerce|pass\b)[^@\s]{12,}@/ },
];

/** Files that legitimately contain example or obviously-fake values. */
const ALLOWED = [
  /^\.env\.example$/,
  /^scripts\/check-secrets\.mjs$/,
  /^scripts\/verify-production-guards\.mjs$/,
  /^docs\//,
  /^\.github\/workflows\//,
  /\.spec\.ts$/,
  /\.e2e-spec\.ts$/,
];

const files = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((file) => !ALLOWED.some((pattern) => pattern.test(file)));

let findings = 0;

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue; // binary or unreadable
  }

  for (const { name, re } of PATTERNS) {
    const match = re.exec(content);
    if (!match) continue;
    const line = content.slice(0, match.index).split('\n').length;
    console.error(`${file}:${line}  possible ${name}`);
    findings += 1;
  }
}

// A committed .env is a finding regardless of its contents.
const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n');
for (const file of tracked) {
  if (/(^|\/)\.env$/.test(file) || /(^|\/)\.env\.(local|production|staging)$/.test(file)) {
    console.error(`${file}  environment file is tracked in git`);
    findings += 1;
  }
}

if (findings > 0) {
  console.error(`\n${findings} potential secret(s) found. Rotate anything real and remove it from history.`);
  process.exit(1);
}
console.log('No credentials found in tracked files.');
