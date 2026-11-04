/**
 * Message persistence and querying.
 *
 * All list queries are paginated and covered by an index, because the SQLite
 * driver is synchronous — an unbounded query would stall the main process.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { AttachmentMeta, MessageDetail, MessageSummary } from '../../../shared/models.js';
import { allRows, oneRow, requireRow } from '../database.js';

interface MessageRow {
  id: number;
  account_id: number;
  folder_id: number;
  uid: string;
  message_id: string | null;
  subject: string;
  from_name: string;
  from_address: string;
  to_addresses: string;
  cc_addresses: string;
  bcc_addresses: string;
  reply_to: string | null;
  snippet: string;
  body_text: string | null;
  body_html_raw: string | null;
  date: number;
  is_read: number;
  is_starred: number;
  has_attachments: number;
  size: number;
  in_reply_to: string | null;
  refs: string | null;
  body_fetched: number;
}

interface AttachmentRow {
  content_id: string | null;
  filename: string;
  mime_type: string;
  size: number;
  cached_path: string | null;
  is_inline: number;
}

function toSummary(r: MessageRow): MessageSummary {
  return {
    id: r.id,
    accountId: r.account_id,
    folderId: r.folder_id,
    uid: r.uid,
    subject: r.subject,
    fromName: r.from_name,
    fromAddress: r.from_address,
    toAddresses: r.to_addresses,
    snippet: r.snippet,
    date: r.date,
    isRead: r.is_read === 1,
    isStarred: r.is_starred === 1,
    hasAttachments: r.has_attachments === 1,
    size: r.size,
  };
}

function splitList(csv: string): string[] {
  return csv ? csv.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

export interface MessageInsert {
  accountId: number;
  folderId: number;
  uid: string;
  messageId: string | null;
  subject: string;
  fromName: string;
  fromAddress: string;
  toAddresses: string;
  ccAddresses: string;
  bccAddresses: string;
  replyTo: string | null;
  snippet: string;
  date: number;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  size: number;
  inReplyTo: string | null;
  references: string;
}

export interface ListQuery {
  folderId: number;
  page: number;
  pageSize: number;
  query?: string | undefined;
  order?: 'newest' | 'oldest' | undefined;
  unreadOnly?: boolean | undefined;
  hasAttachments?: boolean | undefined;
}

export function createMessageRepo(db: DatabaseSync) {
  return {
    /** Insert headers if new. Returns false when the UID already exists. */
    insertHeaders(m: MessageInsert): boolean {
      const res = db
        .prepare(
          `INSERT INTO messages
             (account_id,folder_id,uid,message_id,subject,from_name,from_address,
              to_addresses,cc_addresses,bcc_addresses,reply_to,snippet,date,
              is_read,is_starred,has_attachments,size,in_reply_to,refs)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(folder_id, uid) DO NOTHING`
        )
        .run(
          m.accountId, m.folderId, m.uid, m.messageId, m.subject, m.fromName, m.fromAddress,
          m.toAddresses, m.ccAddresses, m.bccAddresses, m.replyTo, m.snippet, m.date,
          m.isRead ? 1 : 0, m.isStarred ? 1 : 0, m.hasAttachments ? 1 : 0, m.size,
          m.inReplyTo, m.references
        );
      return Number(res.changes) > 0;
    },

    /** Store a fetched body. */
    setBody(id: number, text: string | null, htmlRaw: string | null): void {
      db.prepare('UPDATE messages SET body_text = ?, body_html_raw = ?, body_fetched = 1 WHERE id = ?')
        .run(text, htmlRaw, id);
    },

    getRaw(id: number): MessageRow {
      const row = oneRow<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', id);
      return requireRow(row, 'Message');
    },

    summary(id: number): MessageSummary {
      return toSummary(this.getRaw(id));
    },

    /** Full detail, with sanitized HTML supplied by the caller. */
    detail(id: number, html: string | null, remoteContentBlocked: boolean): MessageDetail {
      const r = this.getRaw(id);
      const attachments = allRows<AttachmentRow>(db, 'SELECT * FROM attachments WHERE message_id = ? ORDER BY id', id);

      return {
        ...toSummary(r),
        to: splitList(r.to_addresses),
        cc: splitList(r.cc_addresses),
        bcc: splitList(r.bcc_addresses),
        replyTo: r.reply_to,
        messageId: r.message_id,
        inReplyTo: r.in_reply_to,
        references: splitList(r.refs ?? ''),
        html,
        text: r.body_text,
        remoteContentBlocked,
        attachments: attachments.map<AttachmentMeta>((a) => ({
          contentId: a.content_id,
          filename: a.filename,
          mimeType: a.mime_type,
          size: a.size,
          cachedPath: a.cached_path,
          isInline: a.is_inline === 1,
        })),
      };
    },

    /**
     * Paginated list. When `query` is present, joins the FTS index.
     *
     * The FTS query is built from user text, so it is tokenised here rather than
     * interpolated raw — FTS5 treats `"`, `*`, `:` and `^` as operators, and an
     * unbalanced quote is a syntax error.
     */
    list(q: ListQuery): { items: MessageSummary[]; total: number } {
      const where: string[] = [];
      const params: Array<string | number> = [];

      if (q.query && q.query.trim()) {
        const tokens = q.query
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s]/gu, ' ')
          .split(/\s+/)
          .filter((t) => t.length > 0)
          .slice(0, 8)
          .map((t) => `"${t}"*`);
        if (tokens.length > 0) {
          where.push('m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)');
          params.push(tokens.join(' AND '));
        }
      }

      where.push('m.folder_id = ?');
      params.push(q.folderId);

      if (q.unreadOnly) where.push('m.is_read = 0');
      if (q.hasAttachments) where.push('m.has_attachments = 1');

      const whereSql = where.join(' AND ');
      const direction = q.order === 'oldest' ? 'ASC' : 'DESC';

      const totalRow = db
        .prepare(`SELECT COUNT(*) AS c FROM messages m WHERE ${whereSql}`)
        .get(...params) as unknown as { c: number };

      const offset = q.page * q.pageSize;
      const rows = allRows<MessageRow>(
        db,
        `SELECT m.* FROM messages m WHERE ${whereSql} ORDER BY m.date ${direction}, m.id ${direction} LIMIT ? OFFSET ?`,
        ...params, q.pageSize, offset
      );

      return { items: rows.map(toSummary), total: totalRow.c };
    },

    setFlags(ids: number[], flags: { read?: boolean; starred?: boolean }): void {
      if (ids.length === 0) return;
      const sets: string[] = [];
      const params: Array<number> = [];
      if (flags.read !== undefined) { sets.push('is_read = ?'); params.push(flags.read ? 1 : 0); }
      if (flags.starred !== undefined) { sets.push('is_starred = ?'); params.push(flags.starred ? 1 : 0); }
      if (sets.length === 0) return;

      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id IN (${placeholders})`)
        .run(...params, ...ids);
    },

    markRead(id: number): void {
      db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').run(id);
    },

    /** Move messages to another folder, preserving their UIDs where possible. */
    move(ids: number[], targetFolderId: number): void {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`UPDATE messages SET folder_id = ? WHERE id IN (${placeholders})`)
        .run(targetFolderId, ...ids);
    },

    remove(ids: number[]): void {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
    },

    /** Highest UID stored for a folder, as a number, or 0 when empty. */
    maxUid(folderId: number): number {
      const row = db
        .prepare('SELECT MAX(CAST(uid AS INTEGER)) AS m FROM messages WHERE folder_id = ?')
        .get(folderId) as unknown as { m: number | null };
      return row.m ?? 0;
    },

    counts(folderId: number): { total: number; unread: number } {
      const row = db
        .prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread FROM messages WHERE folder_id = ?')
        .get(folderId) as unknown as { total: number; unread: number | null };
      return { total: row.total, unread: row.unread ?? 0 };
    },

    /** Drop everything for a folder — used when UIDVALIDITY changes. */
    clearFolder(folderId: number): void {
      db.prepare('DELETE FROM messages WHERE folder_id = ?').run(folderId);
    },

    addAttachment(messageId: number, a: Omit<AttachmentMeta, 'cachedPath'> & { cachedPath: string | null }): void {
      db.prepare(
        `INSERT INTO attachments (message_id,content_id,filename,mime_type,size,cached_path,is_inline)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(message_id, filename, COALESCE(content_id, '')) DO UPDATE SET
           mime_type = excluded.mime_type, size = excluded.size, cached_path = excluded.cached_path`
      ).run(messageId, a.contentId, a.filename, a.mimeType, a.size, a.cachedPath, a.isInline ? 1 : 0);
    },

    attachmentsFor(messageId: number): AttachmentMeta[] {
      const rows = allRows<AttachmentRow>(db, 'SELECT * FROM attachments WHERE message_id = ?', messageId);
      return rows.map((a) => ({
        contentId: a.content_id,
        filename: a.filename,
        mimeType: a.mime_type,
        size: a.size,
        cachedPath: a.cached_path,
        isInline: a.is_inline === 1,
      }));
    },

    setAttachmentCachePath(messageId: number, filename: string, path: string): void {
      db.prepare('UPDATE attachments SET cached_path = ? WHERE message_id = ? AND filename = ?')
        .run(path, messageId, filename);
    },
  };
}

export type MessageRepo = ReturnType<typeof createMessageRepo>;
