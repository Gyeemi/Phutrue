/**
 * Folder persistence.
 *
 * `uidValidity` matters: when an IMAP server changes it, every UID we stored for
 * that folder is meaningless and the local message list must be rebuilt. The
 * sync layer checks this before trusting cursors.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Folder, FolderRole } from '../../../shared/models.js';
import { allRows, oneRow, requireRow } from '../database.js';

interface FolderRow {
  id: number;
  account_id: number;
  path: string;
  name: string;
  role: string;
  delimiter: string;
  unread_count: number;
  total_count: number;
  uid_validity: string | null;
  uid_next: string | null;
  sort_order: number;
}

function toFolder(r: FolderRow): Folder {
  return {
    id: r.id,
    accountId: r.account_id,
    path: r.path,
    name: r.name,
    role: r.role as FolderRole,
    delimiter: r.delimiter,
    unreadCount: r.unread_count,
    totalCount: r.total_count,
    uidValidity: r.uid_validity,
    uidNext: r.uid_next,
    sortOrder: r.sort_order,
  };
}

const ROLE_ORDER: Record<FolderRole, number> = {
  inbox: 0,
  drafts: 1,
  sent: 2,
  archive: 3,
  spam: 4,
  trash: 5,
  other: 6,
};

export interface FolderUpsert {
  path: string;
  name: string;
  role: FolderRole;
  delimiter: string;
  unreadCount: number;
  totalCount: number;
  uidValidity: string | null;
  uidNext: string | null;
}

export function createFolderRepo(db: DatabaseSync) {
  return {
    list(accountId: number): Folder[] {
      const rows = allRows<FolderRow>(db, 'SELECT * FROM folders WHERE account_id = ?', accountId);
      // Stable, human-sensible order: standard roles first, then alphabetical.
      return rows
        .map(toFolder)
        .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name));
    },

    get(id: number): Folder {
      const row = oneRow<FolderRow>(db, 'SELECT * FROM folders WHERE id = ?', id);
      return toFolder(requireRow(row, 'Folder'));
    },

    findByPath(accountId: number, path: string): Folder | null {
      const row = oneRow<FolderRow>(db, 'SELECT * FROM folders WHERE account_id = ? AND path = ?', accountId, path);
      return row ? toFolder(row) : null;
    },

    /** Insert or update a folder discovered on the server. */
    upsert(accountId: number, f: FolderUpsert): Folder {
      const existing = this.findByPath(accountId, f.path);
      if (existing) {
        db.prepare(
          `UPDATE folders SET name=?, role=?, delimiter=?, unread_count=?, total_count=?,
             uid_validity=?, uid_next=?, sort_order=? WHERE id=?`
        ).run(
          f.name, f.role, f.delimiter, f.unreadCount, f.totalCount,
          f.uidValidity, f.uidNext, ROLE_ORDER[f.role], existing.id
        );
        return this.get(existing.id);
      }
      const res = db.prepare(
        `INSERT INTO folders (account_id,path,name,role,delimiter,unread_count,total_count,uid_validity,uid_next,sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(
        accountId, f.path, f.name, f.role, f.delimiter, f.unreadCount, f.totalCount,
        f.uidValidity, f.uidNext, ROLE_ORDER[f.role]
      );
      return this.get(Number(res.lastInsertRowid));
    },

    setCounts(id: number, unread: number, total: number): void {
      db.prepare('UPDATE folders SET unread_count = ?, total_count = ? WHERE id = ?').run(unread, total, id);
    },

    setCursor(id: number, uidValidity: string | null, uidNext: string | null): void {
      db.prepare('UPDATE folders SET uid_validity = ?, uid_next = ? WHERE id = ?').run(uidValidity, uidNext, id);
    },

    /** Remove folders the server no longer reports. Messages cascade. */
    pruneMissing(accountId: number, keepPaths: string[]): number {
      const existing = db.prepare('SELECT id, path FROM folders WHERE account_id = ?').all(accountId) as
        Array<{ id: number; path: string }>;
      const keep = new Set(keepPaths);
      let removed = 0;
      for (const row of existing) {
        if (!keep.has(row.path)) {
          db.prepare('DELETE FROM folders WHERE id = ?').run(row.id);
          removed++;
        }
      }
      return removed;
    },
  };
}

export type FolderRepo = ReturnType<typeof createFolderRepo>;
