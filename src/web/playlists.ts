import crypto from 'crypto';
import path from 'path';
import sqlite3 from 'sqlite3';
import youtubeDl, { Flags } from 'youtube-dl-exec';
import fs from 'fs';

const AUTH_DB_PATH = process.env.WEB_AUTH_DB_PATH?.trim() || path.join(__dirname, '../../web-auth.db');
const DEFAULT_COOKIES_PATH = path.join(__dirname, '../../cookies.txt');
const db = new sqlite3.Database(AUTH_DB_PATH);

interface RunResult {
  changes: number;
  lastID: number;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
  songCount: number;
}

export interface PlaylistSong {
  id: string;
  playlistId: string;
  position: number;
  title: string;
  url: string;
  canonicalVideoId: string;
  addedBy: string;
  addedAt: number;
}

export interface PlaylistDetail extends PlaylistSummary {
  songs: PlaylistSong[];
  songNextCursor: string | null;
}

export interface PlaylistSongInput {
  title: string;
  url: string;
  canonicalVideoId: string;
}

export interface BulkAddResult {
  added: number;
  skippedDuplicates: number;
  failed: number;
}

export interface PagedResult<T> {
  items: T[];
  nextCursor: string | null;
}

export class PlaylistConflictError extends Error {}
export class PlaylistNotFoundError extends Error {}

function run(sql: string, params: unknown[] = []): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({
        changes: this.changes ?? 0,
        lastID: this.lastID ?? 0,
      });
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

function exec(sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function isConstraintError(error: unknown): boolean {
  const message = (error as { message?: string } | null)?.message || '';
  return message.includes('SQLITE_CONSTRAINT');
}

function now(): number {
  return Date.now();
}

function normalizePlaylistName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function makeId(): string {
  return crypto.randomBytes(12).toString('hex');
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

interface DbPlaylistRow {
  id: string;
  name: string;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
  songCount: number;
}

interface DbPlaylistSongRow {
  id: string;
  playlistId: string;
  position: number;
  title: string;
  url: string;
  canonicalVideoId: string;
  addedBy: string;
  addedAt: number;
}

const schemaReady = (async () => {
  await exec('PRAGMA foreign_keys = ON;');

  await run(`
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS playlist_songs (
      id TEXT PRIMARY KEY,
      playlist_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      canonical_video_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      FOREIGN KEY(playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_playlists_name ON playlists(name COLLATE NOCASE)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_playlist_songs_playlist_position ON playlist_songs(playlist_id, position)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_playlist_songs_playlist_video_id ON playlist_songs(playlist_id, canonical_video_id)`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_playlist_song_unique_video ON playlist_songs(playlist_id, canonical_video_id)`);
})();

function mapPlaylistRow(row: DbPlaylistRow): PlaylistSummary {
  return {
    id: row.id,
    name: row.name,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    songCount: row.songCount ?? 0,
  };
}

function mapSongRow(row: DbPlaylistSongRow): PlaylistSong {
  return {
    id: row.id,
    playlistId: row.playlistId,
    position: row.position,
    title: row.title,
    url: row.url,
    canonicalVideoId: row.canonicalVideoId,
    addedBy: row.addedBy,
    addedAt: row.addedAt,
  };
}

async function touchPlaylist(playlistId: string, actor: string): Promise<void> {
  await run(
    `UPDATE playlists SET updated_by = ?, updated_at = ? WHERE id = ?`,
    [actor, now(), playlistId]
  );
}

async function ensurePlaylistExists(playlistId: string): Promise<void> {
  const row = await get<{ id: string }>(`SELECT id FROM playlists WHERE id = ?`, [playlistId]);
  if (!row) throw new PlaylistNotFoundError('Playlist not found');
}

export async function listPlaylists(query: string, cursor: string | null, limit: number): Promise<PagedResult<PlaylistSummary>> {
  await schemaReady;
  const normalizedLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? limit : 20));
  const offset = decodeCursor(cursor);
  const normalizedQuery = query.trim();

  const params: unknown[] = [];
  let where = '';
  if (normalizedQuery) {
    where = 'WHERE p.name LIKE ?';
    params.push(`%${normalizedQuery}%`);
  }
  params.push(normalizedLimit + 1, offset);

  const rows = await all<DbPlaylistRow>(`
    SELECT
      p.id AS id,
      p.name AS name,
      p.created_by AS createdBy,
      p.updated_by AS updatedBy,
      p.created_at AS createdAt,
      p.updated_at AS updatedAt,
      COALESCE(COUNT(ps.id), 0) AS songCount
    FROM playlists p
    LEFT JOIN playlist_songs ps ON ps.playlist_id = p.id
    ${where}
    GROUP BY p.id
    ORDER BY p.updated_at DESC, p.name ASC
    LIMIT ? OFFSET ?
  `, params);

  const hasMore = rows.length > normalizedLimit;
  const items = rows.slice(0, normalizedLimit).map(mapPlaylistRow);
  return {
    items,
    nextCursor: hasMore ? encodeCursor(offset + normalizedLimit) : null,
  };
}

export async function createPlaylist(name: string, actor: string): Promise<PlaylistSummary> {
  await schemaReady;
  const normalizedName = normalizePlaylistName(name);
  if (!normalizedName) {
    throw new Error('Playlist name is required');
  }

  const id = makeId();
  const timestamp = now();

  try {
    await run(
      `INSERT INTO playlists(id, name, created_by, updated_by, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?)`,
      [id, normalizedName, actor, actor, timestamp, timestamp]
    );
  } catch (error) {
    if (isConstraintError(error)) {
      throw new PlaylistConflictError('Playlist name already exists');
    }
    throw error;
  }

  return {
    id,
    name: normalizedName,
    createdBy: actor,
    updatedBy: actor,
    createdAt: timestamp,
    updatedAt: timestamp,
    songCount: 0,
  };
}

export async function renamePlaylist(playlistId: string, name: string, actor: string): Promise<PlaylistSummary> {
  await schemaReady;
  const normalizedName = normalizePlaylistName(name);
  if (!normalizedName) {
    throw new Error('Playlist name is required');
  }

  try {
    const result = await run(
      `UPDATE playlists
       SET name = ?, updated_by = ?, updated_at = ?
       WHERE id = ?`,
      [normalizedName, actor, now(), playlistId]
    );
    if (result.changes === 0) {
      throw new PlaylistNotFoundError('Playlist not found');
    }
  } catch (error) {
    if (isConstraintError(error)) {
      throw new PlaylistConflictError('Playlist name already exists');
    }
    throw error;
  }

  const row = await get<DbPlaylistRow>(`
    SELECT
      p.id AS id,
      p.name AS name,
      p.created_by AS createdBy,
      p.updated_by AS updatedBy,
      p.created_at AS createdAt,
      p.updated_at AS updatedAt,
      COALESCE(COUNT(ps.id), 0) AS songCount
    FROM playlists p
    LEFT JOIN playlist_songs ps ON ps.playlist_id = p.id
    WHERE p.id = ?
    GROUP BY p.id
  `, [playlistId]);
  if (!row) throw new PlaylistNotFoundError('Playlist not found');
  return mapPlaylistRow(row);
}

export async function deletePlaylist(playlistId: string): Promise<boolean> {
  await schemaReady;
  const result = await run(`DELETE FROM playlists WHERE id = ?`, [playlistId]);
  return result.changes > 0;
}

export async function getPlaylistDetail(
  playlistId: string,
  songQuery: string,
  songCursor: string | null,
  songLimit: number
): Promise<PlaylistDetail> {
  await schemaReady;
  const playlistRow = await get<DbPlaylistRow>(`
    SELECT
      p.id AS id,
      p.name AS name,
      p.created_by AS createdBy,
      p.updated_by AS updatedBy,
      p.created_at AS createdAt,
      p.updated_at AS updatedAt,
      COALESCE(COUNT(ps.id), 0) AS songCount
    FROM playlists p
    LEFT JOIN playlist_songs ps ON ps.playlist_id = p.id
    WHERE p.id = ?
    GROUP BY p.id
  `, [playlistId]);
  if (!playlistRow) throw new PlaylistNotFoundError('Playlist not found');

  const normalizedSongLimit = Math.min(200, Math.max(1, Number.isFinite(songLimit) ? songLimit : 50));
  const offset = decodeCursor(songCursor);
  const normalizedQuery = songQuery.trim();

  const params: unknown[] = [playlistId];
  let where = 'WHERE playlist_id = ?';
  if (normalizedQuery) {
    where += ' AND title LIKE ?';
    params.push(`%${normalizedQuery}%`);
  }
  params.push(normalizedSongLimit + 1, offset);

  const rows = await all<DbPlaylistSongRow>(`
    SELECT
      id AS id,
      playlist_id AS playlistId,
      position AS position,
      title AS title,
      url AS url,
      canonical_video_id AS canonicalVideoId,
      added_by AS addedBy,
      added_at AS addedAt
    FROM playlist_songs
    ${where}
    ORDER BY position ASC
    LIMIT ? OFFSET ?
  `, params);

  const hasMore = rows.length > normalizedSongLimit;
  const songs = rows.slice(0, normalizedSongLimit).map(mapSongRow);

  return {
    ...mapPlaylistRow(playlistRow),
    songs,
    songNextCursor: hasMore ? encodeCursor(offset + normalizedSongLimit) : null,
  };
}

export async function getAllPlaylistSongs(playlistId: string): Promise<PlaylistSong[]> {
  await schemaReady;
  const rows = await all<DbPlaylistSongRow>(`
    SELECT
      id AS id,
      playlist_id AS playlistId,
      position AS position,
      title AS title,
      url AS url,
      canonical_video_id AS canonicalVideoId,
      added_by AS addedBy,
      added_at AS addedAt
    FROM playlist_songs
    WHERE playlist_id = ?
    ORDER BY position ASC
  `, [playlistId]);
  return rows.map(mapSongRow);
}

export async function addSongsToPlaylist(playlistId: string, songs: PlaylistSongInput[], actor: string): Promise<BulkAddResult> {
  await schemaReady;
  await ensurePlaylistExists(playlistId);

  const cleanedSongs = songs
    .map((song) => ({
      title: song.title?.trim() || '',
      url: song.url?.trim() || '',
      canonicalVideoId: song.canonicalVideoId?.trim() || '',
    }));

  if (cleanedSongs.length === 0) {
    return { added: 0, skippedDuplicates: 0, failed: 0 };
  }

  let added = 0;
  let skippedDuplicates = 0;
  let failed = 0;

  await exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    const maxRow = await get<{ maxPosition: number | null }>(
      `SELECT MAX(position) AS maxPosition FROM playlist_songs WHERE playlist_id = ?`,
      [playlistId]
    );
    let nextPosition = ((maxRow?.maxPosition ?? -1) + 1);

    for (const song of cleanedSongs) {
      if (!song.title || !song.url || !song.canonicalVideoId) {
        failed += 1;
        continue;
      }

      try {
        const result = await run(
          `INSERT OR IGNORE INTO playlist_songs(
            id, playlist_id, position, title, url, canonical_video_id, added_by, added_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
          [makeId(), playlistId, nextPosition, song.title, song.url, song.canonicalVideoId, actor, now()]
        );
        if (result.changes === 0) {
          skippedDuplicates += 1;
          continue;
        }
        added += 1;
        nextPosition += 1;
      } catch {
        failed += 1;
      }
    }

    await touchPlaylist(playlistId, actor);
    await exec('COMMIT');
  } catch (error) {
    await exec('ROLLBACK');
    throw error;
  }

  return { added, skippedDuplicates, failed };
}

export async function removePlaylistSong(playlistId: string, songId: string, actor: string): Promise<boolean> {
  await schemaReady;
  await ensurePlaylistExists(playlistId);
  const target = await get<{ position: number }>(
    `SELECT position FROM playlist_songs WHERE playlist_id = ? AND id = ?`,
    [playlistId, songId]
  );
  if (!target) return false;

  await exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    await run(`DELETE FROM playlist_songs WHERE playlist_id = ? AND id = ?`, [playlistId, songId]);
    await run(
      `UPDATE playlist_songs
       SET position = position - 1
       WHERE playlist_id = ? AND position > ?`,
      [playlistId, target.position]
    );
    await touchPlaylist(playlistId, actor);
    await exec('COMMIT');
  } catch (error) {
    await exec('ROLLBACK');
    throw error;
  }
  return true;
}

export async function movePlaylistSong(
  playlistId: string,
  fromIndex: number,
  toIndex: number,
  actor: string
): Promise<boolean> {
  await schemaReady;
  await ensurePlaylistExists(playlistId);
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || toIndex < 0) {
    return false;
  }

  const countRow = await get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM playlist_songs WHERE playlist_id = ?`,
    [playlistId]
  );
  const count = countRow?.count ?? 0;
  if (fromIndex >= count || toIndex >= count) return false;
  if (fromIndex === toIndex) return true;

  const movingRow = await get<{ id: string }>(
    `SELECT id FROM playlist_songs WHERE playlist_id = ? AND position = ?`,
    [playlistId, fromIndex]
  );
  if (!movingRow) return false;

  await exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    if (fromIndex < toIndex) {
      await run(
        `UPDATE playlist_songs
         SET position = position - 1
         WHERE playlist_id = ? AND position > ? AND position <= ?`,
        [playlistId, fromIndex, toIndex]
      );
    } else {
      await run(
        `UPDATE playlist_songs
         SET position = position + 1
         WHERE playlist_id = ? AND position >= ? AND position < ?`,
        [playlistId, toIndex, fromIndex]
      );
    }

    await run(
      `UPDATE playlist_songs SET position = ? WHERE playlist_id = ? AND id = ?`,
      [toIndex, playlistId, movingRow.id]
    );

    await touchPlaylist(playlistId, actor);
    await exec('COMMIT');
  } catch (error) {
    await exec('ROLLBACK');
    throw error;
  }

  return true;
}

interface YtRuntime {
  jsRuntimes: string;
  cookies: string | null;
  cookiesFromBrowser: string | null;
}

function getYtRuntime(): YtRuntime {
  const jsRuntimes = process.env.YTDLP_JS_RUNTIMES?.trim() || 'node';
  const cookiesPath = process.env.YTDLP_COOKIES_FILE?.trim() || DEFAULT_COOKIES_PATH;
  const cookies = fs.existsSync(cookiesPath) ? cookiesPath : null;
  const cookiesFromBrowserRaw = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  const cookiesFromBrowser = cookiesFromBrowserRaw || null;
  return { jsRuntimes, cookies, cookiesFromBrowser };
}

function withYtRuntime(baseFlags: Flags): Flags {
  const runtime = getYtRuntime();
  const merged = { ...baseFlags } as Flags & { cookiesFromBrowser?: string };
  merged.jsRuntimes = runtime.jsRuntimes as Flags['jsRuntimes'];
  if (runtime.cookies) {
    merged.cookies = runtime.cookies;
  } else if (runtime.cookiesFromBrowser) {
    merged.cookiesFromBrowser = runtime.cookiesFromBrowser;
  }
  return merged;
}

export function extractYouTubeVideoId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;

  if (!/^https?:\/\//.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.replace(/^www\./, '');
    const v = parsed.searchParams.get('v');
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
    if (host === 'youtu.be') {
      const first = parsed.pathname.split('/').filter(Boolean)[0];
      if (first && /^[a-zA-Z0-9_-]{11}$/.test(first)) return first;
    }
    const shorts = parsed.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shorts?.[1]) return shorts[1];
    const embed = parsed.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
    if (embed?.[1]) return embed[1];
  } catch {
    return null;
  }
  return null;
}

export function canonicalYouTubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

interface YtVideoInfo {
  id?: string;
  title?: string;
  webpage_url?: string;
  url?: string;
}

interface YtPlaylistInfo {
  title?: string;
  entries?: Array<{ id?: string; title?: string; url?: string }>;
}

export async function resolveYouTubeSong(url: string): Promise<PlaylistSongInput> {
  const flags = withYtRuntime({
    dumpSingleJson: true,
    simulate: true,
    format: 'bestaudio',
  });
  const info = await youtubeDl(url, flags) as unknown as YtVideoInfo;
  const fallbackSource = info.webpage_url || info.url || url;
  const canonicalVideoId = extractYouTubeVideoId(info.id || fallbackSource || '');
  if (!canonicalVideoId) {
    throw new Error('YouTube video ID not found in URL');
  }
  const title = (info.title || '').trim();
  if (!title) {
    throw new Error('Video title could not be resolved');
  }
  return {
    title,
    url: canonicalYouTubeUrl(canonicalVideoId),
    canonicalVideoId,
  };
}

export async function resolveYouTubePlaylistSongs(url: string): Promise<{ sourceTitle: string; songs: PlaylistSongInput[] }> {
  const flags = withYtRuntime({
    dumpSingleJson: true,
    flatPlaylist: true,
    simulate: true,
  });
  const payload = await youtubeDl(url, flags) as unknown as YtPlaylistInfo;
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const songs: PlaylistSongInput[] = [];

  for (const entry of entries) {
    const canonicalVideoId = extractYouTubeVideoId(entry.id || entry.url || '');
    if (!canonicalVideoId) continue;
    songs.push({
      title: (entry.title || `YouTube ${canonicalVideoId}`).trim(),
      url: canonicalYouTubeUrl(canonicalVideoId),
      canonicalVideoId,
    });
  }

  return {
    sourceTitle: (payload.title || 'Tuotu YouTube-soittolista').trim(),
    songs,
  };
}
