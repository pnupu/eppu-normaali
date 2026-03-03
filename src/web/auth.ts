import crypto from 'crypto';
import path from 'path';
import sqlite3 from 'sqlite3';

interface Session {
  email: string;
  name: string;
  isAdmin: boolean;
  guildId: string | null;
}

interface DbSessionRow {
  email: string;
  name: string;
  isAdmin: number;
  expiresAt: number;
  guildId: string | null;
}

interface DbDiscordLoginRow {
  discordUserId: string;
  name: string;
  guildId: string | null;
  isAdmin: number;
  expiresAt: number;
}

const SESSION_TTL_MS = Math.max(
  60_000,
  parseInt(process.env.WEB_SESSION_TTL_MS || '86400000', 10) || 86_400_000
); // 24h default
const AUTH_DB_PATH = process.env.WEB_AUTH_DB_PATH?.trim() || path.join(__dirname, '../../web-auth.db');

const db = new sqlite3.Database(AUTH_DB_PATH);
let lastPruneAt = 0;

interface RunResult {
  changes: number;
}

function run(sql: string, params: unknown[] = []): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ changes: this.changes ?? 0 });
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

const schemaReady = (async () => {
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      guild_id TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS discord_login_links (
      token TEXT PRIMARY KEY,
      discord_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_login_links_expires ON discord_login_links(expires_at)`);

  // Migration for older DBs created before guild_id existed.
  const sessionColumns = await all<{ name: string }>(`PRAGMA table_info(sessions)`);
  if (!sessionColumns.some((column) => column.name === 'guild_id')) {
    await run(`ALTER TABLE sessions ADD COLUMN guild_id TEXT`);
  }
  const loginLinkColumns = await all<{ name: string }>(`PRAGMA table_info(discord_login_links)`);
  if (!loginLinkColumns.some((column) => column.name === 'guild_id')) {
    await run(`ALTER TABLE discord_login_links ADD COLUMN guild_id TEXT`);
  }

  await run(`CREATE INDEX IF NOT EXISTS idx_sessions_guild ON sessions(guild_id)`);
})();

async function pruneExpiredIfNeeded(): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < 60_000) return;
  lastPruneAt = now;

  await run(`DELETE FROM sessions WHERE expires_at <= ?`, [now]);
  await run(`DELETE FROM discord_login_links WHERE expires_at <= ?`, [now]);
}

function parseSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/session=([^;]+)/);
  return match?.[1] || null;
}

async function createSession(email: string, name: string, isAdmin: boolean, guildId: string | null): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  await run(
    `INSERT INTO sessions(token, email, name, is_admin, guild_id, expires_at, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [token, email, name, isAdmin ? 1 : 0, guildId, expiresAt, now]
  );

  return token;
}

export async function getSessionFromCookie(cookieHeader: string | undefined): Promise<Session | null> {
  await schemaReady;
  await pruneExpiredIfNeeded();

  const token = parseSessionToken(cookieHeader);
  if (!token) return null;

  const row = await get<DbSessionRow>(
    `SELECT email, name, is_admin as isAdmin, guild_id as guildId, expires_at as expiresAt FROM sessions WHERE token = ?`,
    [token]
  );

  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    await run(`DELETE FROM sessions WHERE token = ?`, [token]);
    return null;
  }

  return {
    email: row.email,
    name: row.name,
    isAdmin: row.isAdmin === 1,
    guildId: row.guildId || null,
  };
}

export async function logoutSessionFromCookie(cookieHeader: string | undefined): Promise<boolean> {
  await schemaReady;
  const token = parseSessionToken(cookieHeader);
  if (!token) return false;
  const result = await run(`DELETE FROM sessions WHERE token = ?`, [token]);
  return result.changes > 0;
}

export async function createDiscordLoginLink(
  discordUserId: string,
  name: string,
  guildId: string,
  isAdmin: boolean
): Promise<{ token: string; expiresAt: number }> {
  await schemaReady;
  await pruneExpiredIfNeeded();

  const ttlMs = Math.max(60_000, parseInt(process.env.WEB_LOGIN_TOKEN_TTL_MS || '600000', 10) || 600_000);
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + ttlMs;

  await run(
    `INSERT INTO discord_login_links(token, discord_user_id, name, guild_id, is_admin, expires_at, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [token, discordUserId, name, guildId, isAdmin ? 1 : 0, expiresAt, now]
  );

  return { token, expiresAt };
}

export async function consumeDiscordLoginLink(
  token: string
): Promise<{ token: string; isAdmin: boolean; name: string } | null> {
  await schemaReady;
  await pruneExpiredIfNeeded();
  await run('BEGIN IMMEDIATE TRANSACTION');
  try {
    const link = await get<DbDiscordLoginRow>(
      `SELECT discord_user_id as discordUserId, name, guild_id as guildId, is_admin as isAdmin, expires_at as expiresAt
       FROM discord_login_links WHERE token = ?`,
      [token]
    );

    if (!link) {
      await run('ROLLBACK');
      return null;
    }

    // One-time token: atomically consume.
    const deleteResult = await run(`DELETE FROM discord_login_links WHERE token = ?`, [token]);
    if (deleteResult.changes === 0) {
      await run('ROLLBACK');
      return null;
    }

    if (link.expiresAt <= Date.now()) {
      await run('COMMIT');
      return null;
    }

    const sessionToken = await createSession(
      `discord:${link.discordUserId}`,
      link.name,
      link.isAdmin === 1,
      link.guildId || process.env.WEB_DEFAULT_GUILD_ID?.trim() || null
    );
    await run('COMMIT');
    return { token: sessionToken, isAdmin: link.isAdmin === 1, name: link.name };
  } catch (error) {
    try {
      await run('ROLLBACK');
    } catch {
      // Ignore rollback failures.
    }
    throw error;
  }
}
