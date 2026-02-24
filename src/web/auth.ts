import crypto from 'crypto';
import path from 'path';
import sqlite3 from 'sqlite3';

interface Session {
  email: string;
  name: string;
  isAdmin: boolean;
}

interface DbSessionRow {
  email: string;
  name: string;
  isAdmin: number;
  expiresAt: number;
}

interface DbDiscordLoginRow {
  discordUserId: string;
  name: string;
  guildId: string;
  isAdmin: number;
  expiresAt: number;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const AUTH_DB_PATH = process.env.WEB_AUTH_DB_PATH?.trim() || path.join(__dirname, '../../web-auth.db');

const db = new sqlite3.Database(AUTH_DB_PATH);
let lastPruneAt = 0;

function run(sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => {
      if (err) reject(err);
      else resolve();
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

const schemaReady = (async () => {
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
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

async function createSession(email: string, name: string, isAdmin: boolean): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  await run(
    `INSERT INTO sessions(token, email, name, is_admin, expires_at, created_at) VALUES(?, ?, ?, ?, ?, ?)`,
    [token, email, name, isAdmin ? 1 : 0, expiresAt, now]
  );

  return token;
}

export async function getSessionFromCookie(cookieHeader: string | undefined): Promise<Session | null> {
  await schemaReady;
  await pruneExpiredIfNeeded();

  const token = parseSessionToken(cookieHeader);
  if (!token) return null;

  const row = await get<DbSessionRow>(
    `SELECT email, name, is_admin as isAdmin, expires_at as expiresAt FROM sessions WHERE token = ?`,
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
  };
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

  const link = await get<DbDiscordLoginRow>(
    `SELECT discord_user_id as discordUserId, name, guild_id as guildId, is_admin as isAdmin, expires_at as expiresAt
     FROM discord_login_links WHERE token = ?`,
    [token]
  );

  if (!link) return null;

  // One-time token: consume immediately.
  await run(`DELETE FROM discord_login_links WHERE token = ?`, [token]);

  if (link.expiresAt <= Date.now()) {
    return null;
  }

  const sessionToken = await createSession(`discord:${link.discordUserId}`, link.name, link.isAdmin === 1);
  return { token: sessionToken, isAdmin: link.isAdmin === 1, name: link.name };
}
