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
npm install
```

2. Create `.env` file:
```env
DISCORD_TOKEN=your_discord_bot_token_here
```

3. Start:
```bash
npm start
```

## Commands

| Command | Description | Permission |
|---------|-------------|------------|
| `!play <url>` | Play YouTube video | Everyone |
| `!pause` | Pause playback | Everyone |
| `!resume` | Resume playback | Everyone |
| `!skip` | Skip current song | Everyone |
| `!queue` | Show queue | Everyone |
| `!embed` | Show video embed | Everyone |
| `!cookies` | Manage YouTube cookies | Admin |
| `!reset` | Reset bot state | Admin |

## License

MIT 