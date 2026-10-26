#!/bin/bash
# Trains the "Hei Eppu" openWakeWord model: synthetic clip generation,
# augmentation, then training. Each stage is resumable — clips that already
# exist (including Finnish-voice clips and real Discord samples added
# beforehand) are counted and only the remainder is generated.
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC1091
source .venv/bin/activate

CONFIG=${1:-hei-eppu.yml}
MODEL_NAME=$(grep '^model_name:' "$CONFIG" | sed 's/.*"\(.*\)".*/\1/')
export PIPER_GENERATOR_MODEL="$PWD/work/models/en_US-libritts_r-medium.pt"
TRAIN_PY=work/openwakeword/openwakeword/train.py

echo "==> Stage 1/3: generating synthetic clips (skips anything already present)..."
python "$TRAIN_PY" --training_config "$CONFIG" --generate_clips

echo "==> Stage 2/3: augmenting clips (reverb + background noise)..."
python train_onnx.py --training_config "$CONFIG" --augment_clips --overwrite

echo "==> Stage 3/3: training model..."
python train_onnx.py --training_config "$CONFIG" --train_model

mkdir -p ../models
cp "work/${MODEL_NAME}.onnx" "../models/hei-eppu.onnx"
echo ""
echo "Trained model copied to models/hei-eppu.onnx"
echo "Deploy to the Pi with e.g.:"
echo "  scp models/hei-eppu.onnx pi:/path/to/eppu-normaali/models/hei-eppu.onnx"
echo "Then on the Pi set OPENWAKEWORD_MODEL_PATH and restart the bot."
