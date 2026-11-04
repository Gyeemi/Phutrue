/**
 * Settings persistence, stored as JSON rows in a key/value table.
 *
 * Unknown keys are dropped on read, so downgrading the app never crashes on a
 * setting written by a newer build.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Settings, ThemeMode } from '../../../shared/models.js';
import { oneRow } from '../database.js';

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  syncIntervalSeconds: 300,
  loadRemoteImages: false,
  notificationsEnabled: true,
  pageSize: 50,
};

const THEMES: readonly ThemeMode[] = ['system', 'light', 'dark'];

function coerce(raw: unknown): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;

  if (typeof r['theme'] === 'string' && (THEMES as readonly string[]).includes(r['theme'])) {
    out.theme = r['theme'] as ThemeMode;
  }
  if (typeof r['syncIntervalSeconds'] === 'number' && Number.isFinite(r['syncIntervalSeconds'])) {
    out.syncIntervalSeconds = Math.min(86_400, Math.max(0, Math.floor(r['syncIntervalSeconds'])));
  }
  if (typeof r['loadRemoteImages'] === 'boolean') out.loadRemoteImages = r['loadRemoteImages'];
  if (typeof r['notificationsEnabled'] === 'boolean') out.notificationsEnabled = r['notificationsEnabled'];
  if (typeof r['pageSize'] === 'number' && Number.isFinite(r['pageSize'])) {
    out.pageSize = Math.min(200, Math.max(10, Math.floor(r['pageSize'])));
  }
  return out;
}

const KEY = 'app';

export function createSettingsRepo(db: DatabaseSync) {
  return {
    get(): Settings {
      const row = oneRow<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', KEY);
      if (!row) return { ...DEFAULT_SETTINGS };
      try {
        return coerce(JSON.parse(row.value));
      } catch {
        return { ...DEFAULT_SETTINGS };
      }
    },

    update(patch: Partial<Settings>): Settings {
      // Merge over stored values, then coerce, so a bad patch cannot corrupt
      // the record.
      const next = coerce({ ...this.get(), ...patch });
      db.prepare(
        `INSERT INTO settings (key,value) VALUES (?,?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(KEY, JSON.stringify(next));
      return next;
    },
  };
}

export type SettingsRepo = ReturnType<typeof createSettingsRepo>;
