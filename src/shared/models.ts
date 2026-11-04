/**
 * Domain models.
 *
 * These types are the contract between the main process, the preload bridge and
 * the renderer. Nothing here may contain a secret: an account carries a
 * `credentialRef`, never a password or token.
 */

/** How an account authenticates. */
export type AuthKind = 'password' | 'oauth2';

/** OAuth providers we implement flows for. */
export type OAuthProvider = 'google' | 'microsoft';

export type AccountSyncState = 'idle' | 'syncing' | 'offline' | 'error';

export interface Account {
  id: number;
  /** User-visible label, e.g. "Work" or the address itself. */
  label: string;
  email: string;
  displayName: string;
  authKind: AuthKind;
  oauthProvider: OAuthProvider | null;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  /** SMTP username when it differs from the address. */
  smtpUser: string | null;
  syncState: AccountSyncState;
  /** Human-readable reason when syncState is 'error'. Never contains secrets. */
  lastError: string | null;
  lastSyncedAt: number | null;
  createdAt: number;
}

/** Fields the user supplies when adding an account. */
export interface AccountDraft {
  label: string;
  email: string;
  displayName: string;
  password: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
}

/** Well-known folder roles, mapped from provider special-use flags. */
export type FolderRole =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'archive'
  | 'spam'
  | 'trash'
  | 'other';

export interface Folder {
  id: number;
  accountId: number;
  /** Server-side path, unique per account. */
  path: string;
  name: string;
  role: FolderRole;
  /** IMAP delimiter, e.g. '/' or '.'. */
  delimiter: string;
  /** Server-reported counts; may lag the local index. */
  unreadCount: number;
  totalCount: number;
  /** UIDVALIDITY — if the server changes this, local cursors are invalidated. */
  uidValidity: string | null;
  /** Highest UID fully synced. */
  uidNext: string | null;
  sortOrder: number;
}

export interface AttachmentMeta {
  /** Content-ID when the part is inline (images in HTML). */
  contentId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  /** Local cache path once downloaded; null until then. */
  cachedPath: string | null;
  isInline: boolean;
}

export interface MessageSummary {
  id: number;
  accountId: number;
  folderId: number;
  uid: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  /** Comma-joined To addresses, for the list view. */
  toAddresses: string;
  /** First ~200 chars of the text body, for preview lines. */
  snippet: string;
  /** Milliseconds since epoch. */
  date: number;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  size: number;
}

export interface MessageDetail extends MessageSummary {
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** Sanitized HTML, safe to insert. Null when the message is text-only. */
  html: string | null;
  /** Plain-text body. Always present when the message could be parsed. */
  text: string | null;
  attachments: AttachmentMeta[];
  /** True when remote images were stripped by the sanitizer. */
  remoteContentBlocked: boolean;
}

export interface Draft {
  id: number;
  accountId: number;
  /** Null until the draft has been associated with a server folder. */
  folderId: number | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** HTML body as composed. Not yet sanitized — it is user-authored. */
  html: string;
  attachments: DraftAttachment[];
  inReplyTo: string | null;
  references: string[];
  updatedAt: number;
}

export interface DraftAttachment {
  filename: string;
  mimeType: string;
  /** Absolute path to the staged file in the app's attachment cache. */
  path: string;
  size: number;
}

export type ThemeMode = 'system' | 'light' | 'dark';

export interface Settings {
  theme: ThemeMode;
  /** Sync interval in seconds. 0 disables background sync. */
  syncIntervalSeconds: number;
  /** Download remote images automatically. Off by default. */
  loadRemoteImages: boolean;
  notificationsEnabled: boolean;
  /** Messages fetched per page. */
  pageSize: number;
}

/* ------------------------------------------------------------------ *
 * Diagnostics
 * ------------------------------------------------------------------ */

/**
 * One line of the Windows verification checklist.
 *
 * `detail` is written to be safe to show, copy and paste into a bug report:
 * it may describe *what* was measured but never contains a credential, a token,
 * a message body, an attachment, or any part of a secret value.
 */
export interface DiagnosticCheck {
  /** Stable identifier, e.g. 'sqlite.open'. */
  id: string;
  /** Short human-readable name. */
  label: string;
  status: 'pass' | 'fail' | 'skip';
  /** Safe, bounded explanation. Empty string when there is nothing to add. */
  detail: string;
  /** How long the check took, in milliseconds. */
  durationMs: number;
}

/**
 * The result of the in-app self-test.
 *
 * Deliberately a flat list rather than a nested object: the renderer only has to
 * render rows, and the shape is trivially serialisable across IPC.
 */
export interface DiagnosticsReport {
  checks: DiagnosticCheck[];
  /** True only when no check has status 'fail'. */
  ok: boolean;
  /** When the report was produced (epoch ms). */
  generatedAt: number;
  platform: string;
}

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  /** Whether safeStorage can encrypt secrets on this machine. */
  secureStorageAvailable: boolean;
  /** Set when secureStorageAvailable is false, explaining why. */
  secureStorageReason: string | null;
}
