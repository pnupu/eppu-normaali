#!/usr/bin/env python3
"""Generates "Hei Eppu" positives with a real Finnish Piper voice (fi_FI-harri).

The main training data comes from the English LibriTTS-R generator using
phonetic spellings; this adds clips with genuine Finnish pronunciation on top.
The voice is single-speaker, so the count is kept modest (variety comes from
length/noise scales plus the augmentation stage) — the point is to anchor the
model to the real Finnish phonetics, not to dominate the training set.

Run inside training/.venv AFTER setup.sh and BEFORE train.sh. train.py counts
existing clips in the positive directories and only generates the remainder,
so these clips simply become part of the positive pool.
"""

import argparse
import sys
import uuid
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR / "work" / "piper-sample-generator"))

from piper_sample_generator.__main__ import generate_samples_onnx  # noqa: E402
DEFAULT_VOICE = BASE_DIR / "work" / "models" / "fi_FI-harri-medium.onnx"

TEXTS = ["Hei Eppu.", "Hei, Eppu.", "Hei Eppu"]


def resample_to_16k(paths: list) -> None:
    # Piper voices output their native rate (fi_FI-harri: 22050 Hz);
    # openWakeWord training expects 16 kHz clips.
    import wave

    import numpy as np
    from scipy.signal import resample_poly

    for path in paths:
        with wave.open(str(path), "rb") as wav_in:
            rate = wav_in.getframerate()
            if rate == 16000:
                continue
            data = np.frombuffer(wav_in.readframes(wav_in.getnframes()), dtype=np.int16)
        resampled = resample_poly(data.astype(np.float32), 16000, rate)
        resampled = np.clip(resampled, -32768, 32767).astype(np.int16)
        with wave.open(str(path), "wb") as wav_out:
            wav_out.setnchannels(1)
            wav_out.setsampwidth(2)
            wav_out.setframerate(16000)
            wav_out.writeframes(resampled.tobytes())


def generate(output_dir: Path, n: int, voice: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    texts = [TEXTS[i % len(TEXTS)] for i in range(n)]
    file_names = [f"fi_harri_{uuid.uuid4().hex}.wav" for _ in range(n)]
    generate_samples_onnx(
        text=texts,
        output_dir=str(output_dir),
        model=str(voice),
        max_samples=n,
        length_scales=(0.8, 0.9, 1.0, 1.1, 1.2),
        noise_scales=(0.333, 0.667, 1.0),
        noise_scale_ws=(0.6, 0.8, 1.0),
        file_names=file_names,
    )
    resample_to_16k([output_dir / name for name in file_names])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--n-train", type=int, default=1500)
    parser.add_argument("--n-test", type=int, default=150)
    parser.add_argument("--voice", default=str(DEFAULT_VOICE))
    parser.add_argument("--model-name", default="hei_eppu")
    args = parser.parse_args()

    clips_root = BASE_DIR / "work" / args.model_name
    print(f"==> Generating {args.n_train} Finnish train clips...")
    generate(clips_root / "positive_train", args.n_train, Path(args.voice))
    print(f"==> Generating {args.n_test} Finnish validation clips...")
    generate(clips_root / "positive_test", args.n_test, Path(args.voice))
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
