import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Client } from 'discord.js';
import { queues, enqueueFromWeb, getPlaybackPositionMs, getVolume, refreshNextSongPrefetch, setVolume } from '../commands/play';
import { classifyInput, extractYouTubeVideoId, ResolveError, resolveInput, searchTracks, youtubeTrack, type Track } from '../music/sources';
import type { QueueItem } from '../music/queue';
import { DEFAULT_VOICE_KEYWORDS, executeVoiceCommand } from '../voice/commandExecutor';
import { consumeDiscordLoginLink, getSessionFromCookie, logoutSessionFromCookie } from './auth';
import {
  addSongsToPlaylist,
  BulkAddResult,
  createPlaylist,
  deletePlaylist,
  getAllPlaylistSongs,
  getPlaylistDetail,
  listPlaylists,
  movePlaylistSong,
  PlaylistConflictError,
  PlaylistNotFoundError,
  removePlaylistSong,
  renamePlaylist,
} from './playlists';
import {
  deleteVoiceKeyword,
  listVoiceKeywords,
  loadVoiceKeywordMap,
  upsertVoiceKeyword,
} from './voiceKeywords';
import { logUsage, type UsageLogFields } from '../usageLog';

const HTML_PATH = path.join(__dirname, '../../src/web/index.html');
const CSS_PATH = path.join(__dirname, '../../src/web/styles.css');
const APP_JS_PATH = path.join(__dirname, '../../src/web/app.js');
const ASSETS_DIR = path.join(__dirname, '../../src/web/assets');

type ExposureMode = 'local' | 'tunnel';

interface StaticAsset {
  body: Buffer;
  contentType: string;
  etag: string;
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
function envBool(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function envBoolOptional(value: string | undefined): boolean | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return null;
}

function publicBaseUrlProtocol(): string | null {
  const baseUrl = process.env.WEB_BASE_URL?.trim();
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).protocol;
  } catch {
    return null;
  }
}

function resolveSecureCookieDefault(exposureMode: ExposureMode): boolean {
  const explicit = envBoolOptional(process.env.WEB_COOKIE_SECURE);
  if (explicit !== null) return explicit;

  const protocol = publicBaseUrlProtocol();
  if (protocol === 'https:') return true;
  if (protocol === 'http:') return false;

  return exposureMode === 'tunnel';
}

function makeEtag(content: Buffer | string): string {
  const hash = crypto.createHash('sha1').update(content).digest('hex').slice(0, 16);
  return `W/"${hash}"`;
}

function parseAllowedOrigins(value: string | undefined): Set<string> {
  if (!value) return new Set<string>();
  return new Set(
    value
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean)
  );
}

function normalizeVoiceKeyword(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseVoiceKeywordConfig(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const entries = value
    .split(',')
    .map((row) => row.trim())
    .filter(Boolean);

  const out: Record<string, string> = {};
  for (const entry of entries) {
    const sep = entry.indexOf('=');
    if (sep <= 0) continue;
    const key = normalizeVoiceKeyword(entry.slice(0, sep));
    const url = entry.slice(sep + 1).trim();
    if (!key || !url) continue;
    out[key] = url;
  }
  return out;
}

function getRequestOrigin(req: http.IncomingMessage): string | null {
  const origin = req.headers.origin;
  return typeof origin === 'string' ? origin : null;
}

function getPublicBaseUrlOrigin(): string | null {
  const baseUrl = process.env.WEB_BASE_URL?.trim();
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

function getRequestHostOrigin(req: http.IncomingMessage, trustProxy: boolean): string | null {
  const forwardedHost = trustProxy ? req.headers['x-forwarded-host'] : undefined;
  const hostHeader = Array.isArray(forwardedHost)
    ? forwardedHost[0]
    : (forwardedHost || req.headers.host);
  if (!hostHeader) return null;

  const forwardedProto = trustProxy ? req.headers['x-forwarded-proto'] : undefined;
  const protoHeader = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const protocol = protoHeader?.split(',')[0]?.trim() || 'http';

  try {
    return new URL(`${protocol}://${hostHeader}`).origin;
  } catch {
    return null;
  }
}

function getClientIp(req: http.IncomingMessage): string {
  return req.socket.remoteAddress || 'unknown';
}

function getClientIpForRateLimit(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    if (Array.isArray(forwarded) && forwarded.length > 0) {
      return forwarded[0].split(',')[0].trim();
    }
  }
  return getClientIp(req);
}

function loadStaticAsset(filePath: string, contentType: string): StaticAsset {
  const body = fs.readFileSync(filePath);
  return {
    body,
    contentType,
    etag: makeEtag(body),
  };
}

function assetContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.avif':
      return 'image/avif';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(
  res: http.ServerResponse,
  data: any,
  status = 200,
  extraHeaders: Record<string, string> = {}
) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(data));
}

function applySecurityHeaders(res: http.ServerResponse) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}

function applyCorsHeaders(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  exposureMode: ExposureMode,
  allowedOrigins: Set<string>,
  trustProxy: boolean
): boolean {
  const origin = getRequestOrigin(req);
  const hasOrigin = !!origin;
  const publicOrigin = getPublicBaseUrlOrigin();
  const requestHostOrigin = getRequestHostOrigin(req, trustProxy);
  const originAllowed = !origin
    || exposureMode === 'local'
    || allowedOrigins.has(origin)
    || origin === publicOrigin
    || origin === requestHostOrigin;

  if (hasOrigin) {
    res.setHeader('Vary', 'Origin');
  }

  if (hasOrigin && origin && originAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!hasOrigin && exposureMode === 'local') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Eppu-Token');
  return originAllowed;
}

function isRateLimited(
  req: http.IncomingMessage,
  rateLimits: Map<string, RateLimitEntry>,
  limitPerMinute: number,
  trustProxy: boolean
): boolean {
  const ip = getClientIpForRateLimit(req, trustProxy);
  const now = Date.now();
  const current = rateLimits.get(ip);

  if (!current || now - current.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(ip, { count: 1, windowStart: now });
    return false;
  }

  if (current.count >= limitPerMinute) {
    return true;
  }

  current.count += 1;
  return false;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function toOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseIndexList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const item of value) {
    const n = Number.parseInt(String(item), 10);
    if (!Number.isFinite(n) || n < 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.sort((a, b) => a - b);
}

function shuffleArray<T>(input: T[]): T[] {
  const result = [...input];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = result[i];
    result[i] = result[j];
    result[j] = tmp;
  }
  return result;
}

function toTrack(item: QueueItem): Track {
  const { requestedBy: _requestedBy, ...track } = item;
  return track;
}

function queueSelectionToTracks(
  guildId: string,
  includeCurrent: boolean,
  selectedIndices: number[] | null
): { songs: Track[]; skipped: number; queueFound: boolean } {
  const queue = queues.get(guildId);
  if (!queue) {
    return { songs: [], skipped: 0, queueFound: false };
  }
  const songs: Track[] = [];
  let skipped = 0;
  const currentSong = queue.getCurrentSong();
  if (includeCurrent && currentSong) songs.push(toTrack(currentSong));
  const queuedSongs = queue.getQueue();
  for (const index of selectedIndices ?? queuedSongs.map((_, i) => i)) {
    const item = queuedSongs[index];
    if (item) songs.push(toTrack(item));
    else skipped += 1;
  }
  return { songs, skipped, queueFound: true };
}

const TRACK_SOURCES = new Set(['youtube', 'soundcloud', 'spotify']);

/**
 * Validate a track sent back by the browser (search results, saved songs). The URL must belong to the claimed
 * source, so a crafted request cannot point yt-dlp at arbitrary URLs.
 */
function parseClientTrack(value: unknown): Track | null {
  const raw = value as Partial<Record<keyof Track, unknown>> | null;
  if (!raw || typeof raw !== 'object') return null;
  const source = raw.source;
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 300) : '';
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (typeof source !== 'string' || !TRACK_SOURCES.has(source) || !title || !url) return null;
  const duration = typeof raw.duration === 'number' && Number.isFinite(raw.duration) && raw.duration > 0
    ? Math.round(raw.duration)
    : null;
  const thumbnail = typeof raw.thumbnail === 'string' && /^https:\/\//.test(raw.thumbnail) ? raw.thumbnail.slice(0, 500) : null;
  const kind = classifyInput(url);
  if (source === 'youtube') {
    const videoId = kind.kind === 'youtube' ? extractYouTubeVideoId(url) : null;
    return videoId ? { ...youtubeTrack(videoId, title, duration), thumbnail: thumbnail ?? youtubeTrack(videoId, title).thumbnail } : null;
  }
  if (source === 'spotify') {
    return kind.kind === 'spotify' && kind.type === 'track'
      ? { source, key: `sp:${kind.id}`, title, url: `https://open.spotify.com/track/${kind.id}`, duration, thumbnail }
      : null;
  }
  const key = typeof raw.key === 'string' && /^sc:[^\s]{1,500}$/.test(raw.key) ? raw.key : null;
  return kind.kind === 'soundcloud' && key ? { source: 'soundcloud', key, title, url, duration, thumbnail } : null;
}

function readActorName(session: { name?: string | null } | null, localMode: boolean): string {
  if (session?.name) return session.name;
  return localMode ? 'Paikallinen tila' : 'Web käyttäjä';
}

function readSessionUserId(session: { email?: string | null } | null): string | null {
  const email = session?.email || '';
  return email.startsWith('discord:') ? email.slice('discord:'.length) : null;
}

function webUsageContext(
  req: http.IncomingMessage,
  session: { email?: string | null; name?: string | null; isAdmin?: boolean; guildId?: string | null } | null,
  localMode: boolean,
  trustProxy: boolean,
  guildId?: string | null
): UsageLogFields {
  return {
    source: 'web',
    actor: readActorName(session, localMode),
    userId: readSessionUserId(session),
    guildId: guildId ?? session?.guildId ?? null,
    localMode,
    isAdmin: session?.isAdmin ?? false,
    clientIp: getClientIpForRateLimit(req, trustProxy),
  };
}

function queueUsageMetrics(queue: any): UsageLogFields {
  if (!queue) return { queuePresent: false };
  const currentSong = queue.getCurrentSong?.();
  return {
    queuePresent: true,
    currentTitle: currentSong?.title ?? null,
    currentUrl: currentSong?.url ?? null,
    queuedCount: queue.getQueue?.().length ?? 0,
    hasNextSong: queue.hasNextSong?.() ?? false,
    paused: queue.isPausedState?.() ?? false,
    playerState: queue.getPlayer?.().state?.status ?? null,
  };
}

function mergeBulkResult(base: BulkAddResult, extra: BulkAddResult): BulkAddResult {
  return {
    added: base.added + extra.added,
    skippedDuplicates: base.skippedDuplicates + extra.skippedDuplicates,
    failed: base.failed + extra.failed,
  };
}

interface GuildAccessResult {
  guildId: string | null;
  status?: number;
  error?: string;
}

function resolveAuthorizedGuildId(
  requestedGuildId: string | null,
  sessionGuildId: string | null,
  localMode: boolean,
  defaultGuildId: string | null
): GuildAccessResult {
  if (localMode) {
    return { guildId: requestedGuildId || defaultGuildId };
  }
  if (!sessionGuildId) {
    return {
      guildId: null,
      status: 401,
      error: 'Session missing guild scope, please login again',
    };
  }
  if (requestedGuildId && requestedGuildId !== sessionGuildId) {
    return {
      guildId: null,
      status: 403,
      error: 'Guild access denied',
    };
  }
  return { guildId: sessionGuildId };
}

function makeSessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`,
  ];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function makeClearedSessionCookie(secure: boolean): string {
  const parts = [
    'session=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function tryServeStaticAsset(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  staticAssets: Map<string, StaticAsset>,
  url: string,
  method: string
): boolean {
  if (method !== 'GET') return false;
  const asset = staticAssets.get(url);
  if (!asset) return false;

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch === asset.etag) {
    res.writeHead(304, { ETag: asset.etag, 'Cache-Control': 'public, max-age=300' });
    res.end();
    return true;
  }

  res.writeHead(200, {
    'Content-Type': asset.contentType,
    ETag: asset.etag,
    'Cache-Control': 'public, max-age=300',
  });
  res.end(asset.body);
  return true;
}

function tryServeAssetFile(pathname: string, method: string, res: http.ServerResponse): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (!pathname.startsWith('/assets/')) return false;

  const relativePath = pathname.slice('/assets/'.length);
  if (!relativePath || relativePath.includes('..')) return false;

  const filePath = path.normalize(path.join(ASSETS_DIR, relativePath));
  if (!filePath.startsWith(ASSETS_DIR)) return false;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;

  res.writeHead(200, {
    'Content-Type': assetContentType(filePath),
    'Cache-Control': 'public, max-age=3600',
  });
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(filePath).pipe(res);
  return true;
}

export function startWebServer(client: Client) {
  const port = parseInt(process.env.WEB_PORT || '3000', 10);
  const localMode = envBool(process.env.WEB_LOCAL_MODE, false);
  const exposureMode: ExposureMode = process.env.WEB_EXPOSURE_MODE === 'tunnel' ? 'tunnel' : 'local';
  const secureCookie = resolveSecureCookieDefault(exposureMode);
  const trustProxy = envBool(process.env.WEB_TRUST_PROXY, false);
  const sessionCookieMaxAgeSeconds = Math.max(
    60,
    Math.floor((parseInt(process.env.WEB_SESSION_TTL_MS || '2592000000', 10) || 2_592_000_000) / 1000)
  );
  const requireAccessToken = envBool(process.env.WEB_REQUIRE_TOKEN, false);
  const accessToken = process.env.WEB_ACCESS_TOKEN?.trim() || '';
  const rateLimitPerMinute = Math.max(10, Number.parseInt(process.env.WEB_RATE_LIMIT_PER_MIN || '180', 10) || 180);
  const allowedOrigins = parseAllowedOrigins(process.env.WEB_ALLOWED_ORIGINS);
  const defaultGuildId = process.env.WEB_DEFAULT_GUILD_ID?.trim() || process.env.DISCORD_GUILD_ID?.trim() || null;
  const baseVoiceKeywordMap = {
    ...DEFAULT_VOICE_KEYWORDS,
    ...parseVoiceKeywordConfig(process.env.WEB_VOICE_KEYWORDS),
  };

  const staticAssets = new Map<string, StaticAsset>([
    ['/', loadStaticAsset(HTML_PATH, 'text/html; charset=utf-8')],
    ['/index.html', loadStaticAsset(HTML_PATH, 'text/html; charset=utf-8')],
    ['/styles.css', loadStaticAsset(CSS_PATH, 'text/css; charset=utf-8')],
    ['/app.js', loadStaticAsset(APP_JS_PATH, 'application/javascript; charset=utf-8')],
  ]);

  const rateLimits = new Map<string, RateLimitEntry>();

  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url || '/';
    const requestUrl = new URL(rawUrl, 'http://localhost');
    const pathname = requestUrl.pathname;
    const method = req.method || 'GET';

    applySecurityHeaders(res);
    const originAllowed = applyCorsHeaders(req, res, exposureMode, allowedOrigins, trustProxy);
    if (method === 'OPTIONS') {
      if (!originAllowed) {
        json(res, { error: 'Origin not allowed' }, 403);
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (!originAllowed && pathname.startsWith('/api/')) {
        json(res, { error: 'Origin not allowed' }, 403);
        return;
      }

      if (tryServeStaticAsset(req, res, staticAssets, pathname, method)) {
        return;
      }

      if (tryServeAssetFile(pathname, method, res)) {
        return;
      }

      if (exposureMode === 'tunnel' && pathname.startsWith('/api/')) {
        if (isRateLimited(req, rateLimits, rateLimitPerMinute, trustProxy)) {
          json(res, { error: 'Rate limit exceeded' }, 429, { 'Retry-After': '60' });
          return;
        }

        if (requireAccessToken) {
          const tokenOptionalPath = pathname === '/api/web-config';
          if (!tokenOptionalPath) {
            const tokenHeader = req.headers['x-eppu-token'];
            const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
            if (!accessToken || token !== accessToken) {
              json(res, { error: 'Missing or invalid access token' }, 401);
              return;
            }
          }
        }
      }

      // Public config endpoints
      if (pathname === '/api/web-config' && method === 'GET') {
        json(res, {
          authRequired: !localMode,
          localMode,
          exposureMode,
          requireAccessToken,
          defaultGuildId,
          rateLimitPerMinute: exposureMode === 'tunnel' ? rateLimitPerMinute : null,
        });
        return;
      }

      if (pathname === '/api/auth/link-login' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const loginToken = typeof body?.token === 'string' ? body.token.trim() : '';
        if (!loginToken) {
          json(res, { error: 'token required' }, 400);
          return;
        }

        const result = await consumeDiscordLoginLink(loginToken);
        if (!result) {
          json(res, { error: 'Invalid or expired login token' }, 401);
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': makeSessionCookie(result.token, sessionCookieMaxAgeSeconds, secureCookie)
        });
        res.end(JSON.stringify({ ok: true, isAdmin: result.isAdmin, source: 'discord-link' }));
        return;
      }

      if (pathname === '/api/auth/logout' && method === 'POST') {
        const hadSession = await logoutSessionFromCookie(req.headers.cookie);
        json(
          res,
          { ok: true, hadSession },
          200,
          { 'Set-Cookie': makeClearedSessionCookie(secureCookie) }
        );
        return;
      }

      // All other API routes require auth unless local mode is enabled.
      const session = await getSessionFromCookie(req.headers.cookie);
      if (!localMode && !session && pathname.startsWith('/api/')) {
        json(res, { error: 'Unauthorized' }, 401);
        return;
      }

      if (pathname.startsWith('/api/playlists')) {
        const actor = readActorName(session, localMode);
        const parts = pathname.split('/').filter(Boolean);
        const baseId = parts[2] ? decodeURIComponent(parts[2]) : null;

        try {
          if (parts.length === 2 && method === 'GET') {
            const query = requestUrl.searchParams.get('query') || '';
            const cursor = requestUrl.searchParams.get('cursor');
            const limit = asNumber(requestUrl.searchParams.get('limit'), 20, 1, 100);
            const result = await listPlaylists(query, cursor, limit);
            json(res, { ok: true, items: result.items, nextCursor: result.nextCursor });
            return;
          }

          if (parts.length === 2 && method === 'POST') {
            const body = JSON.parse(await readBody(req));
            const name = toOptionalString(body?.name);
            if (!name) {
              json(res, { error: 'name required' }, 400);
              return;
            }
            const created = await createPlaylist(name, actor);
            console.log(`[playlist] create id=${created.id} name="${created.name}" actor="${actor}"`);
            json(res, { ok: true, playlist: created });
            return;
          }

          if (parts.length === 3 && baseId === 'from-queue' && method === 'POST') {
            const body = JSON.parse(await readBody(req));
            const guildAccess = resolveAuthorizedGuildId(
              toOptionalString(body?.guildId),
              session?.guildId ?? null,
              localMode,
              defaultGuildId
            );
            if (guildAccess.error) {
              json(res, { error: guildAccess.error }, guildAccess.status || 403);
              return;
            }
            const guildId = guildAccess.guildId;
            const name = toOptionalString(body?.name);
            if (!guildId) {
              json(res, { error: 'guildId required' }, 400);
              return;
            }
            if (!name) {
              json(res, { error: 'name required' }, 400);
              return;
            }
            const includeCurrent = body?.includeCurrent !== false;
            const hasSelectedIndices = Array.isArray(body?.selectedIndices);
            const selectedIndices = parseIndexList(body?.selectedIndices);
            const selected = queueSelectionToTracks(
              guildId,
              includeCurrent,
              hasSelectedIndices ? selectedIndices : null
            );
            if (!selected.queueFound) {
              json(res, { error: 'No queue' }, 404);
              return;
            }
            if (selected.songs.length === 0) {
              json(res, { error: 'Queue selection is empty' }, 400);
              return;
            }

            const created = await createPlaylist(name, actor);
            const baseResult = await addSongsToPlaylist(created.id, selected.songs, actor);
            const result = mergeBulkResult(baseResult, { added: 0, skippedDuplicates: 0, failed: selected.skipped });
            console.log(
              `[playlist] from-queue new id=${created.id} guild=${guildId} `
              + `added=${result.added} skipped=${result.skippedDuplicates} failed=${result.failed}`
            );
            json(res, { ok: true, playlist: created, result });
            return;
          }

          if (parts.length === 3 && baseId === 'import' && method === 'POST') {
            const body = JSON.parse(await readBody(req));
            const sourceUrl = toOptionalString(body?.url);
            const preferredName = toOptionalString(body?.name);
            if (!sourceUrl) {
              json(res, { error: 'Liitä soittolistan, albumin tai kappaleen linkki.' }, 400);
              return;
            }
            const startedAt = Date.now();
            console.log(`[playlist] import begin url=${sourceUrl}`);
            const imported = await resolveInput(sourceUrl);
            const name = preferredName || imported.name || imported.tracks[0]?.title || `Tuonti ${new Date().toISOString().slice(0, 10)}`;
            const created = await createPlaylist(name, actor);
            const result = await addSongsToPlaylist(created.id, imported.tracks, actor);
            console.log(
              `[playlist] import done id=${created.id} songs=${imported.tracks.length} skipped=${imported.skipped} `
              + `added=${result.added} duplicates=${result.skippedDuplicates} failed=${result.failed} `
              + `in ${Date.now() - startedAt}ms`
            );
            json(res, { ok: true, playlist: created, result: { ...result, failed: result.failed + imported.skipped } });
            return;
          }

          if (!baseId) {
            json(res, { error: 'Not found' }, 404);
            return;
          }

          if (parts.length === 3 && method === 'GET') {
            const songQuery = requestUrl.searchParams.get('songQuery') || '';
            const songCursor = requestUrl.searchParams.get('songCursor');
            const songLimit = asNumber(requestUrl.searchParams.get('songLimit'), 50, 1, 200);
            const detail = await getPlaylistDetail(baseId, songQuery, songCursor, songLimit);
            json(res, { ok: true, playlist: detail });
            return;
          }

          if (parts.length === 3 && method === 'PATCH') {
            const body = JSON.parse(await readBody(req));
            const name = toOptionalString(body?.name);
            if (!name) {
              json(res, { error: 'name required' }, 400);
              return;
            }
            const updated = await renamePlaylist(baseId, name, actor);
            console.log(`[playlist] rename id=${baseId} name="${updated.name}" actor="${actor}"`);
            json(res, { ok: true, playlist: updated });
            return;
          }

          if (parts.length === 3 && method === 'DELETE') {
            const deleted = await deletePlaylist(baseId);
            if (!deleted) {
              json(res, { error: 'Playlist not found' }, 404);
              return;
            }
            console.log(`[playlist] delete id=${baseId} actor="${actor}"`);
            json(res, { ok: true });
            return;
          }

          if (parts.length === 4 && parts[3] === 'from-queue' && method === 'POST') {
            const body = JSON.parse(await readBody(req));
            const guildAccess = resolveAuthorizedGuildId(
              toOptionalString(body?.guildId),
              session?.guildId ?? null,
              localMode,
              defaultGuildId
            );
            if (guildAccess.error) {
              json(res, { error: guildAccess.error }, guildAccess.status || 403);
              return;
            }
            const guildId = guildAccess.guildId;
            if (!guildId) {
              json(res, { error: 'guildId required' }, 400);
              return;
            }
            const includeCurrent = body?.includeCurrent !== false;
            const hasSelectedIndices = Array.isArray(body?.selectedIndices);
            const selectedIndices = parseIndexList(body?.selectedIndices);
            const selected = queueSelectionToTracks(
              guildId,
              includeCurrent,
              hasSelectedIndices ? selectedIndices : null
            );
            if (!selected.queueFound) {
              json(res, { error: 'No queue' }, 404);
              return;
            }
            if (selected.songs.length === 0) {
              json(res, { error: 'Queue selection is empty' }, 400);
              return;
            }
            const baseResult = await addSongsToPlaylist(baseId, selected.songs, actor);
            const result = mergeBulkResult(baseResult, { added: 0, skippedDuplicates: 0, failed: selected.skipped });
            console.log(
              `[playlist] from-queue existing id=${baseId} guild=${guildId} `
              + `added=${result.added} skipped=${result.skippedDuplicates} failed=${result.failed}`
            );
            json(res, { ok: true, result });
            return;
          }

          if (parts.length === 4 && parts[3] === 'play' && method === 'POST') {
            const body = JSON.parse(await readBody(req));
            const guildAccess = resolveAuthorizedGuildId(
              toOptionalString(body?.guildId),
              session?.guildId ?? null,
              localMode,
              defaultGuildId
            );
            if (guildAccess.error) {
              json(res, { error: guildAccess.error }, guildAccess.status || 403);
              return;
            }
            const guildId = guildAccess.guildId;
            if (!guildId) {
              json(res, { error: 'guildId required' }, 400);
              return;
            }
            const songs = await getAllPlaylistSongs(baseId);
            if (!songs.length) {
              json(res, { ok: true, noop: true, message: 'Soittolista on tyhjä.' });
              return;
            }
            const order = body?.shuffle ? shuffleArray(songs) : songs;
            const result = await enqueueFromWeb(client, guildId, { tracks: order }, actor, 'web_playlist');
            console.log(
              `[playlist] play id=${baseId} guild=${guildId} shuffle=${!!body?.shuffle} queued=${result.added} ok=${result.success}`
            );
            logUsage('playlist.play', {
              ...webUsageContext(req, session, localMode, trustProxy, guildId),
              playlistId: baseId,
              shuffle: !!body?.shuffle,
              requestedCount: order.length,
              queued: result.added,
              ok: result.success,
            });
            json(res, result.success ? { ok: true, queued: result.added } : { error: result.error });
            return;
          }

          if (parts.length === 4 && parts[3] === 'songs' && method === 'POST') {
            const body = JSON.parse(await readBody(req));
            const track = body?.track !== undefined ? parseClientTrack(body.track) : null;
            const input = toOptionalString(body?.input) || toOptionalString(body?.url);
            if (body?.track !== undefined && !track) {
              json(res, { error: 'Kappaleen tiedot olivat virheelliset.' }, 400);
              return;
            }
            if (!track && !input) {
              json(res, { error: 'Liitä linkki tai kirjoita hakusana.' }, 400);
              return;
            }
            const resolved = track ? { tracks: [track], skipped: 0 } : await resolveInput(input as string);
            const result = await addSongsToPlaylist(baseId, resolved.tracks, actor);
            console.log(
              `[playlist] song-add id=${baseId} added=${result.added} `
              + `duplicates=${result.skippedDuplicates} failed=${result.failed} skipped=${resolved.skipped}`
            );
            json(res, { ok: true, result: { ...result, failed: result.failed + resolved.skipped } });
            return;
          }

          if (parts.length === 5 && parts[3] === 'songs' && parts[4] === 'move' && method === 'POST') {
            const body = JSON.parse(await readBody(req));
            const fromIndex = asNumber(body?.fromIndex, -1, -1, 1_000_000);
            const toIndex = asNumber(body?.toIndex, -1, -1, 1_000_000);
            if (fromIndex < 0 || toIndex < 0) {
              json(res, { error: 'fromIndex and toIndex required' }, 400);
              return;
            }
            const moved = await movePlaylistSong(baseId, fromIndex, toIndex, actor);
            if (!moved) {
              json(res, { error: 'Invalid indices' }, 400);
              return;
            }
            json(res, { ok: true });
            return;
          }

          if (parts.length === 5 && parts[3] === 'songs' && method === 'DELETE') {
            const songId = decodeURIComponent(parts[4]);
            const removed = await removePlaylistSong(baseId, songId, actor);
            if (!removed) {
              json(res, { error: 'Song not found' }, 404);
              return;
            }
            json(res, { ok: true });
            return;
          }

          json(res, { error: 'Not found' }, 404);
          return;
        } catch (error) {
          if (error instanceof PlaylistConflictError) {
            json(res, { error: error.message }, 409);
            return;
          }
          if (error instanceof PlaylistNotFoundError) {
            json(res, { error: error.message }, 404);
            return;
          }
          if (error instanceof ResolveError) {
            json(res, { error: error.message }, 422);
            return;
          }
          console.error('[playlist] API error:', error);
          json(res, { error: 'Playlist operation failed' }, 500);
          return;
        }
      }

      if (pathname.startsWith('/api/voice-keywords')) {
        const actor = readActorName(session, localMode);
        const parts = pathname.split('/').filter(Boolean);
        try {
          if (parts.length === 2 && method === 'GET') {
            const query = requestUrl.searchParams.get('query') || '';
            const cursor = requestUrl.searchParams.get('cursor');
            const limit = asNumber(requestUrl.searchParams.get('limit'), 30, 1, 100);
            const result = await listVoiceKeywords(query, cursor, limit);
            json(res, { ok: true, items: result.items, nextCursor: result.nextCursor });
            return;
          }

          if (parts.length === 2 && method === 'PUT') {
            const body = JSON.parse(await readBody(req));
            const phrase = toOptionalString(body?.phrase);
            const url = toOptionalString(body?.url);
            if (!phrase) {
              json(res, { error: 'phrase required' }, 400);
              return;
            }
            if (!url) {
              json(res, { error: 'url required' }, 400);
              return;
            }
            const saved = await upsertVoiceKeyword(phrase, url, actor);
            console.log(`[voice-keyword] upsert phrase="${saved.phrase}" by="${actor}"`);
            json(res, { ok: true, item: saved });
            return;
          }

          if (parts.length === 3 && method === 'DELETE') {
            const phrase = decodeURIComponent(parts[2] || '');
            if (!phrase.trim()) {
              json(res, { error: 'phrase required' }, 400);
              return;
            }
            const removed = await deleteVoiceKeyword(phrase);
            if (!removed) {
              json(res, { error: 'Keyword not found' }, 404);
              return;
            }
            console.log(`[voice-keyword] delete phrase="${phrase}" by="${actor}"`);
            json(res, { ok: true });
            return;
          }
        } catch (error) {
          const message = (error as { message?: string } | null)?.message || 'Voice keyword operation failed';
          json(res, { error: message }, 400);
          return;
        }
        json(res, { error: 'Not found' }, 404);
        return;
      }

      if (pathname === '/api/auth/me' && method === 'GET') {
        if (localMode) {
          json(res, { email: null, name: 'Local Mode', isAdmin: false, localMode: true, guildId: defaultGuildId });
          return;
        }
        json(
          res,
          session
            ? { email: session.email, name: session.name, isAdmin: session.isAdmin, guildId: session.guildId }
            : { error: 'Not logged in' }
        );
        return;
      }

      if (pathname === '/api/state' && method === 'GET') {
        const guildAccess = resolveAuthorizedGuildId(
          toOptionalString(requestUrl.searchParams.get('guildId')),
          session?.guildId ?? null,
          localMode,
          defaultGuildId
        );
        if (guildAccess.error) {
          json(res, { error: guildAccess.error }, guildAccess.status || 403);
          return;
        }

        const state: any = {};
        const addGuildState = (guildId: string) => {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) {
            return false;
          }
          const queue = queues.get(guild.id);
          state[guild.id] = {
            guildName: guild.name,
            currentSong: queue?.getCurrentSong() ?? null,
            queue: queue?.getQueue() ?? [],
            paused: queue?.isPausedState() ?? false,
            volume: getVolume(guild.id),
            positionMs: getPlaybackPositionMs(guild.id),
          };
          return true;
        };

        if (guildAccess.guildId) {
          if (!addGuildState(guildAccess.guildId)) {
            json(res, { error: 'Guild not found' }, 404);
            return;
          }
        } else {
          client.guilds.cache.forEach(guild => {
            addGuildState(guild.id);
          });
        }

        const payload = JSON.stringify(state);
        const etag = makeEtag(payload);
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ETag: etag, 'Cache-Control': 'no-store' });
        res.end(payload);
        return;
      }

      if (method === 'POST' && pathname.startsWith('/api/')) {
        const body = JSON.parse(await readBody(req));
        if (pathname === '/api/voice-command') {
          const transcript = toOptionalString(body?.transcript);
          if (!transcript) {
            json(res, { error: 'transcript required' }, 400);
            return;
          }
          const guildAccess = resolveAuthorizedGuildId(
            toOptionalString(body?.guildId),
            session?.guildId ?? null,
            localMode,
            defaultGuildId
          );
          if (guildAccess.error) {
            json(res, { error: guildAccess.error }, guildAccess.status || 403);
            return;
          }
          const guildId = guildAccess.guildId;
          if (!guildId) {
            json(res, { error: 'guildId required' }, 400);
            return;
          }

          const requestedBy = session?.name || 'Web Voice Debug';
          console.log(`[voice-cmd] begin guild=${guildId} by="${requestedBy}" transcript="${transcript}"`);
          const startedAt = Date.now();
          let voiceKeywordMap = baseVoiceKeywordMap;
          try {
            const persistedMap = await loadVoiceKeywordMap();
            voiceKeywordMap = { ...baseVoiceKeywordMap, ...persistedMap };
          } catch (error) {
            console.error('[voice-cmd] failed to load persisted keywords, using base map:', error);
          }
          const result = await executeVoiceCommand(client, guildId, requestedBy, transcript, voiceKeywordMap);
          console.log(
            `[voice-cmd] done guild=${guildId} intent=${result.intent} ok=${result.ok} `
            + `status=${result.status} in ${Date.now() - startedAt}ms `
            + `${result.resolvedUrl ? `url=${result.resolvedUrl}` : ''}`
          );
          logUsage('voice.command', {
            ...webUsageContext(req, session, localMode, trustProxy, guildId),
            source: 'web_voice_debug',
            transcript,
            intent: result.intent,
            ok: result.ok,
            status: result.status,
            message: result.message,
            queuedTitle: result.queuedTitle,
            resolvedUrl: result.resolvedUrl,
            durationMs: Date.now() - startedAt,
          });
          if (!result.ok) {
            json(
              res,
              { error: result.error || result.message, message: result.message, intent: result.intent, transcript },
              result.status
            );
            return;
          }
          json(res, {
            ok: true,
            message: result.message,
            intent: result.intent,
            queuedTitle: result.queuedTitle,
            resolvedUrl: result.resolvedUrl,
            transcript,
          });
          return;
        }

        if (pathname === '/api/search') {
          const query = typeof body.query === 'string' ? body.query.trim() : '';
          const source = body.source === 'soundcloud' ? 'soundcloud' : 'youtube';
          const limit = asNumber(body.limit, 8, 1, 10);
          if (!query) {
            json(res, { error: 'Kirjoita hakusana.' }, 400);
            return;
          }
          const startedAt = Date.now();
          try {
            const results = await searchTracks(query, source, limit);
            logUsage('web.search', {
              ...webUsageContext(req, session, localMode, trustProxy),
              query, searchSource: source, ok: true, resultCount: results.length, durationMs: Date.now() - startedAt,
            });
            json(res, { ok: true, results });
          } catch (error) {
            console.error(`[search] failed source=${source} query="${query}"`, error);
            logUsage('web.search', {
              ...webUsageContext(req, session, localMode, trustProxy),
              query, searchSource: source, ok: false, error, durationMs: Date.now() - startedAt,
            });
            json(res, { error: 'Haku epäonnistui. Yritä hetken päästä uudelleen.' }, 502);
          }
          return;
        }

        const guildAccess = resolveAuthorizedGuildId(
          toOptionalString(body?.guildId),
          session?.guildId ?? null,
          localMode,
          defaultGuildId
        );
        if (guildAccess.error) {
          json(res, { error: guildAccess.error }, guildAccess.status || 403);
          return;
        }
        const guildId = guildAccess.guildId;
        if (!guildId) { json(res, { error: 'guildId required' }, 400); return; }
        const queue = queues.get(guildId);

        switch (pathname) {
          case '/api/play': {
            // Either a known track (search result) or free input: a link or search text.
            const track = body.track !== undefined ? parseClientTrack(body.track) : null;
            const input = toOptionalString(body.input) || toOptionalString(body.url);
            if (!track && !input) { json(res, { error: 'Liitä linkki tai kirjoita hakusana.' }, 400); return; }
            const requestedBy = session?.name || 'Local Web';
            const result = await enqueueFromWeb(
              client, guildId, track ? { tracks: [track] } : { input: input as string }, requestedBy, 'web'
            );
            logUsage('web.play', {
              ...webUsageContext(req, session, localMode, trustProxy, guildId),
              url: track?.url ?? input,
              ok: result.success,
              added: result.added,
              error: result.error,
            });
            json(res, result.success
              ? { ok: true, added: result.added, skipped: result.skipped, name: result.name, firstTitle: result.firstTitle }
              : { error: result.error }, result.success ? 200 : 422);
            return;
          }
          case '/api/skip':
            if (!queue) {
              logUsage('queue.skip', {
                ...webUsageContext(req, session, localMode, trustProxy, guildId),
                ok: false,
                reason: 'no_queue',
              });
              json(res, { error: 'No queue' }, 404);
              return;
            }
            const skippedSong = queue.getCurrentSong();
            queue.skip();
            logUsage('queue.skip', {
              ...webUsageContext(req, session, localMode, trustProxy, guildId),
              ok: true,
              skippedTitle: skippedSong?.title ?? null,
              skippedUrl: skippedSong?.url ?? null,
              ...queueUsageMetrics(queue),
            });
            json(res, { ok: true });
            return;
          case '/api/pause':
            if (!queue) {
              logUsage('queue.pause', {
                ...webUsageContext(req, session, localMode, trustProxy, guildId),
                ok: false,
                reason: 'no_queue',
              });
              json(res, { error: 'No queue' }, 404);
              return;
            }
            if (queue.isPausedState()) { queue.resume(); } else { queue.pause(); }
            logUsage(queue.isPausedState() ? 'queue.pause' : 'queue.resume', {
              ...webUsageContext(req, session, localMode, trustProxy, guildId),
              ok: true,
              ...queueUsageMetrics(queue),
            });
            json(res, { ok: true, paused: queue.isPausedState() });
            return;
          case '/api/remove':
            if (!queue) {
              logUsage('queue.remove', {
                ...webUsageContext(req, session, localMode, trustProxy, guildId),
                ok: false,
                reason: 'no_queue',
                index: body.index,
              });
              json(res, { error: 'No queue' }, 404);
              return;
            }
            const removedSong = queue.getQueue()[body.index];
            if (queue.removeSong(body.index)) {
              refreshNextSongPrefetch(client, guildId);
              logUsage('queue.remove', {
                ...webUsageContext(req, session, localMode, trustProxy, guildId),
                ok: true,
                index: body.index,
                removedTitle: removedSong?.title ?? null,
                removedUrl: removedSong?.url ?? null,
                ...queueUsageMetrics(queue),
              });
              json(res, { ok: true });
            } else {
              logUsage('queue.remove', {
                ...webUsageContext(req, session, localMode, trustProxy, guildId),
                ok: false,
                index: body.index,
                reason: 'invalid_index',
                ...queueUsageMetrics(queue),
              });
              json(res, { error: 'Invalid index' });
            }
            return;
          case '/api/move':
            if (!queue) {
              logUsage('queue.move', {
                ...webUsageContext(req, session, localMode, trustProxy, guildId),
                ok: false,
                reason: 'no_queue',
                from: body.from,
                to: body.to,
              });
              json(res, { error: 'No queue' }, 404);
              return;
            }
            if (queue.moveSong(body.from, body.to)) {
              refreshNextSongPrefetch(client, guildId);
              logUsage('queue.move', {
                ...webUsageContext(req, session, localMode, trustProxy, guildId),
                ok: true,
                from: body.from,
                to: body.to,
                ...queueUsageMetrics(queue),
              });
              json(res, { ok: true });
            } else {
              logUsage('queue.move', {
                ...webUsageContext(req, session, localMode, trustProxy, guildId),
                ok: false,
                from: body.from,
                to: body.to,
                reason: 'invalid_indices',
                ...queueUsageMetrics(queue),
              });
              json(res, { error: 'Invalid indices' });
            }
            return;
          case '/api/volume':
            setVolume(guildId, body.volume);
            logUsage('queue.volume', {
              ...webUsageContext(req, session, localMode, trustProxy, guildId),
              requestedVolume: body.volume,
              volume: getVolume(guildId),
            });
            json(res, { ok: true, volume: getVolume(guildId) });
            return;
        }
      }

      res.writeHead(404); res.end('Not found');
    } catch (err) {
      console.error('Web server error:', err);
      json(res, { error: 'Internal error' }, 500);
    }
  });

  server.listen(port, () => {
    console.log(`Web UI available at http://localhost:${port}`);
    console.log(`Web local mode: ${localMode ? 'enabled' : 'disabled'}`);
    console.log(`Web exposure mode: ${exposureMode}`);
    if (exposureMode === 'tunnel') {
      console.log(`Tunnel API rate limit: ${rateLimitPerMinute}/minute per client`);
      console.log(`Trust proxy headers: ${trustProxy ? 'enabled' : 'disabled'}`);
      if (requireAccessToken) {
        console.log(`Tunnel token protection: ${accessToken ? 'enabled' : 'MISCONFIGURED (token missing)'}`);
      }
      if (allowedOrigins.size > 0) {
        console.log(`Allowed origins: ${Array.from(allowedOrigins).join(', ')}`);
      } else {
        console.log('Allowed origins: not configured (non-browser requests only recommended)');
      }
    }
    console.log(`Session cookie secure flag: ${secureCookie ? 'enabled' : 'disabled'}`);
    console.log(`Voice keywords (base): ${Object.keys(baseVoiceKeywordMap).sort().join(', ') || '(none)'}`);
  });
}
