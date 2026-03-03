import path from 'path';
import sqlite3 from 'sqlite3';
import { canonicalYouTubeUrl, extractYouTubeVideoId } from './playlists';

const AUTH_DB_PATH = process.env.WEB_AUTH_DB_PATH?.trim() || path.join(__dirname, '../../web-auth.db');
const db = new sqlite3.Database(AUTH_DB_PATH);

interface RunResult {
  changes: number;
}

export interface VoiceKeyword {
  phrase: string;
  url: string;
  canonicalVideoId: string;
  updatedBy: string;
  updatedAt: number;
  createdAt: number;
}

interface DbVoiceKeywordRow {
  phrase: string;
  url: string;
  canonicalVideoId: string;
  updatedBy: string;
  updatedAt: number;
  createdAt: number;
}

export interface VoiceKeywordListResult {
  items: VoiceKeyword[];
  nextCursor: string | null;
}

function run(sql: string, params: unknown[] = []): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ changes: this.changes ?? 0 });
    });
  });
}

function get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row as T | undefined);
    });
  });
}

function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve((rows || []) as T[]);
    });
  });
}

function normalizePhrase(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return parsed;
  } catch {
    return 0;
  }
}

function mapRow(row: DbVoiceKeywordRow): VoiceKeyword {
  return {
    phrase: row.phrase,
    url: row.url,
    canonicalVideoId: row.canonicalVideoId,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

function canonicalizeUrl(url: string): { canonicalVideoId: string; canonicalUrl: string } {
  const canonicalVideoId = extractYouTubeVideoId(url);
  if (!canonicalVideoId) {
    throw new Error('Virheellinen YouTube-linkki avainsanalle.');
  }
  return {
    canonicalVideoId,
    canonicalUrl: canonicalYouTubeUrl(canonicalVideoId),
  };
}

const schemaReady = (async () => {
  await run(`
    CREATE TABLE IF NOT EXISTS voice_keywords (
      phrase TEXT PRIMARY KEY COLLATE NOCASE,
      url TEXT NOT NULL,
      canonical_video_id TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_voice_keywords_phrase ON voice_keywords(phrase COLLATE NOCASE)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_voice_keywords_updated_at ON voice_keywords(updated_at DESC)`);
})();

export async function listVoiceKeywords(
  query: string,
  cursor: string | null,
  limit: number
): Promise<VoiceKeywordListResult> {
  await schemaReady;
  const normalizedLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? limit : 25));
  const offset = decodeCursor(cursor);
  const normalizedQuery = normalizePhrase(query || '');

  const params: unknown[] = [];
  let where = '';
  if (normalizedQuery) {
    where = 'WHERE phrase LIKE ?';
    params.push(`%${normalizedQuery}%`);
  }
  params.push(normalizedLimit + 1, offset);

  const rows = await all<DbVoiceKeywordRow>(`
    SELECT
      phrase AS phrase,
      url AS url,
      canonical_video_id AS canonicalVideoId,
      updated_by AS updatedBy,
      updated_at AS updatedAt,
      created_at AS createdAt
    FROM voice_keywords
    ${where}
    ORDER BY updated_at DESC, phrase ASC
    LIMIT ? OFFSET ?
  `, params);

  const hasMore = rows.length > normalizedLimit;
  return {
    items: rows.slice(0, normalizedLimit).map(mapRow),
    nextCursor: hasMore ? encodeCursor(offset + normalizedLimit) : null,
  };
}

export async function upsertVoiceKeyword(phrase: string, url: string, actor: string): Promise<VoiceKeyword> {
  await schemaReady;
  const normalizedPhrase = normalizePhrase(phrase);
  if (!normalizedPhrase) {
    throw new Error('Avainsana puuttuu.');
  }
  if (normalizedPhrase.length > 80) {
    throw new Error('Avainsana on liian pitkä.');
  }

  const { canonicalVideoId, canonicalUrl } = canonicalizeUrl(url);
  const timestamp = Date.now();

  await run(
    `
      INSERT INTO voice_keywords(
        phrase, url, canonical_video_id, updated_by, updated_at, created_at
      ) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(phrase) DO UPDATE SET
        url = excluded.url,
        canonical_video_id = excluded.canonical_video_id,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `,
    [normalizedPhrase, canonicalUrl, canonicalVideoId, actor, timestamp, timestamp]
  );

  const row = await get<DbVoiceKeywordRow>(`
    SELECT
      phrase AS phrase,
      url AS url,
      canonical_video_id AS canonicalVideoId,
      updated_by AS updatedBy,
      updated_at AS updatedAt,
      created_at AS createdAt
    FROM voice_keywords
    WHERE phrase = ?
  `, [normalizedPhrase]);

  if (!row) {
    throw new Error('Avainsanan tallennus epäonnistui.');
  }
  return mapRow(row);
}

export async function deleteVoiceKeyword(phrase: string): Promise<boolean> {
  await schemaReady;
  const normalizedPhrase = normalizePhrase(phrase);
  if (!normalizedPhrase) return false;
  const result = await run(`DELETE FROM voice_keywords WHERE phrase = ?`, [normalizedPhrase]);
  return result.changes > 0;
}

export async function loadVoiceKeywordMap(): Promise<Record<string, string>> {
  await schemaReady;
  const rows = await all<DbVoiceKeywordRow>(`
    SELECT
      phrase AS phrase,
      url AS url,
      canonical_video_id AS canonicalVideoId,
      updated_by AS updatedBy,
      updated_at AS updatedAt,
      created_at AS createdAt
    FROM voice_keywords
  `);
  const out: Record<string, string> = {};
  for (const row of rows) {
    out[normalizePhrase(row.phrase)] = row.url;
  }
  return out;
}
