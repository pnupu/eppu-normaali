import http from 'http';
import fs from 'fs';
import path from 'path';
import { Client } from 'discord.js';
import { queues, addSongFromWeb, getVolume, setVolume } from '../commands/play';
import { getSessionFromCookie, verifyGoogleToken, tryLogin, inviteUser } from './auth';

const HTML_PATH = path.join(__dirname, '../../src/web/index.html');

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function startWebServer(client: Client) {
  const port = parseInt(process.env.WEB_PORT || '3000', 10);

  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    const method = req.method || 'GET';

    // CORS / content type
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
      // Serve HTML
      if (method === 'GET' && (url === '/' || url === '/index.html')) {
        const html = fs.readFileSync(HTML_PATH, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }

      // Public auth endpoints
      if (url === '/api/auth/client-id' && method === 'GET') {
        json(res, { clientId: process.env.GOOGLE_CLIENT_ID || null });
        return;
      }

      if (url === '/api/auth/verify' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const user = await verifyGoogleToken(body.idToken);
        if (!user) { json(res, { error: 'Invalid token' }, 401); return; }
        const result = tryLogin(user.email, user.name);
        if (!result) { json(res, { error: 'Not authorized. Ask an admin to invite you.' }, 403); return; }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `session=${result.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
        });
        res.end(JSON.stringify({ ok: true, isAdmin: result.isAdmin }));
        return;
      }

      // All other API routes require auth
      const session = getSessionFromCookie(req.headers.cookie);
      if (!session && url?.startsWith('/api/')) {
        json(res, { error: 'Unauthorized' }, 401);
        return;
      }

      if (url === '/api/auth/me' && method === 'GET') {
        json(res, session ? { email: session.email, name: session.name, isAdmin: session.isAdmin } : { error: 'Not logged in' });
        return;
      }

      if (url === '/api/auth/invite' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const ok = inviteUser(session!.email, body.email);
        json(res, ok ? { ok: true } : { error: 'Not admin or user already exists' });
        return;
      }

      if (url === '/api/state' && method === 'GET') {
        const state: any = {};
        client.guilds.cache.forEach(guild => {
          const queue = queues.get(guild.id);
          if (queue) {
            state[guild.id] = {
              guildName: guild.name,
              currentSong: queue.getCurrentSong(),
              queue: queue.getQueue(),
              paused: queue.isPausedState(),
              volume: getVolume(guild.id)
            };
          }
        });
        json(res, state);
        return;
      }

      if (method === 'POST' && url?.startsWith('/api/')) {
        const body = JSON.parse(await readBody(req));
        const guildId = body.guildId;

        if (!guildId) { json(res, { error: 'guildId required' }, 400); return; }
        const queue = queues.get(guildId);

        switch (url) {
          case '/api/play': {
            if (!body.url) { json(res, { error: 'url required' }, 400); return; }
            const result = await addSongFromWeb(guildId, body.url, session!.name);
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
            json(res, queue.removeSong(body.index) ? { ok: true } : { error: 'Invalid index' });
            return;
          case '/api/move':
            if (!queue) { json(res, { error: 'No queue' }, 404); return; }
            json(res, queue.moveSong(body.from, body.to) ? { ok: true } : { error: 'Invalid indices' });
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
  });
}
