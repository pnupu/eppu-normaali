import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Client } from 'discord.js';
import { queues, addSongFromWeb, getVolume, refreshNextSongPrefetch, searchYouTubeFromWeb, setVolume } from '../commands/play';
import { consumeDiscordLoginLink, getSessionFromCookie } from './auth';

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

function getRequestOrigin(req: http.IncomingMessage): string | null {
  const origin = req.headers.origin;
  return typeof origin === 'string' ? origin : null;
}

function getClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
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

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Eppu-Token');
  return originAllowed;
}

function isRateLimited(
  req: http.IncomingMessage,
  rateLimits: Map<string, RateLimitEntry>,
  limitPerMinute: number
): boolean {
  const ip = getClientIp(req);
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
  const requireAccessToken = envBool(process.env.WEB_REQUIRE_TOKEN, false);
  const accessToken = process.env.WEB_ACCESS_TOKEN?.trim() || '';
  const rateLimitPerMinute = Math.max(10, Number.parseInt(process.env.WEB_RATE_LIMIT_PER_MIN || '180', 10) || 180);
  const allowedOrigins = parseAllowedOrigins(process.env.WEB_ALLOWED_ORIGINS);

  const staticAssets = new Map<string, StaticAsset>([
    ['/', loadStaticAsset(HTML_PATH, 'text/html; charset=utf-8')],
    ['/index.html', loadStaticAsset(HTML_PATH, 'text/html; charset=utf-8')],
    ['/styles.css', loadStaticAsset(CSS_PATH, 'text/css; charset=utf-8')],
    ['/app.js', loadStaticAsset(APP_JS_PATH, 'application/javascript; charset=utf-8')],
  ]);

  const rateLimits = new Map<string, RateLimitEntry>();

  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url || '/';
    const pathname = new URL(rawUrl, 'http://localhost').pathname;
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
        if (isRateLimited(req, rateLimits, rateLimitPerMinute)) {
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
          defaultGuildId: process.env.WEB_DEFAULT_GUILD_ID?.trim() || process.env.DISCORD_GUILD_ID || null,
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
          'Set-Cookie': `session=${result.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
        });
        res.end(JSON.stringify({ ok: true, isAdmin: result.isAdmin, source: 'discord-link' }));
        return;
      }

      // All other API routes require auth unless local mode is enabled.
      const session = await getSessionFromCookie(req.headers.cookie);
      if (!localMode && !session && pathname.startsWith('/api/')) {
        json(res, { error: 'Unauthorized' }, 401);
        return;
      }

      if (pathname === '/api/auth/me' && method === 'GET') {
        if (localMode) {
          json(res, { email: null, name: 'Local Mode', isAdmin: false, localMode: true });
          return;
        }
        json(res, session ? { email: session.email, name: session.name, isAdmin: session.isAdmin } : { error: 'Not logged in' });
        return;
      }

      if (pathname === '/api/state' && method === 'GET') {
        const state: any = {};
        client.guilds.cache.forEach(guild => {
          const queue = queues.get(guild.id);
          state[guild.id] = {
            guildName: guild.name,
            currentSong: queue?.getCurrentSong() ?? null,
            queue: queue?.getQueue() ?? [],
            paused: queue?.isPausedState() ?? false,
            volume: getVolume(guild.id)
          };
        });

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

        const guildId = body.guildId;
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
      if (requireAccessToken) {
        console.log(`Tunnel token protection: ${accessToken ? 'enabled' : 'MISCONFIGURED (token missing)'}`);
      }
      if (allowedOrigins.size > 0) {
        console.log(`Allowed origins: ${Array.from(allowedOrigins).join(', ')}`);
      } else {
        console.log('Allowed origins: not configured (non-browser requests only recommended)');
      }
    }
  });
}
