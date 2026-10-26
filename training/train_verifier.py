#!/usr/bin/env python3
"""Trains an openWakeWord custom verifier from real Discord recordings.

A verifier is a small second-stage classifier on top of the trained wake model
that dramatically cuts false activations for known speakers. It needs only a
handful of real clips: at least ~3 positives per speaker and ~10 seconds of
negative speech. Use the same sample-collection WAVs as mix_real_samples.py.

The resulting .pkl is used on the Pi via:
  OPENWAKEWORD_VERIFIER_PATH=models/hei-eppu-verifier.pkl
  OPENWAKEWORD_VERIFIER_THRESHOLD=0.3
"""

import argparse
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--positive-dir", required=True, help="Real wake-phrase WAVs (16 kHz mono)")
    parser.add_argument("--negative-dir", required=True, help="Real non-wake speech WAVs")
    parser.add_argument("--model", default=str(BASE_DIR / ".." / "models" / "hei-eppu.onnx"),
                        help="Trained wake model the verifier sits on top of")
    parser.add_argument("--output", default=str(BASE_DIR / ".." / "models" / "hei-eppu-verifier.pkl"))
    args = parser.parse_args()

    positives = sorted(str(p) for p in Path(args.positive_dir).glob("*.wav"))
    negatives = sorted(str(p) for p in Path(args.negative_dir).glob("*.wav"))
    if len(positives) < 3:
        parser.error(f"Need at least 3 positive clips, found {len(positives)}")
    if not negatives:
        parser.error("Need at least one negative clip")

    import openwakeword

    print(f"==> Training verifier on {len(positives)} positive / {len(negatives)} negative clips...")
    openwakeword.train_custom_verifier(
        positive_reference_clips=positives,
        negative_reference_clips=negatives,
        output_path=args.output,
        model_name=args.model,
        inference_framework="onnx" if Path(args.model).suffix.lower() == ".onnx" else "tflite",
    )
    print(f"Verifier saved to {args.output}")
    print("Copy it to the Pi and set OPENWAKEWORD_VERIFIER_PATH / OPENWAKEWORD_VERIFIER_THRESHOLD.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
