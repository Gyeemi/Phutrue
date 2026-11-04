/**
 * Draft persistence.
 *
 * Drafts are stored locally first and only mirrored to the server's Drafts
 * folder when a sync pushes them, so a crash or an offline session never loses
 * composed text.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Draft, DraftAttachment } from '../../../shared/models.js';
import { allRows, now, oneRow, requireRow } from '../database.js';

interface DraftRow {
  id: number;
  account_id: number;
  folder_id: number | null;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  html: string;
  attach_json: string;
  in_reply_to: string | null;
  refs_json: string;
  updated_at: number;
}

function parseArray<T>(json: string): T[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function toDraft(r: DraftRow): Draft {
  return {
    id: r.id,
    accountId: r.account_id,
    folderId: r.folder_id,
    to: parseArray<string>(r.to_json),
    cc: parseArray<string>(r.cc_json),
    bcc: parseArray<string>(r.bcc_json),
    subject: r.subject,
    html: r.html,
    attachments: parseArray<DraftAttachment>(r.attach_json),
    inReplyTo: r.in_reply_to,
    references: parseArray<string>(r.refs_json),
    updatedAt: r.updated_at,
  };
}

export interface DraftInput {
  id?: number | undefined;
  accountId: number;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  attachments: string[];
  inReplyTo?: string | undefined;
  references?: string[] | undefined;
}

export function createDraftRepo(db: DatabaseSync) {
  return {
    list(accountId: number): Draft[] {
      const rows = allRows<DraftRow>(db, 'SELECT * FROM drafts WHERE account_id = ? ORDER BY updated_at DESC', accountId);
      return rows.map(toDraft);
    },

    get(id: number): Draft {
      const row = oneRow<DraftRow>(db, 'SELECT * FROM drafts WHERE id = ?', id);
      return toDraft(requireRow(row, 'Draft'));
    },

    /** Create or update. Returns the stored draft. */
    save(input: DraftInput): Draft {
      const attachments: DraftAttachment[] = input.attachments.map((p) => ({
        filename: p.split(/[\\/]/).pop() ?? p,
        // Guessed from the extension; the real value is set when the file is
        // handed to nodemailer, which sniffs it.
        mimeType: 'application/octet-stream',
        path: p,
        size: 0,
      }));

      if (input.id !== undefined) {
        this.get(input.id); // throws NOT_FOUND
        db.prepare(
          `UPDATE drafts SET to_json=?, cc_json=?, bcc_json=?, subject=?, html=?,
             attach_json=?, in_reply_to=?, refs_json=?, updated_at=? WHERE id=?`
        ).run(
          JSON.stringify(input.to), JSON.stringify(input.cc), JSON.stringify(input.bcc),
          input.subject, input.html, JSON.stringify(attachments),
          input.inReplyTo ?? null, JSON.stringify(input.references ?? []), now(), input.id
        );
        return this.get(input.id);
      }

      const res = db.prepare(
        `INSERT INTO drafts (account_id,to_json,cc_json,bcc_json,subject,html,attach_json,in_reply_to,refs_json,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(
        input.accountId, JSON.stringify(input.to), JSON.stringify(input.cc), JSON.stringify(input.bcc),
        input.subject, input.html, JSON.stringify(attachments),
        input.inReplyTo ?? null, JSON.stringify(input.references ?? []), now()
      );
      return this.get(Number(res.lastInsertRowid));
    },

    remove(id: number): void {
      db.prepare('DELETE FROM drafts WHERE id = ?').run(id);
    },
  };
}

export type DraftRepo = ReturnType<typeof createDraftRepo>;
