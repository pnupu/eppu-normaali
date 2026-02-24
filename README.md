# Eppu Normaali

A simple Discord bot for playing YouTube videos in voice channels.

## Features

- Play YouTube videos in voice channels
- Basic music controls (pause, resume, skip)
- Queue system
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
WEB_LOGIN_TOKEN_TTL_MS=600000
WEB_AUTH_DB_PATH=./web-auth.db
PREFETCH_NEXT_SONG=true
```

### Mode behavior

1. `WEB_LOCAL_MODE=true`
- Disables login requirement for normal control actions.

2. `WEB_EXPOSURE_MODE=tunnel`
- Enables per-client API rate limiting.
- Optional token protection with `WEB_REQUIRE_TOKEN=true` and `WEB_ACCESS_TOKEN=...`.
- Browser origins can be restricted with `WEB_ALLOWED_ORIGINS` (comma-separated).

3. `PREFETCH_NEXT_SONG=true`
- Downloads the next queued track in the background to reduce track-switch delay.
- Set to `false` if your Raspberry Pi is under heavy CPU/network load.

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
| `/play url:<youtube_url>` | Play YouTube video or playlist | Everyone |
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
