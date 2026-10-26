"""Compatibility shim so openWakeWord's train.py can use piper-sample-generator v3.

train.py does `sys.path.insert(0, config["piper_sample_generator_path"])` and then
`from generate_samples import generate_samples`, expecting the v2-era repo layout.
v2 depends on piper-phonemize, which has no macOS/Apple Silicon wheels. The pip
package (v3+) keeps the same generate_samples() signature, runs on Apple Silicon
(MPS), and phonemizes through piper 1.3 — this module just bridges the import and
fills in the generator model path, which v2 defaulted but v3 requires.

Point `piper_sample_generator_path` in the training YAML at this directory and set
PIPER_GENERATOR_MODEL to the LibriTTS-R generator .pt file.
"""

import itertools
import os
import sys
import uuid

_REPO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "work", "piper-sample-generator")
if _REPO_DIR not in sys.path:
    sys.path.insert(0, _REPO_DIR)

from piper_sample_generator.__main__ import generate_samples as _generate_samples

_DEFAULT_MODEL = os.environ.get(
    "PIPER_GENERATOR_MODEL",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "work", "models", "en_US-libritts_r-medium.pt"),
)


def _resample_dir_to_16k(output_dir):
    """v2 resampled generated clips to 16 kHz; v3 writes the model's native
    rate (22050 Hz), but openWakeWord's pipeline expects 16 kHz throughout.
    Idempotent: clips already at 16 kHz are skipped via a cheap header read."""
    import glob
    import wave

    import numpy as np
    from scipy.signal import resample_poly

    for path in glob.glob(os.path.join(output_dir, "*.wav")):
        with wave.open(path, "rb") as wav_in:
            rate = wav_in.getframerate()
            if rate == 16000:
                continue
            data = np.frombuffer(wav_in.readframes(wav_in.getnframes()), dtype=np.int16)
        resampled = resample_poly(data.astype(np.float32), 16000, rate)
        resampled = np.clip(resampled, -32768, 32767).astype(np.int16)
        with wave.open(path, "wb") as wav_out:
            wav_out.setnchannels(1)
            wav_out.setsampwidth(2)
            wav_out.setframerate(16000)
            wav_out.writeframes(resampled.tobytes())


def generate_samples(*args, **kwargs):
    if len(args) < 3:
        kwargs.setdefault("model", _DEFAULT_MODEL)
    file_names = args[4] if len(args) > 4 else kwargs.get("file_names")
    if file_names is None:
        # Piper otherwise restarts at 0.wav, overwriting existing validation
        # clips when openWakeWord asks for only the missing sample count.
        names = (f"{uuid.uuid4().hex}.wav" for _ in itertools.count())
        if len(args) > 4:
            args = (*args[:4], names, *args[5:])
        else:
            kwargs["file_names"] = names
    result = _generate_samples(*args, **kwargs)
    output_dir = kwargs.get("output_dir") or (args[1] if len(args) > 1 else None)
    if output_dir:
        _resample_dir_to_16k(str(output_dir))
    return result
