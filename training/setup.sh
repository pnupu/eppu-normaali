#!/bin/bash
# Sets up the "Hei Eppu" wake word training environment on the big computer
# (tested target: Apple Silicon Mac; also works on Linux, where CUDA is used
# automatically if available).
set -euo pipefail
cd "$(dirname "$0")"

# The compatible TorchAudio stack supports Python 3.10–3.13.
if [ -z "${PYTHON:-}" ]; then
    for candidate in python3.11 python3.12 python3.13 python3.10 python3; do
        if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(not ((3, 10) <= sys.version_info[:2] <= (3, 13)))'; then
            PYTHON=$candidate
            break
        fi
    done
fi
if [ -z "${PYTHON:-}" ]; then
    echo "Install Python 3.10–3.13, then run PYTHON=python3.11 ./setup.sh" >&2
    exit 1
fi
"$PYTHON" -c 'import sys; sys.exit("Training requires Python 3.10–3.13" if not ((3, 10) <= sys.version_info[:2] <= (3, 13)) else 0)'

# On Apple Silicon, universal2 Python builds try to compile C extensions for
# x86_64 too, which breaks some packages (e.g. numpy-minmax) — build arm64 only.
if [ "$(uname -sm)" = "Darwin arm64" ]; then
    export ARCHFLAGS="-arch arm64"
fi

echo "==> Creating training virtualenv (.venv)..."
if [ ! -d .venv ]; then
    "$PYTHON" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -c audio-constraints.txt --upgrade pip wheel setuptools

echo "==> Installing PyTorch + audio stack..."
pip install -c audio-constraints.txt torch torchaudio

echo "==> Cloning piper-sample-generator (v3, Apple Silicon capable)..."
# Used as a checkout via sys.path (training/shim handles the import): its
# wheels are broken (the pyproject omits the piper_train package), and the pip
# pins (piper-tts==1.3.0) predate macOS arm64 wheels.
mkdir -p work
if [ ! -d work/piper-sample-generator ]; then
    git clone https://github.com/rhasspy/piper-sample-generator work/piper-sample-generator
fi
git -C work/piper-sample-generator checkout -q 2971426a55072f7d22fec416ca7800df8bd23207
pip install -c audio-constraints.txt "piper-tts>=1.3" webrtcvad audiomentations numpy

echo "==> Cloning and installing openWakeWord..."
mkdir -p work/models
if [ ! -d work/openwakeword ]; then
    git clone https://github.com/dscripka/openWakeWord work/openwakeword
fi
# Match the verified runtime release; do not follow mutable upstream main.
git -C work/openwakeword checkout -q c8ef6912c5feccf1037b852d9bc6c7ed644135ba
pip install -c audio-constraints.txt --no-deps -e work/openwakeword
pip install -c audio-constraints.txt -r ../scripts/openwakeword-onnx-requirements.txt

echo "==> Downloading openWakeWord shared feature models..."
python -c 'from openwakeword.utils import AudioFeatures, download_models; download_models(); AudioFeatures(inference_framework="onnx")'

echo "==> Installing training dependencies..."
pip install -c audio-constraints.txt mutagen torchinfo torchmetrics speechbrain audiomentations torch-audiomentations \
    acoustics pronouncing deep-phonemizer "datasets<3" soundfile librosa \
    onnxruntime onnx pyyaml tqdm scipy requests huggingface_hub

echo "==> Downloading TTS models..."
if [ ! -f work/models/en_US-libritts_r-medium.pt ]; then
    curl -L -o work/models/en_US-libritts_r-medium.pt \
        "https://github.com/rhasspy/piper-sample-generator/releases/download/v2.0.0/en_US-libritts_r-medium.pt"
fi
# The generator needs its config json next to the .pt; it ships in the repo
cp work/piper-sample-generator/models/en_US-libritts_r-medium.pt.json work/models/
if [ ! -f work/models/fi_FI-harri-medium.onnx ]; then
    curl -L -o work/models/fi_FI-harri-medium.onnx \
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/fi/fi_FI/harri/medium/fi_FI-harri-medium.onnx"
    curl -L -o work/models/fi_FI-harri-medium.onnx.json \
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/fi/fi_FI/harri/medium/fi_FI-harri-medium.onnx.json"
fi

echo ""
echo "Setup complete. Next steps:"
echo "  1. .venv/bin/python download_data.py --all     # ~6 GB of noise/RIR/negative data"
echo "  2. .venv/bin/python generate_finnish_clips.py  # Finnish-voice positives (optional, recommended)"
echo "  3. .venv/bin/python mix_real_samples.py --positive-dir ../voice-samples/positive  # real Discord clips"
echo "  4. ./train.sh                                  # generate + augment + train -> models/hei-eppu.onnx"
