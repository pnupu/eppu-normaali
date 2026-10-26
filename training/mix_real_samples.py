#!/usr/bin/env python3
"""Mixes real Discord voice samples into the wake word training data.

Real samples recorded through the actual Discord -> Opus -> 16 kHz pipeline are
the most valuable training data because they match the deployment audio path
exactly. Collect them on the Pi with VOICE_SAMPLE_COLLECTION_ENABLED=true (see
VOICE_COMMANDS.md), copy the directories over, then run this before train.sh.

Positive clips are trimmed to the first N seconds (default 2.0) because the
recordings usually contain a full command ("Hei Eppu soita 22") but only the
beginning contains the wake phrase. Negative clips are copied as-is.

Run repeatedly is safe: files are prefixed "real_" and overwritten in place.
"""

import argparse
import hashlib
import shutil
import wave
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent


def trim_wav(source: Path, target: Path, max_seconds: float) -> None:
    with wave.open(str(source), "rb") as wav_in:
        params = wav_in.getparams()
        max_frames = int(max_seconds * params.framerate)
        frames = wav_in.readframes(min(params.nframes, max_frames))
    with wave.open(str(target), "wb") as wav_out:
        wav_out.setnchannels(params.nchannels)
        wav_out.setsampwidth(params.sampwidth)
        wav_out.setframerate(params.framerate)
        wav_out.writeframes(frames)


def distribute(files: list, train_dir: Path, test_dir: Path, test_fraction: float,
               max_seconds: float = 0.0) -> None:
    train_dir.mkdir(parents=True, exist_ok=True)
    test_dir.mkdir(parents=True, exist_ok=True)
    for source in files:
        # Stable across additions and reruns; remove the old copy if a previous
        # version of the script assigned this recording to the other split.
        bucket = int.from_bytes(hashlib.sha256(source.name.encode()).digest()[:8], "big") / 2**64
        target_dir = test_dir if bucket < test_fraction else train_dir
        other_dir = train_dir if target_dir == test_dir else test_dir
        (other_dir / f"real_{source.name}").unlink(missing_ok=True)
        target = target_dir / f"real_{source.name}"
        if max_seconds > 0:
            trim_wav(source, target, max_seconds)
        else:
            shutil.copyfile(source, target)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--positive-dir", help="Directory of real wake-phrase WAVs (16 kHz mono)")
    parser.add_argument("--negative-dir", help="Directory of real non-wake speech WAVs")
    parser.add_argument("--model-name", default="hei_eppu")
    parser.add_argument("--max-seconds", type=float, default=2.0,
                        help="Trim positives to this many seconds from the start (0 = no trim)")
    parser.add_argument("--test-fraction", type=float, default=0.1)
    args = parser.parse_args()
    if not 0 <= args.test_fraction < 1:
        parser.error("--test-fraction must be in [0, 1)")

    if not args.positive_dir and not args.negative_dir:
        parser.error("Provide --positive-dir and/or --negative-dir")

    clips_root = BASE_DIR / "work" / args.model_name

    if args.positive_dir:
        files = sorted(Path(args.positive_dir).glob("*.wav"))
        if not files:
            print(f"No .wav files in {args.positive_dir}")
        else:
            print(f"==> Adding {len(files)} real positive clips (trimmed to {args.max_seconds}s)...")
            distribute(files, clips_root / "positive_train", clips_root / "positive_test",
                       args.test_fraction, args.max_seconds)

    if args.negative_dir:
        files = sorted(Path(args.negative_dir).glob("*.wav"))
        if not files:
            print(f"No .wav files in {args.negative_dir}")
        else:
            print(f"==> Adding {len(files)} real negative clips...")
            distribute(files, clips_root / "negative_train", clips_root / "negative_test",
                       args.test_fraction)

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
