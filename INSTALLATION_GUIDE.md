# Eppu Music Bot - Finnish Voice Commands Installation Guide

## Overview

This guide will help you set up Finnish voice commands for your Eppu Discord music bot on a Raspberry Pi.

## Prerequisites

- Raspberry Pi (3B+ or newer recommended)
- Microphone and speakers connected to the Pi
- Discord bot token
- OpenAI API key
- Picovoice access key

## Step 1: System Setup

### Install System Dependencies

```bash
# Update system
sudo apt-get update && sudo apt-get upgrade -y

# Install audio tools
sudo apt-get install -y espeak-ng alsa-utils sox ffmpeg

# Install Python for whisper (optional fallback)
sudo apt-get install -y python3-pip
pip3 install openai-whisper

# Add user to audio group
sudo usermod -a -G audio $USER
```

### Test Audio Setup

```bash
# Test microphone
arecord -f S16_LE -r 16000 -c 1 -D plughw:1,0 -d 5 test.wav

# Test speakers
aplay test.wav

# Test Finnish TTS
espeak-ng -v fi "Hei, tämä on testi"
```

## Step 2: API Keys Setup

### 1. Discord Bot Token
1. Go to https://discord.com/developers/applications
2. Create a new application
3. Go to "Bot" section
4. Create a bot and copy the token

### 2. OpenAI API Key
1. Go to https://platform.openai.com/api-keys
2. Create a new API key
3. Copy the key

### 3. Picovoice Access Key
1. Go to https://console.picovoice.ai/
2. Sign up for a free account
3. Get your access key

## Step 3: Bot Installation

### 1. Clone and Setup

```bash
# Navigate to your project directory
cd /path/to/eppunormaali

# Run the setup script
chmod +x setup-voice-commands.sh
./setup-voice-commands.sh
```

### 2. Configure Environment

Edit the `.env` file with your API keys:

```env
# Discord Bot Configuration
DISCORD_TOKEN=your_discord_bot_token_here

# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key_here

# Picovoice Configuration
PICOVOICE_ACCESS_KEY=your_picovoice_access_key_here

# Audio Device Configuration (adjust for your Pi)
AUDIO_DEVICE=plughw:1,0

# Voice Command Configuration
WAKE_WORD="Hei Eppu"
VOICE_TIMEOUT=5000
MAX_VOICE_DURATION=10000
```

### 3. Install Dependencies

```bash
bun install
```

### 4. Build the Project

```bash
bun run build
```

## Step 4: Audio Device Configuration

### Find Your Audio Device

```bash
# List audio devices
arecord -l
aplay -l

# Test different devices
arecord -f S16_LE -r 16000 -c 1 -D plughw:0,0 -d 5 test1.wav
arecord -f S16_LE -r 16000 -c 1 -D plughw:1,0 -d 5 test2.wav
```

### Update .env File

Based on your audio device, update the `AUDIO_DEVICE` setting:

```env
# For USB microphone/speakers
AUDIO_DEVICE=plughw:1,0

# For built-in audio
AUDIO_DEVICE=plughw:0,0
```

## Step 5: Testing

### 1. Start the Bot

```bash
bun run dev
```

### 2. Test Voice Commands

1. Join a Discord voice channel
2. Say "Eppu" to activate voice commands
3. Try these commands:
   - "Eppu, toista Metallica"
   - "Eppu, tauko"
   - "Eppu, jono"
   - "Eppu, apua"

### 3. Debug Mode

If commands aren't working, enable debug mode:

```env
VOICE_DEBUG=true
LOG_LEVEL=debug
```

## Step 6: Troubleshooting

### Common Issues

#### No Audio Input
```bash
# Check audio permissions
groups $USER

# Test microphone
arecord -l
arecord -f S16_LE -r 16000 -c 1 -D plughw:1,0 -d 5 test.wav

# Check if audio device is busy
lsof /dev/snd/*
```

#### Wake Word Not Detected
- Check Picovoice API key
- Ensure microphone is working
- Try adjusting wake word sensitivity in code

#### Commands Not Understood
- Check OpenAI API key
- Ensure clear pronunciation
- Check internet connection
- Try the fallback whisper transcription

#### High CPU Usage
- Reduce audio quality settings
- Disable voice feedback temporarily
- Check for background processes

### Performance Optimization

#### For Raspberry Pi 3B+
```env
# Reduce audio quality
AUDIO_DEVICE=plughw:1,0
VOICE_TIMEOUT=3000
MAX_VOICE_DURATION=5000

# Disable some features
VOICE_DEBUG=false
```

#### For Raspberry Pi 4+
```env
# Full quality settings
AUDIO_DEVICE=plughw:1,0
VOICE_TIMEOUT=5000
MAX_VOICE_DURATION=10000
VOICE_DEBUG=true
```

## Step 7: Usage

### Voice Commands

| Finnish Command | Action |
|----------------|--------|
| "Eppu, toista [kappale]" | Play a song |
| "Eppu, tauko" | Pause music |
| "Eppu, jatka" | Resume music |
| "Eppu, seuraava" | Skip song |
| "Eppu, jono" | Show queue |
| "Eppu, lisää suosikkeihin" | Add to favorites |
| "Eppu, toista suosikit" | Play favorites |
| "Eppu, etsi [kappale]" | Search songs |
| "Eppu, apua" | Show help |

### Discord Slash Commands

Use slash commands in your server:
- `/play url:<youtube_url>` - Play YouTube video/playlist
- `/pause` - Pause music
- `/resume` - Resume music
- `/skip` - Skip song
- `/queue` - Show queue
- `/help` - Show help
- `/web-login` - Get a one-time web login link via DM
- `/cleanup` - Force cleanup/disconnect (Admin)
- `/nukkumaan` - Reset bot and leave all voice channels (Admin)

## Step 8: Maintenance

### Regular Updates

```bash
# Update dependencies
bun update

# Rebuild project
bun run build
```

### Log Monitoring

```bash
# Check logs
tail -f eppu-out.log
tail -f eppu-error.log
```

### Database Backup

```bash
# Backup favorites database
cp favorites.db favorites_backup_$(date +%Y%m%d).db
```

## Support

If you encounter issues:

1. Check the logs in `eppu-out.log` and `eppu-error.log`
2. Verify all API keys are correct
3. Test audio input/output manually
4. Check internet connection
5. Review the troubleshooting section above

## Features

- ✅ Wake word detection ("Eppu")
- ✅ Finnish voice commands
- ✅ Local processing (privacy-friendly)
- ✅ GPT-realtime integration
- ✅ Favorites system
- ✅ Search functionality
- ✅ Voice feedback in Finnish
- ✅ Raspberry Pi optimized
- ✅ Discord integration
- ✅ Fallback transcription

Enjoy your Finnish voice-controlled music bot! 🎵
