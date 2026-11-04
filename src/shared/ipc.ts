/**
 * IPC contract.
 *
 * This file is the single source of truth for the renderer↔main boundary.
 * Both sides import it, so:
 *   - the renderer cannot call a channel that does not exist (type error);
 *   - a handler cannot change a response shape without breaking the renderer's
 *     build;
 *   - the channel list can be enumerated and tested (no shadow channels).
 *
 * No payload type in this file may carry a credential. Passwords are sent once,
 * at account creation, and are immediately encrypted and dropped.
 */

import type {
  Account,
  AccountDraft,
  AppInfo,
  DiagnosticsReport,
  Draft,
  Folder,
  MessageDetail,
  MessageSummary,
  Settings,
} from './models.js';

/* ------------------------------------------------------------------ *
 * Result: exceptions never cross the process boundary
 * ------------------------------------------------------------------ */

export interface IpcOk<T> {
  ok: true;
  value: T;
}
export interface IpcErr {
  ok: false;
  /** Stable machine-readable code, e.g. 'IMAP_AUTH_FAILED'. */
  code: string;
  /** Safe, user-presentable message. Never contains secrets or stack traces. */
  message: string;
}
export type Result<T> = IpcOk<T> | IpcErr;

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

export interface ListMessagesArgs {
  folderId: number;
  /** Zero-based page index. */
  page: number;
  /** Page size; clamped server-side to 1..200. */
  pageSize?: number;
  /** Free-text query over subject/sender/body index. */
  query?: string;
  /** Sort direction by date. */
  order?: 'newest' | 'oldest';
  /** Restrict to unread only. */
  unreadOnly?: boolean;
  /** Restrict to messages with attachments. */
  hasAttachments?: boolean;
}

export interface SendMessageArgs {
  accountId: number;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  /** Absolute paths of staged attachments. */
  attachments: string[];
  /** Draft to discard on success, if any. */
  draftId?: number;
  inReplyTo?: string;
  references?: string[];
}

export interface SetFlagsArgs {
  messageIds: number[];
  read?: boolean;
  starred?: boolean;
}

export interface MoveMessagesArgs {
  messageIds: number[];
  targetFolderId: number;
}

export interface SaveDraftArgs {
  /** Omit to create. */
  id?: number;
  accountId: number;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  attachments: string[];
  inReplyTo?: string;
  references?: string[];
}

export interface AttachmentPickResult {
  filename: string;
  mimeType: string;
  size: number;
  /** Staged copy inside the app's attachment cache. */
  path: string;
}

/* ------------------------------------------------------------------ *
 * Channel map
 * ------------------------------------------------------------------ */

/**
 * Every channel, its request payload type and its response value type.
 *
 * `void` request means the channel takes no arguments.
 */
export interface IpcChannels {
  /* --- app --- */
  'app:info': { req: void; res: AppInfo };
  /**
   * Run the in-app self-test.
   *
   * Takes no arguments and returns no secrets. Exposed so a Windows tester can
   * verify the storage and bridge stack from inside the packaged app, where
   * `node:sqlite`, DPAPI and the preload bridge all actually exist.
   */
  'app:diagnostics': { req: void; res: DiagnosticsReport };
  /**
   * Copy bounded text to the system clipboard.
   *
   * Exists because the renderer's `navigator.clipboard` is unusable here: the
   * window denies every permission request, including `clipboard-write`, which
   * is the correct posture for a mail client. Routing through the main process
   * keeps that posture and still lets the user copy a diagnostics report.
   *
   * The text is capped so this cannot become a channel for bulk exfiltration.
   */
  'app:copyToClipboard': { req: { text: string }; res: void };

  /* --- settings --- */
  'settings:get': { req: void; res: Settings };
  'settings:update': { req: Partial<Settings>; res: Settings };

  /* --- accounts --- */
  'accounts:list': { req: void; res: Account[] };
  'accounts:create': { req: AccountDraft; res: Account };
  'accounts:update': { req: { id: number; patch: Partial<AccountDraft> }; res: Account };
  'accounts:remove': { req: { id: number }; res: void };
  /** Validate host/port/credentials without persisting anything. */
  'accounts:test': { req: AccountDraft; res: { imap: boolean; smtp: boolean; detail: string } };
  /** Re-authenticate with a new password for an existing account. */
  'accounts:reconnect': { req: { id: number; password: string }; res: Account };

  /* --- folders --- */
  'folders:list': { req: { accountId: number }; res: Folder[] };
  'folders:sync': { req: { accountId: number }; res: Folder[] };

  /* --- messages --- */
  'messages:list': { req: ListMessagesArgs; res: { items: MessageSummary[]; total: number } };
  'messages:get': { req: { id: number; markRead?: boolean }; res: MessageDetail };
  'messages:setFlags': { req: SetFlagsArgs; res: void };
  'messages:move': { req: MoveMessagesArgs; res: void };
  'messages:delete': { req: { messageIds: number[] }; res: void };
  'messages:downloadAttachment': {
    req: { messageId: number; contentId: string | null; filename: string };
    res: { path: string };
  };

  /* --- drafts --- */
  'drafts:list': { req: { accountId: number }; res: Draft[] };
  'drafts:save': { req: SaveDraftArgs; res: Draft };
  'drafts:delete': { req: { id: number }; res: void };

  /* --- sending --- */
  'mail:send': { req: SendMessageArgs; res: { messageId: string | null } };

  /* --- attachments --- */
  'attachments:pick': { req: void; res: AttachmentPickResult[] };

  /* --- sync --- */
  'sync:start': { req: { accountId: number }; res: void };
  'sync:cancel': { req: { accountId: number }; res: void };
}

export type Channel = keyof IpcChannels;
export type ReqOf<C extends Channel> = IpcChannels[C]['req'];
export type ResOf<C extends Channel> = IpcChannels[C]['res'];

/**
 * The full channel list as a runtime value.
 *
 * The router refuses any channel not in this array, so an accidental string
 * cannot reach a handler. Kept adjacent to `IpcChannels` so the two cannot drift
 * — a type-level test asserts they stay in sync.
 */
export const CHANNELS = [
  'app:info',
  'app:diagnostics',
  'app:copyToClipboard',
  'settings:get',
  'settings:update',
  'accounts:list',
  'accounts:create',
  'accounts:update',
  'accounts:remove',
  'accounts:test',
  'accounts:reconnect',
  'folders:list',
  'folders:sync',
  'messages:list',
  'messages:get',
  'messages:setFlags',
  'messages:move',
  'messages:delete',
  'messages:downloadAttachment',
  'drafts:list',
  'drafts:save',
  'drafts:delete',
  'mail:send',
  'attachments:pick',
  'sync:start',
  'sync:cancel',
] as const satisfies readonly Channel[];

/* ------------------------------------------------------------------ *
 * Main → renderer events
 * ------------------------------------------------------------------ */

export interface SyncProgressEvent {
  accountId: number;
  folderId: number | null;
  phase: 'connecting' | 'folders' | 'messages' | 'done' | 'error';
  processed: number;
  message?: string;
}

export interface MailEventMap {
  'sync:progress': SyncProgressEvent;
  /** Emitted when new mail arrives so the list can refresh. */
  'mail:new': { accountId: number; folderId: number; count: number };
  /** Emitted when an account's sync state changes. */
  'account:state': { accountId: number; state: Account['syncState']; error: string | null };
}

export type MailEvent = keyof MailEventMap;

export const EVENTS = ['sync:progress', 'mail:new', 'account:state'] as const satisfies readonly MailEvent[];

/** The API surface exposed on `window.phutrue` by the preload script. */
export interface PhutrueApi {
  invoke<C extends Channel>(channel: C, payload: ReqOf<C>): Promise<Result<ResOf<C>>>;
  on<E extends MailEvent>(event: E, listener: (payload: MailEventMap[E]) => void): () => void;
  platform: string;
}
