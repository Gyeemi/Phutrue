/**
 * Runtime validation for every IPC payload.
 *
 * The renderer is untrusted: it runs web content and could be compromised by a
 * malicious message body. Every payload is therefore parsed by a zod schema
 * before a handler sees it, and the parsed (not raw) value is what handlers use.
 */

import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

const port = z.number().int().min(1).max(65535);

/** Trimmed, non-empty, length-capped string. */
const text = (max: number) => z.string().trim().min(1).max(max);

/** Bounded array of trimmed email-ish strings. */
const addressList = z.array(z.string().trim().min(3).max(320)).max(100);

/** Bounded id. */
const id = z.number().int().positive();

const folderRole = z.enum(['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash', 'other']);

/* ------------------------------------------------------------------ *
 * Account
 * ------------------------------------------------------------------ */

const accountDraftBase = z.object({
  label: text(120),
  email: text(320),
  displayName: z.string().trim().max(200),
  // A password may legitimately be long; it is never logged, never stored in
  // clear, and the accounts table has no column for it.
  password: z.string().min(1).max(4096),
  // OAuth accounts have no IMAP/SMTP host to enter; the provider endpoints are
  // resolved in main. Credential passwords additionally require a host, so the
  // refinement below permits one or the other but never neither.
  authKind: z.enum(['password', 'oauth2']).optional(),
  oauthProvider: z.enum(['google', 'microsoft']).nullable().optional(),
  imapHost: text(255),
  imapPort: port,
  imapSecure: z.boolean(),
  smtpHost: text(255),
  smtpPort: port,
  smtpSecure: z.boolean(),
  smtpUser: z.string().trim().max(320).optional(),
});

/**
 * A complete account definition, with the cross-field rules applied.
 *
 * Kept separate from `accountDraftBase` because `.superRefine()` wraps the
 * schema in a refinement, and a refinement cannot be `.partial()`. The patch
 * schema for `accounts:update` therefore extends the base.
 */
const accountDraft = accountDraftBase.superRefine((value, ctx) => {
  // Cross-field rules that a per-field schema cannot express. Reported as an
  // issue path only, so the offending VALUE (often a password) is never echoed.
  if (value.authKind === 'oauth2') {
    if (!value.oauthProvider) {
      ctx.addIssue({ code: 'custom', path: ['oauthProvider'], message: 'required for OAuth' });
    }
  } else if (value.authKind === 'password') {
    if (!value.imapHost) {
      ctx.addIssue({ code: 'custom', path: ['imapHost'], message: 'required for a password account' });
    }
    if (!value.smtpHost) {
      ctx.addIssue({ code: 'custom', path: ['smtpHost'], message: 'required for a password account' });
    }
  }
});

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

const listMessages = z.object({
  folderId: id,
  page: z.number().int().min(0).max(100_000),
  pageSize: z.number().int().min(1).max(200).optional(),
  query: z.string().max(500).optional(),
  order: z.enum(['newest', 'oldest']).optional(),
  unreadOnly: z.boolean().optional(),
  hasAttachments: z.boolean().optional(),
});

const setFlags = z
  .object({
    messageIds: z.array(id).min(1).max(5000),
    read: z.boolean().optional(),
    starred: z.boolean().optional(),
  })
  // A no-op request is almost certainly a caller bug.
  .refine((v) => v.read !== undefined || v.starred !== undefined, {
    message: 'setFlags requires read and/or starred',
  });

const moveMessages = z.object({
  messageIds: z.array(id).min(1).max(5000),
  targetFolderId: id,
});

/* ------------------------------------------------------------------ *
 * Drafts / sending
 * ------------------------------------------------------------------ */

const draftBody = z.object({
  accountId: id,
  to: addressList,
  cc: addressList,
  bcc: addressList,
  subject: z.string().max(1000),
  // Rich-text HTML. Capped to keep a single draft from exhausting memory;
  // it is sanitized again on the way out.
  html: z.string().max(2_000_000),
  attachments: z.array(z.string().max(4096)).max(50),
  inReplyTo: z.string().max(1000).optional(),
  references: z.array(z.string().max(1000)).max(200).optional(),
});

const saveDraft = draftBody.extend({
  id: id.optional(),
});

const sendMessage = draftBody.extend({
  draftId: id.optional(),
});

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

const settings = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  syncIntervalSeconds: z.number().int().min(0).max(86_400),
  loadRemoteImages: z.boolean(),
  notificationsEnabled: z.boolean(),
  pageSize: z.number().int().min(10).max(200),
});

// Every field optional, but reject unknown keys so a typo cannot silently no-op.
const settingsPatch = settings.partial().strict();

/* ------------------------------------------------------------------ *
 * Channel → schema
 * ------------------------------------------------------------------ */

/**
 * `undefined` means the channel takes no payload. The router treats a missing
 * schema as "no arguments accepted".
 */
export const SCHEMAS = {
  'app:info': undefined,
  'app:diagnostics': undefined,
  // Diagnostics reports are a few KB at most; the cap is generous but finite.
  'app:copyToClipboard': z.object({ text: z.string().min(1).max(64 * 1024) }).strict(),

  'settings:get': undefined,
  'settings:update': settingsPatch,

  'accounts:list': undefined,
  'accounts:create': accountDraft,
  'accounts:update': z.object({
    id,
    patch: accountDraftBase.partial().strict(),
  }),
  'accounts:remove': z.object({ id }),
  'accounts:test': accountDraft,
  'accounts:reconnect': z.object({ id, password: z.string().min(1).max(4096) }),

  'folders:list': z.object({ accountId: id }),
  'folders:sync': z.object({ accountId: id }),

  'messages:list': listMessages,
  'messages:get': z.object({ id, markRead: z.boolean().optional() }),
  'messages:setFlags': setFlags,
  'messages:move': moveMessages,
  'messages:delete': z.object({ messageIds: z.array(id).min(1).max(5000) }),
  'messages:downloadAttachment': z.object({
    messageId: id,
    contentId: z.string().max(1000).nullable(),
    filename: text(512),
  }),

  'drafts:list': z.object({ accountId: id }),
  'drafts:save': saveDraft,
  'drafts:delete': z.object({ id }),

  'mail:send': sendMessage,

  'attachments:pick': undefined,

  'sync:start': z.object({ accountId: id }),
  'sync:cancel': z.object({ accountId: id }),
} as const;

/** Types re-exported for handlers. */
export type AccountDraftInput = z.infer<typeof accountDraft>;
export type SendMessageInput = z.infer<typeof sendMessage>;
export type ListMessagesInput = z.infer<typeof listMessages>;
export type SettingsPatchInput = z.infer<typeof settingsPatch>;

export { folderRole };
