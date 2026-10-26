#!/usr/bin/env python3
"""Downloads the data openWakeWord training needs (run inside training/.venv).

  --rirs      MIT room impulse responses (~100 MB), for reverb augmentation
  --noise     AudioSet clips (~3 GB), mixed in as background noise (includes music)
  --features  Pre-computed negative features, ACAV100M 2000h (~17 GB) + validation set
  --all       Everything above

Completed downloads are skipped. Interrupted corpora are retried before they
are marked complete; one existing WAV does not count as a completed corpus.
"""

import argparse
import os
from pathlib import Path

WORK_DIR = Path(__file__).resolve().parent / "work"


def download_rirs() -> None:
    import datasets
    import numpy as np
    import scipy.io.wavfile
    from tqdm import tqdm

    rir_dir = WORK_DIR / "mit_rirs"
    # Keep markers outside the WAV directories: upstream treats every file
    # inside those directories as an audio input during augmentation.
    complete = WORK_DIR / ".mit_rirs.complete"
    if complete.is_file() and complete.read_text() == "complete\n" and rir_dir.is_dir() and any(rir_dir.glob("*.wav")):
        print(f"==> {rir_dir} already populated, skipping RIRs")
        return
    complete.unlink(missing_ok=True)
    rir_dir.mkdir(parents=True, exist_ok=True)
    print("==> Downloading MIT environmental impulse responses...")
    dataset = datasets.load_dataset(
        "davidscripka/MIT_environmental_impulse_responses", split="train", streaming=True
    )
    for row in tqdm(dataset):
        name = row["audio"]["path"].split("/")[-1]
        scipy.io.wavfile.write(
            rir_dir / name, 16000, (np.asarray(row["audio"]["array"]) * 32767).astype(np.int16)
        )
    if not any(rir_dir.glob("*.wav")):
        raise RuntimeError("MIT RIR dataset contained no audio")
    complete.write_text("complete\n")


def download_noise() -> None:
    import datasets
    import numpy as np
    import scipy.io.wavfile
    from tqdm import tqdm

    # AudioSet: ~2400 streamed balanced-train clips give a good variety of
    # real-world noise (the dataset is parquet-only nowadays, so stream it)
    audioset_out = WORK_DIR / "audioset_16k"
    n_audioset_clips = 2400
    complete = WORK_DIR / ".audioset_16k.complete"
    if (complete.is_file() and complete.read_text() == "complete\n"
            and len(list(audioset_out.glob("*.wav"))) >= n_audioset_clips):
        print(f"==> {audioset_out} already populated, skipping AudioSet")
    else:
        complete.unlink(missing_ok=True)
        audioset_out.mkdir(parents=True, exist_ok=True)
        print(f"==> Streaming {n_audioset_clips} AudioSet clips...")
        dataset = datasets.load_dataset(
            "agkphysics/AudioSet", "balanced", split="train", streaming=True
        )
        dataset = iter(dataset.cast_column("audio", datasets.Audio(sampling_rate=16000)))
        for index in tqdm(range(n_audioset_clips)):
            row = next(dataset)
            name = Path(row["audio"]["path"]).stem + ".wav" if row["audio"].get("path") else f"audioset_{index}.wav"
            scipy.io.wavfile.write(
                audioset_out / name, 16000, (np.asarray(row["audio"]["array"]) * 32767).astype(np.int16)
            )
        complete.write_text("complete\n")


def download_features() -> None:
    from huggingface_hub import hf_hub_download

    for filename in (
        "openwakeword_features_ACAV100M_2000_hrs_16bit.npy",
        "validation_set_features.npy",
    ):
        target = WORK_DIR / filename
        if target.exists():
            print(f"==> {target} already exists, skipping")
            continue
        print(f"==> Downloading {filename}...")
        hf_hub_download(
            repo_id="davidscripka/openwakeword_features",
            filename=filename,
            repo_type="dataset",
            local_dir=WORK_DIR,
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rirs", action="store_true")
    parser.add_argument("--noise", action="store_true")
    parser.add_argument("--features", action="store_true")
    parser.add_argument("--all", action="store_true")
    args = parser.parse_args()

    if not (args.rirs or args.noise or args.features or args.all):
        parser.error("Nothing selected; pass --all or a combination of --rirs/--noise/--features")

    os.makedirs(WORK_DIR, exist_ok=True)
    if args.all or args.rirs:
        download_rirs()
    if args.all or args.noise:
        download_noise()
    if args.all or args.features:
        download_features()
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
