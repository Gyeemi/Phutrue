/**
 * IPC boundary: schema validation and channel allowlisting.
 *
 * These tests exercise the schemas directly because that is where all
 * authorization-relevant parsing happens. The router wrapper adds the sender
 * check and error conversion, which are covered separately.
 *
 * The threat model: the renderer is web content and may be compromised by a
 * malicious message body. A schema failure must reject, never coerce.
 */

import { describe, expect, it } from 'vitest';
import { CHANNELS } from '../src/shared/ipc.js';
import { SCHEMAS } from '../src/main/ipc/schemas.js';

/**
 * The account schema is exercised directly here. `SCHEMAS['accounts:create']`
 * is that same object, typed as possibly-undefined; this alias keeps the
 * cross-field tests readable.
 */
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const ACCOUNT_DRAFT = SCHEMAS['accounts:create']!;

const validAccount = {
  label: 'Work',
  email: 'someone@example.com',
  displayName: 'Someone',
  password: 'hunter2',
  imapHost: 'imap.example.com',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp.example.com',
  smtpPort: 465,
  smtpSecure: true,
};

describe('channel allowlist', () => {
  it('every channel has a schema entry or is explicitly argument-free', () => {
    for (const ch of CHANNELS) {
      expect(Object.prototype.hasOwnProperty.call(SCHEMAS, ch)).toBe(true);
    }
  });

  it('has no schema for a channel that is not in the allowlist', () => {
    const known = new Set<string>(CHANNELS);
    for (const key of Object.keys(SCHEMAS)) {
      expect(known.has(key)).toBe(true);
    }
  });

  it('has no duplicate channel names', () => {
    expect(new Set(CHANNELS).size).toBe(CHANNELS.length);
  });
});

describe('accounts:create', () => {
  const schema = SCHEMAS['accounts:create'];

  it('accepts a well-formed draft', () => {
    expect(schema.safeParse(validAccount).success).toBe(true);
  });

  it('rejects a missing password', () => {
    const { password: _pw, ...rest } = validAccount;
    expect(schema.safeParse(rest).success).toBe(false);
  });

  it('rejects an out-of-range port', () => {
    expect(schema.safeParse({ ...validAccount, imapPort: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...validAccount, imapPort: 70000 }).success).toBe(false);
    expect(schema.safeParse({ ...validAccount, imapPort: 993.5 }).success).toBe(false);
  });

  it('rejects an empty host', () => {
    expect(schema.safeParse({ ...validAccount, imapHost: '   ' }).success).toBe(false);
  });

  it('rejects oversized input rather than truncating it', () => {
    expect(schema.safeParse({ ...validAccount, label: 'x'.repeat(1000) }).success).toBe(false);
  });
});

describe('messages:setFlags', () => {
  const schema = SCHEMAS['messages:setFlags'];

  it('accepts a read toggle', () => {
    expect(schema.safeParse({ messageIds: [1, 2], read: true }).success).toBe(true);
  });

  it('rejects an empty id list', () => {
    expect(schema.safeParse({ messageIds: [], read: true }).success).toBe(false);
  });

  it('rejects a non-positive id', () => {
    expect(schema.safeParse({ messageIds: [0], read: true }).success).toBe(false);
    expect(schema.safeParse({ messageIds: [-5], read: true }).success).toBe(false);
  });

  it('rejects a no-op request with no flags', () => {
    expect(schema.safeParse({ messageIds: [1] }).success).toBe(false);
  });

  it('caps the batch size', () => {
    const many = Array.from({ length: 5001 }, (_, i) => i + 1);
    expect(schema.safeParse({ messageIds: many, read: true }).success).toBe(false);
  });
});

describe('messages:list', () => {
  const schema = SCHEMAS['messages:list'];

  it('clamps pageSize by rejecting out-of-range values', () => {
    expect(schema.safeParse({ folderId: 1, page: 0, pageSize: 201 }).success).toBe(false);
    expect(schema.safeParse({ folderId: 1, page: 0, pageSize: 200 }).success).toBe(true);
  });

  it('rejects a negative page', () => {
    expect(schema.safeParse({ folderId: 1, page: -1 }).success).toBe(false);
  });
});

describe('settings:update', () => {
  const schema = SCHEMAS['settings:update'];

  it('accepts a partial patch', () => {
    expect(schema.safeParse({ theme: 'dark' }).success).toBe(true);
  });

  it('rejects an unknown key', () => {
    // A typo must not silently no-op.
    expect(schema.safeParse({ theme: 'dark', nope: 1 }).success).toBe(false);
  });

  it('rejects an invalid enum value', () => {
    expect(schema.safeParse({ theme: 'neon' }).success).toBe(false);
  });

  it('rejects an out-of-range interval', () => {
    expect(schema.safeParse({ syncIntervalSeconds: -1 }).success).toBe(false);
  });
});

describe('mail:send', () => {
  const schema = SCHEMAS['mail:send'];
  const base = {
    accountId: 1,
    to: ['a@example.com'],
    cc: [],
    bcc: [],
    subject: 'Hi',
    html: '<p>Hello</p>',
    attachments: [],
  };

  it('accepts a minimal message', () => {
    expect(schema.safeParse(base).success).toBe(true);
  });

  it('rejects more than 100 recipients', () => {
    const to = Array.from({ length: 101 }, (_, i) => `u${i}@example.com`);
    expect(schema.safeParse({ ...base, to }).success).toBe(false);
  });

  it('rejects an oversized body', () => {
    expect(schema.safeParse({ ...base, html: 'x'.repeat(2_000_001) }).success).toBe(false);
  });

  it('rejects more than 50 attachments', () => {
    const attachments = Array.from({ length: 51 }, (_, i) => `/tmp/f${i}`);
    expect(schema.safeParse({ ...base, attachments }).success).toBe(false);
  });

  it('rejects a non-boolean-typed numeric string for accountId', () => {
    expect(schema.safeParse({ ...base, accountId: '1' }).success).toBe(false);
  });
});

describe('argument-free channels', () => {
  it('are declared as undefined so the router accepts no payload', () => {
    expect(SCHEMAS['app:info']).toBeUndefined();
    expect(SCHEMAS['accounts:list']).toBeUndefined();
    expect(SCHEMAS['attachments:pick']).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Account cross-field rules
 *
 * Added after a security review: an OAuth account must not be accepted with no
 * provider, and a password account must not be accepted with no host. The
 * rejection must name the field and never echo the password.
 * ------------------------------------------------------------------ */

describe('account creation cross-field rules', () => {
  const base = {
    label: 'Work',
    email: 'me@example.com',
    displayName: 'Me',
    password: 'super-secret-value',
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    smtpSecure: true,
  };

  it('accepts a complete password account', () => {
    const r = ACCOUNT_DRAFT.safeParse(base);
    expect(r.success).toBe(true);
  });

  it('accepts an OAuth account with a provider', () => {
    // The value must match `OAuthProvider` in models.ts AND the CHECK constraint
    // on accounts.oauth_provider. 'google' is the canonical spelling; 'gmail' is
    // a trap because that is the provider's mail domain, not its identifier.
    for (const provider of ['google', 'microsoft']) {
      const r = ACCOUNT_DRAFT.safeParse({ ...base, authKind: 'oauth2', oauthProvider: provider });
      expect(r.success).toBe(true);
    }
  });

  it('rejects the mail-domain spelling of a provider', () => {
    const r = ACCOUNT_DRAFT.safeParse({ ...base, authKind: 'oauth2', oauthProvider: 'gmail' });
    expect(r.success).toBe(false);
  });

  it('rejects an OAuth account with no provider', () => {
    const r = ACCOUNT_DRAFT.safeParse({ ...base, authKind: 'oauth2' });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown OAuth provider', () => {
    const r = ACCOUNT_DRAFT.safeParse({ ...base, authKind: 'oauth2', oauthProvider: 'yahoo' });
    expect(r.success).toBe(false);
  });

  it('rejects a password account with a blank IMAP host', () => {
    const r = ACCOUNT_DRAFT.safeParse({ ...base, authKind: 'password', imapHost: '' });
    expect(r.success).toBe(false);
  });

  it('never echoes the password in the rejection', () => {
    const r = ACCOUNT_DRAFT.safeParse({ ...base, authKind: 'password', smtpHost: '' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.success ? [] : r.error.issues)).not.toContain('super-secret-value');
  });
});

/* ------------------------------------------------------------------ *
 * Cross-layer enum agreement
 *
 * A zod enum that disagrees with the database CHECK constraint fails at the
 * worst possible moment: after validation has passed, inside an INSERT, as an
 * opaque SQLite error. This actually happened — the schema accepted 'gmail'
 * while the type and the CHECK constraint both used 'google'.
 * ------------------------------------------------------------------ */

describe('account enums agree across layers', () => {
  it('OAuth provider spellings match the CHECK constraint', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const migration = readFileSync(
      path.resolve(__dirname, '..', 'src', 'main', 'db', 'migrations', 'index.ts'),
      'utf8'
    );

    const check = /oauth_provider\s+TEXT\s+CHECK \(oauth_provider IN \(([^)]+)\)\)/.exec(migration);
    expect(check).not.toBeNull();
    const inDb = [...(check?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

    // Accepted by the schema…
    const accepted: string[] = [];
    for (const candidate of ['google', 'microsoft', 'gmail', 'yahoo']) {
      const r = ACCOUNT_DRAFT.safeParse({
        label: 'x',
        email: 'a@b.co',
        displayName: 'x',
        password: 'p',
        authKind: 'oauth2',
        oauthProvider: candidate,
        // Realistic hosts so only the provider enum can fail — the base schema
        // still requires non-empty host strings even for an OAuth account.
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecure: true,
        smtpHost: 'smtp.example.com',
        smtpPort: 465,
        smtpSecure: true,
      });
      if (r.success) accepted.push(candidate);
    }

    // …must equal what the database will store, or the INSERT fails later.
    expect(accepted.sort()).toEqual(inDb);
  });

  it('authKind spellings match the CHECK constraint', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const migration = readFileSync(
      path.resolve(__dirname, '..', 'src', 'main', 'db', 'migrations', 'index.ts'),
      'utf8'
    );
    const check = /auth_kind\s+TEXT\s+NOT NULL CHECK \(auth_kind IN \(([^)]+)\)\)/.exec(migration);
    expect(check).not.toBeNull();
    const inDb = [...(check?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(inDb).toEqual(['oauth2', 'password']);
  });
});

