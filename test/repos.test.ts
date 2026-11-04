/**
 * Repository behaviour against real SQLite.
 *
 * Covers the parts most likely to corrupt user data: cursor handling, UID
 * conflict on re-sync, folder pruning, pagination correctness and draft
 * round-tripping.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/main/db/database.js';
import { createAccountRepo } from '../src/main/db/repos/accounts.js';
import { createFolderRepo } from '../src/main/db/repos/folders.js';
import { createMessageRepo, type MessageInsert } from '../src/main/db/repos/messages.js';
import { createDraftRepo } from '../src/main/db/repos/drafts.js';
import { createSettingsRepo, DEFAULT_SETTINGS } from '../src/main/db/repos/settings.js';

type Db = ReturnType<typeof openDatabase>;

function setup() {
  const db = openDatabase(':memory:');
  return {
    db,
    accounts: createAccountRepo(db),
    folders: createFolderRepo(db),
    messages: createMessageRepo(db),
    drafts: createDraftRepo(db),
    settings: createSettingsRepo(db),
  };
}

const baseAccount = {
  label: 'Work',
  email: 'me@example.com',
  displayName: 'Me',
  password: 'x',
  imapHost: 'imap.example.com',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp.example.com',
  smtpPort: 465,
  smtpSecure: true,
};

function msg(folderId: number, accountId: number, uid: string, over: Partial<MessageInsert> = {}): MessageInsert {
  return {
    accountId,
    folderId,
    uid,
    messageId: `<${uid}@example.com>`,
    subject: `Subject ${uid}`,
    fromName: 'Sender',
    fromAddress: 'sender@example.com',
    toAddresses: 'me@example.com',
    ccAddresses: '',
    bccAddresses: '',
    replyTo: null,
    snippet: 'preview text',
    date: 1_700_000_000_000 + Number(uid) * 1000,
    isRead: false,
    isStarred: false,
    hasAttachments: false,
    size: 1024,
    inReplyTo: null,
    references: '',
    ...over,
  };
}

describe('account repo', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  it('creates and reads back an account, lower-casing the address', () => {
    const a = s.accounts.create(baseAccount);
    expect(a.id).toBeGreaterThan(0);
    expect(a.email).toBe('me@example.com');
    expect(a.authKind).toBe('password');
    expect(a.syncState).toBe('idle');
    expect(s.accounts.get(a.id).label).toBe('Work');
  });

  it('never exposes the secret through the model', () => {
    const secret = 'correct-horse-battery-staple';
    const a = s.accounts.create({ ...baseAccount, password: secret });

    // No credential-bearing key at all.
    expect(Object.keys(a)).not.toContain('password');
    expect(Object.keys(a)).not.toContain('credential');
    // And the literal secret never appears anywhere in the serialised model.
    // (Note: `authKind` legitimately has the VALUE "password", so the check is
    // for the secret itself, not the word.)
    expect(JSON.stringify(a)).not.toContain(secret);

    // It is also absent from the accounts table, which is the real guarantee.
    const raw = s.db.prepare('SELECT * FROM accounts WHERE id = ?').get(a.id) as unknown;
    expect(JSON.stringify(raw)).not.toContain(secret);
  });

  it('rejects a duplicate address', () => {
    s.accounts.create(baseAccount);
    expect(() => s.accounts.create(baseAccount)).toThrow();
  });

  it('finds by email case-insensitively', () => {
    s.accounts.create(baseAccount);
    expect(s.accounts.findByEmail('ME@EXAMPLE.COM')).not.toBeNull();
  });

  it('records sync state and clears the error on success', () => {
    const a = s.accounts.create(baseAccount);
    s.accounts.setSyncState(a.id, 'error', 'connection refused');
    expect(s.accounts.get(a.id).lastError).toBe('connection refused');
    s.accounts.markSynced(a.id);
    const after = s.accounts.get(a.id);
    expect(after.syncState).toBe('idle');
    expect(after.lastError).toBeNull();
    expect(after.lastSyncedAt).toBeGreaterThan(0);
  });

  it('throws NOT_FOUND rather than silently no-oping on remove', () => {
    expect(() => s.accounts.remove(999)).toThrow();
  });

  it('keeps multiple accounts independent', () => {
    const a = s.accounts.create(baseAccount);
    const b = s.accounts.create({ ...baseAccount, email: 'other@example.com', label: 'Personal' });
    expect(s.accounts.list().map((x) => x.id)).toEqual([a.id, b.id]);
  });
});

describe('folder repo', () => {
  let s: ReturnType<typeof setup>;
  let accountId: number;
  beforeEach(() => {
    s = setup();
    accountId = s.accounts.create(baseAccount).id;
  });

  const inbox = {
    path: 'INBOX', name: 'Inbox', role: 'inbox' as const, delimiter: '/',
    unreadCount: 3, totalCount: 10, uidValidity: '1', uidNext: '11',
  };

  it('upserts without duplicating on the second call', () => {
    const f1 = s.folders.upsert(accountId, inbox);
    const f2 = s.folders.upsert(accountId, { ...inbox, unreadCount: 5 });
    expect(f2.id).toBe(f1.id);
    expect(f2.unreadCount).toBe(5);
    expect(s.folders.list(accountId)).toHaveLength(1);
  });

  it('orders standard roles before "other"', () => {
    s.folders.upsert(accountId, { ...inbox, path: 'Custom', name: 'Custom', role: 'other' });
    s.folders.upsert(accountId, { ...inbox, path: 'Trash', name: 'Trash', role: 'trash' });
    s.folders.upsert(accountId, inbox);
    expect(s.folders.list(accountId).map((f) => f.role)).toEqual(['inbox', 'trash', 'other']);
  });

  it('prunes folders the server no longer reports, cascading messages', () => {
    const keep = s.folders.upsert(accountId, inbox);
    const gone = s.folders.upsert(accountId, { ...inbox, path: 'OLD', name: 'Old', role: 'other' });
    s.messages.insertHeaders(msg(gone.id, accountId, '1'));

    const removed = s.folders.pruneMissing(accountId, [keep.path]);
    expect(removed).toBe(1);
    expect(s.folders.list(accountId)).toHaveLength(1);
    expect(s.messages.list({ folderId: gone.id, page: 0, pageSize: 10 }).total).toBe(0);
  });
});

describe('message repo', () => {
  let s: ReturnType<typeof setup>;
  let accountId: number;
  let folderId: number;
  beforeEach(() => {
    s = setup();
    accountId = s.accounts.create(baseAccount).id;
    folderId = s.folders.upsert(accountId, {
      path: 'INBOX', name: 'Inbox', role: 'inbox', delimiter: '/',
      unreadCount: 0, totalCount: 0, uidValidity: '1', uidNext: '1',
    }).id;
  });

  it('ignores a duplicate (folder, uid) instead of throwing', () => {
    expect(s.messages.insertHeaders(msg(folderId, accountId, '1'))).toBe(true);
    // A second sync pass over overlapping UIDs must not abort.
    expect(s.messages.insertHeaders(msg(folderId, accountId, '1'))).toBe(false);
    expect(s.messages.list({ folderId, page: 0, pageSize: 10 }).total).toBe(1);
  });

  it('pages newest-first by default and counts the full result set', () => {
    for (let i = 1; i <= 25; i++) s.messages.insertHeaders(msg(folderId, accountId, String(i)));

    const page0 = s.messages.list({ folderId, page: 0, pageSize: 10 });
    expect(page0.total).toBe(25);
    expect(page0.items).toHaveLength(10);
    expect(page0.items[0]!.uid).toBe('25'); // newest first

    const page2 = s.messages.list({ folderId, page: 2, pageSize: 10 });
    expect(page2.items).toHaveLength(5);

    const oldest = s.messages.list({ folderId, page: 0, pageSize: 1, order: 'oldest' });
    expect(oldest.items[0]!.uid).toBe('1');
  });

  it('filters unread and attachments', () => {
    s.messages.insertHeaders(msg(folderId, accountId, '1', { isRead: true }));
    s.messages.insertHeaders(msg(folderId, accountId, '2', { hasAttachments: true }));
    expect(s.messages.list({ folderId, page: 0, pageSize: 10, unreadOnly: true }).total).toBe(1);
    expect(s.messages.list({ folderId, page: 0, pageSize: 10, hasAttachments: true }).total).toBe(1);
  });

  it('searches through FTS and strips FTS operator characters', () => {
    s.messages.insertHeaders(msg(folderId, accountId, '1', { subject: 'Quarterly invoice' }));
    s.messages.insertHeaders(msg(folderId, accountId, '2', { subject: 'Lunch plans' }));

    expect(s.messages.list({ folderId, page: 0, pageSize: 10, query: 'invoice' }).total).toBe(1);
    expect(s.messages.list({ folderId, page: 0, pageSize: 10, query: 'lunch' }).total).toBe(1);

    // These would be FTS5 syntax errors if interpolated raw.
    for (const nasty of ['"unbalanced', 'a AND b', 'foo*', 'NEAR(', '^start', ':']) {
      expect(() => s.messages.list({ folderId, page: 0, pageSize: 10, query: nasty })).not.toThrow();
    }
  });

  it('updates flags for a batch', () => {
    s.messages.insertHeaders(msg(folderId, accountId, '1'));
    s.messages.insertHeaders(msg(folderId, accountId, '2'));
    const ids = s.messages.list({ folderId, page: 0, pageSize: 10 }).items.map((m) => m.id);
    s.messages.setFlags(ids, { read: true, starred: true });
    const after = s.messages.list({ folderId, page: 0, pageSize: 10 }).items;
    expect(after.every((m) => m.isRead && m.isStarred)).toBe(true);
  });

  it('reports the highest UID for incremental sync', () => {
    expect(s.messages.maxUid(folderId)).toBe(0);
    s.messages.insertHeaders(msg(folderId, accountId, '7'));
    s.messages.insertHeaders(msg(folderId, accountId, '42'));
    expect(s.messages.maxUid(folderId)).toBe(42);
  });

  it('clears a folder completely when UIDVALIDITY changes', () => {
    s.messages.insertHeaders(msg(folderId, accountId, '1'));
    s.messages.clearFolder(folderId);
    expect(s.messages.list({ folderId, page: 0, pageSize: 10 }).total).toBe(0);
    expect(s.messages.maxUid(folderId)).toBe(0);
  });

  it('computes folder counts', () => {
    s.messages.insertHeaders(msg(folderId, accountId, '1'));
    s.messages.insertHeaders(msg(folderId, accountId, '2', { isRead: true }));
    expect(s.messages.counts(folderId)).toEqual({ total: 2, unread: 1 });
  });

  it('returns full detail with parsed address lists and attachments', () => {
    s.messages.insertHeaders(
      msg(folderId, accountId, '1', { toAddresses: 'a@x.com, b@x.com', ccAddresses: 'c@x.com' })
    );
    const id = s.messages.list({ folderId, page: 0, pageSize: 1 }).items[0]!.id;
    s.messages.addAttachment(id, {
      contentId: null, filename: 'report.pdf', mimeType: 'application/pdf',
      size: 2048, cachedPath: null, isInline: false,
    });

    const d = s.messages.detail(id, '<p>hi</p>', false);
    expect(d.to).toEqual(['a@x.com', 'b@x.com']);
    expect(d.cc).toEqual(['c@x.com']);
    expect(d.attachments).toHaveLength(1);
    expect(d.attachments[0]!.filename).toBe('report.pdf');
    expect(d.html).toBe('<p>hi</p>');
  });
});

describe('draft repo', () => {
  it('round-trips a draft and updates it in place', () => {
    const s = setup();
    const accountId = s.accounts.create(baseAccount).id;

    const created = s.drafts.save({
      accountId, to: ['a@x.com'], cc: [], bcc: [],
      subject: 'Hi', html: '<p>body</p>', attachments: [],
    });
    expect(created.id).toBeGreaterThan(0);
    expect(s.drafts.list(accountId)).toHaveLength(1);

    const updated = s.drafts.save({
      id: created.id, accountId, to: ['a@x.com', 'b@x.com'], cc: [], bcc: [],
      subject: 'Hi again', html: '<p>new</p>', attachments: ['/tmp/file.pdf'],
    });
    expect(updated.id).toBe(created.id);
    expect(updated.subject).toBe('Hi again');
    expect(updated.attachments).toHaveLength(1);
    expect(updated.attachments[0]!.filename).toBe('file.pdf');
    expect(s.drafts.list(accountId)).toHaveLength(1);
  });

  it('throws NOT_FOUND when updating a missing draft', () => {
    const s = setup();
    const accountId = s.accounts.create(baseAccount).id;
    expect(() =>
      s.drafts.save({
        id: 999, accountId, to: [], cc: [], bcc: [], subject: '', html: '', attachments: [],
      })
    ).toThrow();
  });
});

describe('settings repo', () => {
  it('returns defaults on a fresh database', () => {
    const s = setup();
    expect(s.settings.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('persists a partial update', () => {
    const s = setup();
    const next = s.settings.update({ theme: 'dark' });
    expect(next.theme).toBe('dark');
    expect(next.pageSize).toBe(DEFAULT_SETTINGS.pageSize); // untouched
    expect(s.settings.get().theme).toBe('dark');
  });

  it('clamps out-of-range values instead of storing them', () => {
    const s = setup();
    expect(s.settings.update({ pageSize: 9999 }).pageSize).toBe(200);
    expect(s.settings.update({ syncIntervalSeconds: -5 }).syncIntervalSeconds).toBe(0);
  });

  it('survives a corrupted settings row', () => {
    const db: Db = openDatabase(':memory:');
    const repo = createSettingsRepo(db);
    db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('app', '{not json');
    expect(repo.get()).toEqual(DEFAULT_SETTINGS);
  });
});
