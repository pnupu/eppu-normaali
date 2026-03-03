import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Client } from 'discord.js';
import { queues, addSongFromWeb, getVolume, refreshNextSongPrefetch, searchYouTubeFromWeb, setVolume } from '../commands/play';
import { consumeDiscordLoginLink, getSessionFromCookie, logoutSessionFromCookie } from './auth';
import {
  addSongsToPlaylist,
  BulkAddResult,
  canonicalYouTubeUrl,
  createPlaylist,
  deletePlaylist,
  extractYouTubeVideoId,
  getAllPlaylistSongs,
  getPlaylistDetail,
  listPlaylists,
  movePlaylistSong,
  PlaylistConflictError,
  PlaylistNotFoundError,
  removePlaylistSong,
  renamePlaylist,
  resolveYouTubePlaylistSongs,
  resolveYouTubeSong,
} from './playlists';
import {
  deleteVoiceKeyword,
  listVoiceKeywords,
  loadVoiceKeywordMap,
  upsertVoiceKeyword,
} from './voiceKeywords';

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
const DEFAULT_VOICE_KEYWORDS: Record<string, string> = Object.freeze({
  '22': 'https://www.youtube.com/watch?v=zI7WGJFKfsE',
});

function envBool(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
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
  allowedOrigins: Set<string>
): boolean {
  const origin = getRequestOrigin(req);
  const hasOrigin = !!origin;
  const originAllowed = !origin
    || exposureMode === 'local'
    || allowedOrigins.has(origin);

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

function queueSelectionToPlaylistInputs(
  guildId: string,
  includeCurrent: boolean,
  selectedIndices: number[] | null
): { songs: Array<{ title: string; url: string; canonicalVideoId: string }>; skipped: number; queueFound: boolean } {
  const queue = queues.get(guildId);
  if (!queue) {
    return { songs: [], skipped: 0, queueFound: false };
  }

  const songs: Array<{ title: string; url: string; canonicalVideoId: string }> = [];
  let skipped = 0;

  const pushSong = (title: string, url: string) => {
    const canonicalId = extractYouTubeVideoId(url);
    if (!canonicalId) {
      skipped += 1;
      return;
    }
    songs.push({
      title: title.trim() || `YouTube ${canonicalId}`,
      url: canonicalYouTubeUrl(canonicalId),
      canonicalVideoId: canonicalId,
    });
  };

  const currentSong = queue.getCurrentSong();
  if (includeCurrent && currentSong) {
    pushSong(currentSong.title, currentSong.url);
  }

  const queuedSongs = queue.getQueue();
  if (selectedIndices !== null) {
    for (const index of selectedIndices) {
      if (index < 0 || index >= queuedSongs.length) {
        skipped += 1;
        continue;
      }
      const item = queuedSongs[index];
      pushSong(item.title, item.url);
    }
  } else {
    for (const item of queuedSongs) {
      pushSong(item.title, item.url);
    }
  }

  return { songs, skipped, queueFound: true };
}

function readActorName(session: { name?: string | null } | null, localMode: boolean): string {
  if (session?.name) return session.name;
  return localMode ? 'Paikallinen tila' : 'Web käyttäjä';
}

function mergeBulkResult(base: BulkAddResult, extra: BulkAddResult): BulkAddResult {
  return {
    added: base.added + extra.added,
    skippedDuplicates: base.skippedDuplicates + extra.skippedDuplicates,
    failed: base.failed + extra.failed,
  };
}

type VoiceCommandIntent = 'play' | 'skip' | 'pause' | 'resume' | 'unknown';

interface VoiceCommandParseResult {
  intent: VoiceCommandIntent;
  query: string;
}

interface VoiceCommandResult {
  ok: boolean;
  status: number;
  intent: VoiceCommandIntent;
  message: string;
  queuedTitle?: string;
  resolvedUrl?: string;
  error?: string;
}

function normalizeVoiceTranscript(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s:/?&=._-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseVoiceCommand(transcript: string): VoiceCommandParseResult {
  const normalized = normalizeVoiceTranscript(transcript);
  const wakeless = normalized.startsWith('eppu ') ? normalized.slice(5).trim() : normalized;

  if (/^(ohita|skip|seuraava)\b/.test(wakeless)) {
    return { intent: 'skip', query: '' };
  }
  if (/^(tauko|pause|pysayta|pysäytä)\b/.test(wakeless)) {
    return { intent: 'pause', query: '' };
  }
  if (/^(jatka|resume)\b/.test(wakeless)) {
    return { intent: 'resume', query: '' };
  }

  const playMatch = wakeless.match(/^soita\s+(.+)$/);
  if (playMatch) {
    return { intent: 'play', query: playMatch[1].trim() };
  }
  return { intent: 'unknown', query: wakeless };
}

async function executeVoiceCommand(
  client: Client,
  guildId: string,
  requestedBy: string,
  transcript: string,
  voiceKeywordMap: Record<string, string>
): Promise<VoiceCommandResult> {
  const parsed = parseVoiceCommand(transcript);
  const queue = queues.get(guildId);

  if (parsed.intent === 'skip') {
    if (!queue) {
      return { ok: false, status: 404, intent: parsed.intent, message: 'Jonossa ei ole ohitettavaa.', error: 'No queue' };
    }
    queue.skip();
    return { ok: true, status: 200, intent: parsed.intent, message: 'Ohitettiin nykyinen kappale.' };
  }

  if (parsed.intent === 'pause') {
    if (!queue) {
      return { ok: false, status: 404, intent: parsed.intent, message: 'Jonossa ei ole tauotettavaa.', error: 'No queue' };
    }
    queue.pause();
    return { ok: true, status: 200, intent: parsed.intent, message: 'Tauko päälle.' };
  }

  if (parsed.intent === 'resume') {
    if (!queue) {
      return { ok: false, status: 404, intent: parsed.intent, message: 'Jonossa ei ole jatkettavaa.', error: 'No queue' };
    }
    queue.resume();
    return { ok: true, status: 200, intent: parsed.intent, message: 'Toisto jatkuu.' };
  }

  if (parsed.intent !== 'play' || !parsed.query) {
    return {
      ok: false,
      status: 400,
      intent: parsed.intent,
      message: 'Komentoa ei tunnistettu. Sano esimerkiksi: "Eppu soita 22".',
      error: 'Unknown command',
    };
  }

  const queryKey = normalizeVoiceKeyword(parsed.query);
  const keywordUrl = voiceKeywordMap[queryKey];
  let resolvedUrl = keywordUrl;
  let resolvedTitle: string | undefined;

  if (!resolvedUrl) {
    const explicitId = extractYouTubeVideoId(parsed.query);
    if (explicitId) {
      resolvedUrl = canonicalYouTubeUrl(explicitId);
    }
  }

  if (!resolvedUrl) {
    const search = await searchYouTubeFromWeb(parsed.query, 1);
    if (!search.success || !search.results?.length) {
      return {
        ok: false,
        status: 404,
        intent: parsed.intent,
        message: `Hakua ei löytynyt komennolle: "${parsed.query}"`,
        error: search.error || 'No search results',
      };
    }
    resolvedUrl = search.results[0].url;
    resolvedTitle = search.results[0].title;
  }

  const added = await addSongFromWeb(client, guildId, resolvedUrl, requestedBy, resolvedTitle ? { resolvedTitle } : undefined);
  if (!added.success) {
    return {
      ok: false,
      status: 500,
      intent: parsed.intent,
      message: added.error || 'Kappaleen lisäys epäonnistui.',
      error: added.error || 'Failed to queue song',
      resolvedUrl,
    };
  }

  return {
    ok: true,
    status: 200,
    intent: parsed.intent,
    message: `Lisättiin jonoon: ${resolvedTitle || parsed.query}`,
    queuedTitle: resolvedTitle || parsed.query,
    resolvedUrl,
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
  const secureCookie = envBool(process.env.WEB_COOKIE_SECURE, exposureMode === 'tunnel');
  const trustProxy = envBool(process.env.WEB_TRUST_PROXY, false);
  const sessionCookieMaxAgeSeconds = Math.max(
    60,
    Math.floor((parseInt(process.env.WEB_SESSION_TTL_MS || '86400000', 10) || 86_400_000) / 1000)
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
    const originAllowed = applyCorsHeaders(req, res, exposureMode, allowedOrigins);
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
            const selected = queueSelectionToPlaylistInputs(
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

          if (parts.length === 3 && baseId === 'import-youtube' && method === 'POST') {
            const body = JSON.parse(await readBody(req));
            const sourceUrl = toOptionalString(body?.url);
            const preferredName = toOptionalString(body?.name);
            if (!sourceUrl) {
              json(res, { error: 'url required' }, 400);
              return;
            }
            const startedAt = Date.now();
            console.log(`[playlist] import begin url=${sourceUrl}`);
            const imported = await resolveYouTubePlaylistSongs(sourceUrl);
            if (imported.songs.length === 0) {
              json(res, { error: 'No songs found in YouTube playlist' }, 400);
              return;
            }
            const name = preferredName || imported.sourceTitle || `YouTube tuonti ${new Date().toISOString().slice(0, 10)}`;
            const created = await createPlaylist(name, actor);
            const result = await addSongsToPlaylist(created.id, imported.songs, actor);
            console.log(
              `[playlist] import done id=${created.id} songs=${imported.songs.length} `
              + `added=${result.added} skipped=${result.skippedDuplicates} failed=${result.failed} `
              + `in ${Date.now() - startedAt}ms`
            );
            json(res, { ok: true, playlist: created, sourceTitle: imported.sourceTitle, result });
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
            const selected = queueSelectionToPlaylistInputs(
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
              json(res, { ok: true, noop: true, message: 'Playlist is empty' });
              return;
            }
            const order = body?.shuffle ? shuffleArray(songs) : songs;
            let queued = 0;
            let failed = 0;
            let firstError = '';
            for (const song of order) {
              const result = await addSongFromWeb(client, guildId, song.url, actor, { resolvedTitle: song.title });
              if (result.success) {
                queued += 1;
              } else {
                failed += 1;
                if (!firstError && result.error) firstError = result.error;
              }
            }
            console.log(
              `[playlist] play id=${baseId} guild=${guildId} shuffle=${!!body?.shuffle} `
              + `queued=${queued} failed=${failed}`
            );
            json(res, { ok: queued > 0, queued, failed, error: queued > 0 ? undefined : (firstError || 'Failed to queue playlist') });
            return;
          }

          if (parts.length === 4 && parts[3] === 'songs' && method === 'POST') {
            const body = JSON.parse(await readBody(req));
            const url = toOptionalString(body?.url);
            if (!url) {
              json(res, { error: 'url required' }, 400);
              return;
            }
            const resolved = await resolveYouTubeSong(url);
            const result = await addSongsToPlaylist(baseId, [resolved], actor);
            console.log(
              `[playlist] song-add id=${baseId} added=${result.added} `
              + `skipped=${result.skippedDuplicates} failed=${result.failed}`
            );
            json(res, { ok: true, result, song: resolved });
            return;
          }

          if (parts.length === 5 && parts[3] === 'songs' && parts[4] === 'bulk' && method === 'POST') {
            const body = JSON.parse(await readBody(req));
            const urls = Array.isArray(body?.urls)
              ? body.urls.map((value: unknown) => String(value).trim()).filter((value: string) => value.length > 0)
              : [];
            if (!urls.length) {
              json(res, { error: 'urls required' }, 400);
              return;
            }
            const startedAt = Date.now();
            let failedResolve = 0;
            const resolvedSongs: Array<{ title: string; url: string; canonicalVideoId: string }> = [];
            for (const url of urls) {
              try {
                const song = await resolveYouTubeSong(url);
                resolvedSongs.push(song);
              } catch {
                failedResolve += 1;
              }
            }
            const addResult = await addSongsToPlaylist(baseId, resolvedSongs, actor);
            const result = mergeBulkResult(addResult, { added: 0, skippedDuplicates: 0, failed: failedResolve });
            console.log(
              `[playlist] song-bulk id=${baseId} requested=${urls.length} resolved=${resolvedSongs.length} `
              + `added=${result.added} skipped=${result.skippedDuplicates} failed=${result.failed} `
              + `in ${Date.now() - startedAt}ms`
            );
            json(res, { ok: true, result });
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
            volume: getVolume(guild.id)
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
          const query = typeof body.query === 'string' ? body.query : '';
          const limit = Number.isFinite(body.limit) ? body.limit : 6;
          if (!query.trim()) {
            json(res, { error: 'query required' }, 400);
            return;
          }
          const result = await searchYouTubeFromWeb(query, limit);
          json(res, result.success ? { ok: true, results: result.results } : { error: result.error });
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
            if (!body.url) { json(res, { error: 'url required' }, 400); return; }
            const requestedBy = session?.name || 'Local Web';
            const result = await addSongFromWeb(client, guildId, body.url, requestedBy);
            json(res, result.success ? { ok: true } : { error: result.error });
            return;
          }
          case '/api/skip':
            if (!queue) { json(res, { error: 'No queue' }, 404); return; }
            queue.skip();
            json(res, { ok: true });
            return;
          case '/api/pause':
            if (!queue) { json(res, { error: 'No queue' }, 404); return; }
            if (queue.isPausedState()) { queue.resume(); } else { queue.pause(); }
            json(res, { ok: true, paused: queue.isPausedState() });
            return;
          case '/api/remove':
            if (!queue) { json(res, { error: 'No queue' }, 404); return; }
            if (queue.removeSong(body.index)) {
              refreshNextSongPrefetch(client, guildId);
              json(res, { ok: true });
            } else {
              json(res, { error: 'Invalid index' });
            }
            return;
          case '/api/move':
            if (!queue) { json(res, { error: 'No queue' }, 404); return; }
            if (queue.moveSong(body.from, body.to)) {
              refreshNextSongPrefetch(client, guildId);
              json(res, { ok: true });
            } else {
              json(res, { error: 'Invalid indices' });
            }
            return;
          case '/api/volume':
            setVolume(guildId, body.volume);
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
