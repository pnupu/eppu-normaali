#!/usr/bin/env python3
"""
Ingest a long Discord recording and split into 2s training chunks.

Usage:
  python ingest-discord-recording.py /path/to/recording.(wav|mp3|m4a|opus) \
    --positives 10.3-11.9,45.0-47.2 \
    --chunk 2.0 \
    --sr 16000

By default, all chunks are saved to wake-word/not-wake-word/.
Provide --positives with comma-separated start-end seconds to save those
chunks to wake-word/wake-word/ instead (labelled as "Hei Eppu").
"""

import argparse
import os
from pathlib import Path
from typing import List, Tuple

import numpy as np

try:
    import librosa
    import soundfile as sf
except Exception as e:
    raise SystemExit("Missing dependencies. Activate venv and run: pip install -r requirements.txt")


def parse_ranges(ranges: str) -> List[Tuple[float, float]]:
    if not ranges:
        return []
    result: List[Tuple[float, float]] = []
    for part in ranges.split(','):
        part = part.strip()
        if not part:
            continue
        try:
            start_s, end_s = part.split('-')
            start = float(start_s)
            end = float(end_s)
            if end <= start:
                raise ValueError
            result.append((start, end))
        except Exception:
            raise SystemExit(f"Invalid range '{part}'. Use start-end in seconds, e.g., 12.3-14.0")
    return result


def is_in_any_range(t0: float, t1: float, ranges: List[Tuple[float, float]]) -> bool:
    for (rs, re) in ranges:
        # Mark positive if chunk overlaps any positive range by at least 0.3s
        overlap = max(0.0, min(t1, re) - max(t0, rs))
        if overlap >= 0.3:
            return True
    return False


def main():
    parser = argparse.ArgumentParser(description="Ingest Discord recording for wake word training")
    parser.add_argument('input', help='Path to Discord recording (wav/mp3/m4a/opus)')
    parser.add_argument('--sr', type=int, default=16000, help='Target sample rate (default 16000)')
    parser.add_argument('--chunk', type=float, default=2.0, help='Chunk length in seconds (default 2.0)')
    parser.add_argument('--hop', type=float, default=None, help='Hop length seconds (default = chunk; no overlap)')
    parser.add_argument('--positives', type=str, default='', help='Comma-separated start-end seconds for positive ranges, e.g., 10.2-11.8,45-47.2')
    parser.add_argument('--prefix', type=str, default='discord', help='Filename prefix for saved chunks')

    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        raise SystemExit(f"Input file not found: {input_path}")

    # Prepare directories
    wake_dir = Path('wake-word/wake-word')
    neg_dir = Path('wake-word/not-wake-word')
    wake_dir.mkdir(parents=True, exist_ok=True)
    neg_dir.mkdir(parents=True, exist_ok=True)

    # Load and resample audio to mono @ args.sr
    audio, sr = librosa.load(str(input_path), sr=args.sr, mono=True)
    duration = len(audio) / sr

    chunk_s = max(0.5, float(args.chunk))
    hop_s = float(args.hop) if args.hop is not None else chunk_s

    pos_ranges = parse_ranges(args.positives)

    idx = 0
    n_saved_wake = 0
    n_saved_neg = 0

    t = 0.0
    while t + 0.1 < duration:
        t0 = t
        t1 = min(t + chunk_s, duration)
        s0 = int(round(t0 * sr))
        s1 = int(round(t1 * sr))

        chunk = audio[s0:s1]

        # Basic energy gate to skip near-silence chunks
        rms = float(np.sqrt(np.mean(np.square(chunk)))) if len(chunk) > 0 else 0.0
        if rms < 1e-3:  # tune if needed
            t += hop_s
            idx += 1
            continue

        is_positive = is_in_any_range(t0, t1, pos_ranges)

        # Normalize to avoid clipping differences
        peak = np.max(np.abs(chunk)) if len(chunk) > 0 else 1.0
        if peak > 0:
            chunk = chunk / peak * 0.9

        timestamp_tag = f"{t0:.2f}-{t1:.2f}".replace('.', '_')
        if is_positive:
            out_name = f"{args.prefix}_hei_eppu_{idx:05d}_{timestamp_tag}.wav"
            out_path = wake_dir / out_name
            n_saved_wake += 1
        else:
            out_name = f"{args.prefix}_neg_{idx:05d}_{timestamp_tag}.wav"
            out_path = neg_dir / out_name
            n_saved_neg += 1

        sf.write(str(out_path), chunk, sr, subtype='PCM_16')

        t += hop_s
        idx += 1

    print(f"Done. Saved {n_saved_wake} positive and {n_saved_neg} negative chunks.")
    print(f"Positives dir: {wake_dir}")
    print(f"Negatives dir: {neg_dir}")
    if not pos_ranges:
        print("Tip: pass --positives start-end to mark where 'Hei Eppu' occurs in the recording.")


if __name__ == '__main__':
    main()


