#!/bin/bash
set -euo pipefail

echo "Setting up Discord voice commands for Eppu music bot (wake phrase: 'Hei Eppu')..."
echo "Everything runs locally on this machine: openWakeWord + faster-whisper."

echo "Installing system dependencies..."
sudo apt-get update
sudo apt-get install -y ffmpeg python3 python3-venv python3-pip

echo "Creating Python virtualenv for the voice worker..."
python3 -m venv .venv-voice
.venv-voice/bin/python -m pip install --upgrade pip wheel setuptools
.venv-voice/bin/python -m pip install --no-deps openwakeword==0.6.0
.venv-voice/bin/python -m pip install -r scripts/openwakeword-onnx-requirements.txt faster-whisper

echo "Downloading openWakeWord's shared feature models (one-time)..."
.venv-voice/bin/python -c 'from openwakeword.utils import AudioFeatures, download_models; download_models(); AudioFeatures(inference_framework="onnx")'

echo "Pre-downloading the whisper model (one-time, so runtime needs no internet)..."
WHISPER_MODEL="${VOICE_WHISPER_MODEL:-base}"
.venv-voice/bin/python - "$WHISPER_MODEL" << 'EOF'
import sys
from faster_whisper import WhisperModel
WhisperModel(sys.argv[1], device="cpu", compute_type="int8")
print(f"whisper model '{sys.argv[1]}' cached")
EOF

echo "Creating directories..."
mkdir -p temp logs models voice-samples

if [ ! -f .env ]; then
    echo "Creating .env file..."
    cat > .env << EOF
# Discord Bot Configuration
DISCORD_TOKEN=your_discord_bot_token_here

# Web/default playback context
VOICE_GUILD_ID=
DEFAULT_VOICE_CHANNEL_ID=

# Discord voice command configuration (all local, no external services)
VOICE_COMMANDS_ENABLED=false
WAKE_WORD="Hei Eppu"

# Wake engine: 'openwakeword' uses a trained model (train it in training/ on a
# bigger computer); 'transcript' transcribes everything locally and looks for
# the wake phrase in the text — works without a trained model, but is heavier.
# Leave unset to use openwakeword when a model path is configured.
#VOICE_WAKE_ENGINE=transcript
OPENWAKEWORD_MODEL_PATH=./models/hei-eppu.onnx
OPENWAKEWORD_THRESHOLD=0.55
# Optional second-stage verifier trained from real samples (training/train_verifier.py)
#OPENWAKEWORD_VERIFIER_PATH=./models/hei-eppu-verifier.pkl
#OPENWAKEWORD_VERIFIER_THRESHOLD=0.3

# Local speech-to-text (faster-whisper). Models: tiny/base/small — bigger is
# more accurate but slower on the Pi. Finnish: 'fi', English: 'en'.
VOICE_STT_ENGINE=local
VOICE_WHISPER_MODEL=base
VOICE_LANGUAGE=fi
VOICE_PYTHON=./.venv-voice/bin/python

VOICE_SEGMENT_SILENCE_MS=900
VOICE_MAX_SEGMENT_SECONDS=8
VOICE_COMMAND_COOLDOWN_MS=3000

# Database Configuration
FAVORITES_DB_PATH=./favorites.db

# Logging Configuration
LOG_LEVEL=info
VOICE_DEBUG=false
EOF
    echo "Please edit .env with your real tokens and IDs."
fi

echo "Installing Bun dependencies..."
bun install --omit peer

echo "Building the project..."
bun run build

echo "Setup complete."
echo ""
echo "Next steps:"
echo "1. Either train a 'Hei Eppu' model (see training/README.md) and set OPENWAKEWORD_MODEL_PATH,"
echo "   or set VOICE_WAKE_ENGINE=transcript to run without one."
echo "2. Set VOICE_COMMANDS_ENABLED=true."
echo "3. Ensure DEFAULT_VOICE_CHANNEL_ID points to the Discord voice channel Eppu should join."
echo "4. Restart the bot service."
