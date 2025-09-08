# Finnish Voice Commands for Eppu Music Bot

This document describes the Finnish voice command system for the Eppu Discord music bot.

## Features

- **Wake Word Detection**: Say "Eppu" to activate voice commands
- **Finnish Language Support**: All commands in Finnish
- **Local Processing**: Wake word detection runs locally on Raspberry Pi
- **GPT-Realtime Integration**: Advanced speech recognition and command parsing
- **Favorites System**: Save and play favorite songs
- **Search Functionality**: Search for songs by name or artist
- **Voice Feedback**: Bot responds with Finnish voice messages

## Setup

### Prerequisites

1. **Raspberry Pi** with audio input/output
2. **Discord Bot Token**
3. **OpenAI API Key** (for GPT-realtime)
4. **Picovoice Access Key** (for wake word detection)

### Installation

1. Run the setup script:
```bash
chmod +x setup-voice-commands.sh
./setup-voice-commands.sh
```

2. Edit `.env` file with your API keys:
```env
DISCORD_TOKEN=your_discord_bot_token
OPENAI_API_KEY=your_openai_api_key
PICOVOICE_ACCESS_KEY=your_picovoice_access_key
```

3. Test audio setup:
```bash
# Test microphone
arecord -f S16_LE -r 16000 -c 1 -D plughw:1,0 test.wav

# Test speakers
aplay test.wav
```

4. Start the bot:
```bash
npm start
```

## Voice Commands

### Basic Music Controls

| Finnish Command | English | Action |
|----------------|---------|--------|
| "Eppu, toista [kappale]" | "Eppu, play [song]" | Play a song |
| "Eppu, tauko" | "Eppu, pause" | Pause music |
| "Eppu, jatka" | "Eppu, resume" | Resume music |
| "Eppu, seuraava" | "Eppu, next" | Skip to next song |
| "Eppu, lopeta" | "Eppu, stop" | Stop music |
| "Eppu, jono" | "Eppu, queue" | Show music queue |

### Favorites System

| Finnish Command | English | Action |
|----------------|---------|--------|
| "Eppu, lisää suosikkeihin" | "Eppu, add to favorites" | Add current song to favorites |
| "Eppu, toista suosikit" | "Eppu, play favorites" | Play favorites playlist |
| "Eppu, näytä suosikit" | "Eppu, show favorites" | Show favorites list |

### Search Commands

| Finnish Command | English | Action |
|----------------|---------|--------|
| "Eppu, etsi [kappale]" | "Eppu, search [song]" | Search and play song |
| "Eppu, hae [artisti]" | "Eppu, find [artist]" | Search by artist |

### Volume Control

| Finnish Command | English | Action |
|----------------|---------|--------|
| "Eppu, äänenvoimakkuus ylös" | "Eppu, volume up" | Increase volume |
| "Eppu, äänenvoimakkuus alas" | "Eppu, volume down" | Decrease volume |

### Help

| Finnish Command | English | Action |
|----------------|---------|--------|
| "Eppu, apua" | "Eppu, help" | Show help message |

## Technical Details

### Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Wake Word     │───▶│  GPT-Realtime    │───▶│  Command Parser │
│  (Porcupine)    │    │  (Finnish STT)   │    │  (Finnish NLP)  │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                        │                        │
         ▼                        ▼                        ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  Local Audio    │    │  OpenAI API      │    │  Music Bot      │
│  Processing     │    │  Integration     │    │  Commands       │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

### Components

1. **WakeWordDetector**: Local wake word detection using Porcupine
2. **GPTRealtimeHandler**: OpenAI integration for speech recognition
3. **FinnishCommandParser**: Natural language processing for Finnish
4. **VoiceFeedback**: Text-to-speech responses in Finnish
5. **FavoritesManager**: SQLite database for user favorites
6. **MusicSearch**: YouTube search integration

### Audio Configuration

The system uses ALSA for audio capture on Raspberry Pi:

```bash
# Audio device configuration
AUDIO_DEVICE=plughw:1,0  # Adjust for your Pi's audio setup

# Audio format
Sample Rate: 16kHz
Channels: Mono
Format: 16-bit signed little endian
```

### Performance Optimization

- **Local Wake Word**: Reduces latency and API costs
- **Audio Buffering**: Efficient memory usage
- **Command Caching**: Reduces repeated API calls
- **Raspberry Pi Optimized**: Lightweight dependencies

## Troubleshooting

### Common Issues

1. **No Audio Input**
   - Check microphone permissions: `sudo usermod -a -G audio $USER`
   - Test audio device: `arecord -l`
   - Adjust AUDIO_DEVICE in .env

2. **Wake Word Not Detected**
   - Check Picovoice API key
   - Ensure microphone is working
   - Adjust wake word sensitivity

3. **Commands Not Understood**
   - Check OpenAI API key
   - Ensure clear pronunciation
   - Check internet connection

4. **High CPU Usage**
   - Reduce audio quality settings
   - Disable voice feedback temporarily
   - Check for background processes

### Debug Mode

Enable debug logging in `.env`:
```env
VOICE_DEBUG=true
LOG_LEVEL=debug
```

### Audio Testing

```bash
# Test microphone
arecord -f S16_LE -r 16000 -c 1 -D plughw:1,0 -d 5 test.wav

# Test speakers
aplay test.wav

# Test espeak-ng
espeak-ng -v fi "Hei, tämä on testi"
```

## API Keys Required

1. **Discord Bot Token**: Create at https://discord.com/developers/applications
2. **OpenAI API Key**: Get at https://platform.openai.com/api-keys
3. **Picovoice Access Key**: Get at https://console.picovoice.ai/

## License

This voice command system is part of the Eppu music bot project.
