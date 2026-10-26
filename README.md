# Eppu Normaali

A Discord music bot with a web jukebox for playing YouTube, SoundCloud and Spotify links in voice channels.

## Features

- Play from YouTube, SoundCloud and Spotify: single tracks, playlists, albums, SoundCloud sets, or plain search text
- Spotify tracks play through their best YouTube Music match (Spotify audio is DRM-only). Spotify playlists are read
  from Spotify's public embed page without API keys, which lists at most 100 tracks.
- SoundCloud tracks marked DRM-protected (major-label SoundCloud Go content) cannot be played and are skipped
- Saved playlists that mix sources, import from any supported link, add songs from search or from the queue
- Web UI: now playing with progress and volume, search (YouTube or SoundCloud), queue reordering
- YouTube cookie support for age-restricted content
- Auto-disconnect from empty channels

## Requirements

- Node.js
- FFmpeg
- yt-dlp
- Discord Bot Token

## Setup

1. Install dependencies:
```bash
bun install
```

2. Create `.env` file:
```env
DISCORD_TOKEN=your_discord_bot_token_here
```

3. Start in development mode:
```bash
bun run dev
```

4. Build and run production output:
```bash
bun run build
bun run start
```

## Web UI Modes

The web controller can now run in local mode or in controlled tunnel mode.

### Key environment variables

```env
WEB_PORT=3000
WEB_LOCAL_MODE=false
WEB_EXPOSURE_MODE=local
WEB_REQUIRE_TOKEN=false
WEB_ACCESS_TOKEN=
WEB_RATE_LIMIT_PER_MIN=180
WEB_ALLOWED_ORIGINS=
WEB_BASE_URL=http://localhost:3000
WEB_COOKIE_SECURE=
WEB_LOGIN_TOKEN_TTL_MS=600000
WEB_AUTH_DB_PATH=./web-auth.db
PREFETCH_NEXT_SONG=true
REGISTER_SLASH_COMMANDS_ON_STARTUP=false
USAGE_LOG_ENABLED=true
USAGE_LOG_DIR=./logs
USAGE_LOG_TIME_ZONE=Europe/Helsinki
USAGE_LOG_RETENTION_DAYS=30
```

### Mode behavior

1. `WEB_LOCAL_MODE=true`
- Disables login requirement for normal control actions.

2. `WEB_EXPOSURE_MODE=tunnel`
- Enables per-client API rate limiting.
- Optional token protection with `WEB_REQUIRE_TOKEN=true` and `WEB_ACCESS_TOKEN=...`.
- Browser origins can be extended with `WEB_ALLOWED_ORIGINS` (comma-separated); the app's own `WEB_BASE_URL` origin is allowed automatically.
- Session cookies are marked `Secure` automatically when `WEB_BASE_URL` uses `https://`; override with `WEB_COOKIE_SECURE=true|false` only when needed.

3. `PREFETCH_NEXT_SONG=true`
- Downloads the next queued track in the background to reduce track-switch delay.
- Set to `false` if your Raspberry Pi is under heavy CPU/network load.

4. `REGISTER_SLASH_COMMANDS_ON_STARTUP=false`
- Keeps startup from rewriting Discord slash commands.
- Set to `true` only when the command definitions have changed and need to be pushed to Discord.

## yt-dlp

Playback depends on a current yt-dlp; YouTube changes break old versions (2026.03.17 got HTTP 403 on every stream
by October 2026). Point `YTDLP_BIN` at a copy the bot user can write to, so `yt-dlp -U` works without sudo,
and update it daily from cron.

## Tests

```bash
bun test src
```

## Logs and Usage

Production operational logs are in the systemd journal:

```bash
ssh <pi-host> 'journalctl -u eppu --since "2026-08-11 16:30:00" --until "2026-08-11 17:30:00" --no-pager -o short-iso'
```

The bot also writes structured usage logs as JSONL. By default they go to:

```text
logs/usage-YYYY-MM-DD.jsonl
```

Daily usage logs older than `USAGE_LOG_RETENTION_DAYS` (default 30) are removed on the first log write each day. Set it to `0` to keep all logs. A custom `USAGE_LOG_PATH` needs its own rotation policy.

Dates in the filename and `localDate` / `localTime` fields use `USAGE_LOG_TIME_ZONE` (`Europe/Helsinki` by default). To query a local Helsinki-time window:

```bash
jq 'select(.localDate == "2026-08-11" and .localTime >= "16:30:00" and .localTime <= "17:30:00")' logs/usage-2026-08-11.jsonl
```

Useful env overrides:

```env
USAGE_LOG_ENABLED=true
USAGE_LOG_DIR=./logs
USAGE_LOG_PATH=
USAGE_LOG_SERVICE=eppu
USAGE_LOG_TIME_ZONE=Europe/Helsinki
USAGE_LOG_RETENTION_DAYS=30
REGISTER_SLASH_COMMANDS_ON_STARTUP=false
```

When token protection is enabled, open the UI with:

`http://<host>:<port>/?token=<WEB_ACCESS_TOKEN>`

### Discord one-time web login

Use `/web-login` in your server.  
The bot sends a one-time DM login link. Session and login-link tokens are stored in SQLite and survive restarts.

Required env for link generation:

`WEB_BASE_URL=http://your-pi-hostname-or-ip:3000`

## Commands

| Command | Description | Permission |
|---------|-------------|------------|
| `/play url:<link or search text>` | Play a YouTube, SoundCloud or Spotify link (track, playlist, album, set) or search YouTube | Everyone |
| `/pause` | Pause playback | Everyone |
| `/resume` | Resume playback | Everyone |
| `/skip` | Skip current song | Everyone |
| `/queue` | Show queue | Everyone |
| `/help` | Show help | Everyone |
| `/web-login` | DM one-time web login link | Everyone |
| `/cleanup` | Force cleanup and disconnect from voice channels | Admin |
| `/nukkumaan` | Reset bot state and leave all voice channels | Admin |

## License

MIT 
