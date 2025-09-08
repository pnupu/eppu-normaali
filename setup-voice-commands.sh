#!/bin/bash

# Setup script for Finnish voice commands on Raspberry Pi

echo "Setting up Finnish voice commands for Eppu music bot..."

# Install system dependencies
echo "Installing system dependencies..."
sudo apt-get update
sudo apt-get install -y espeak-ng alsa-utils sox ffmpeg

# No additional Python dependencies needed
# GPT-realtime handles all speech recognition

# Create necessary directories
echo "Creating directories..."
mkdir -p temp
mkdir -p logs

# Set up audio permissions
echo "Setting up audio permissions..."
sudo usermod -a -G audio $USER

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo "Creating .env file..."
    cat > .env << EOF
# Discord Bot Configuration
DISCORD_TOKEN=your_discord_bot_token_here

# OpenAI Configuration (for GPT-realtime and TTS)
OPENAI_API_KEY=your_openai_api_key_here

# Picovoice Configuration (for wake word detection)
PICOVOICE_ACCESS_KEY=your_picovoice_access_key_here

# Audio Device Configuration (adjust for your Raspberry Pi)
AUDIO_DEVICE=plughw:1,0

# Voice Command Configuration
WAKE_WORD=Eppu
VOICE_TIMEOUT=5000
MAX_VOICE_DURATION=10000

# Database Configuration
FAVORITES_DB_PATH=./favorites.db

# Logging Configuration
LOG_LEVEL=info
VOICE_DEBUG=false
EOF
    echo "Please edit .env file with your API keys"
fi

# Install Node.js dependencies
echo "Installing Node.js dependencies..."
npm install

# Build the project
echo "Building the project..."
npm run build

echo "Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env file with your API keys"
echo "2. Test audio input: arecord -f S16_LE -r 16000 -c 1 -D plughw:1,0 test.wav"
echo "3. Test audio output: aplay test.wav"
echo "4. Run the bot: npm start"
echo ""
echo "Voice commands:"
echo "- Say 'Eppu' followed by a command"
echo "- Example: 'Eppu, toista Metallica'"
echo "- Example: 'Eppu, tauko'"
echo "- Example: 'Eppu, jono'"
