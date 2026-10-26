# Training the "Hei Eppu" wake word model

Everything here runs locally on a bigger computer (tested target: Apple Silicon
Mac; any Linux box works too and uses CUDA automatically). The output is a
small (~200 KB) `hei-eppu.onnx` model that runs on the Raspberry Pi inside the
bot's voice worker. No cloud services are involved.

## How it works

openWakeWord trains a tiny classifier on top of frozen audio-embedding models.
The positive training data is synthetic speech, from three sources:

1. **LibriTTS-R generator** — thousands of English voices saying phonetic
   spellings of the wake phrase ("hey eppu", "hey eppoo", ...). This provides
   speaker variety.
2. **Finnish Piper voice (fi_FI-harri)** — genuine Finnish pronunciation
   (`generate_finnish_clips.py`). This anchors the phonetics.
3. **Real Discord recordings** — clips recorded through the actual
   Discord → Opus → 16 kHz pipeline on the Pi (`mix_real_samples.py`). These
   match deployment audio exactly and matter the most; collect as many as you
   can (see "Collecting real samples" in ../VOICE_COMMANDS.md).

Negatives come from auto-generated phoneme-overlap adversarial phrases, 2000
hours of pre-computed generic speech/noise features (ACAV100M), and optionally
your own real negative recordings. Clips are augmented with room reverb (MIT
RIRs) and background noise/music (AudioSet, FMA) before training.

## Prerequisites

Use Python 3.10–3.13. Setup selects an installed compatible interpreter; set
`PYTHON` to override it. The audio stack is constrained to matching Torch and
TorchAudio 2.8 because the augmentation library requires `torchaudio.info`.
Both setups use openWakeWord 0.6.0 with its ONNX dependencies; training pins
the matching source commit. TFLite is omitted so newer Linux Python versions
do not require an unavailable TFLite wheel.
Both setup scripts download openWakeWord's shared feature models once, before
training or wake detection can run offline.

## Steps

```bash
cd training
./setup.sh                          # venv + repos + TTS models (~1 GB)
.venv/bin/python download_data.py --all          # ~6 GB training data
.venv/bin/python generate_finnish_clips.py       # Finnish-voice positives
.venv/bin/python mix_real_samples.py \
    --positive-dir ../voice-samples/positive \
    --negative-dir ../voice-samples/negative    # real Discord clips (rsync from Pi first)
./train.sh                          # generate + augment + train
```

`train.sh` produces `../models/hei-eppu.onnx`. Stages 2–3 use `train_onnx.py`
to size feature arrays for every augmentation round, skip upstream's TFLite conversion and use a single-process data loader on
macOS (the upstream dataset contains functions that spawn workers cannot pickle).
Training errors still fail the script. Expect the full first run to
take a few hours on CPU/MPS (clip generation dominates; clip generation resumes if
interrupted; augmentation is rebuilt on every run so added recordings are included).

Deploy:

```bash
scp models/hei-eppu.onnx pi:/path/to/eppu-normaali/models/hei-eppu.onnx
# on the Pi: set OPENWAKEWORD_MODEL_PATH in .env, restart the bot
```

## If accuracy isn't good enough

In rough order of effectiveness:

1. **Collect more real positive samples** on the Pi and retrain
   (`mix_real_samples.py` + `./train.sh` — only augmentation/training rerun).
2. **Train a custom verifier** from real clips — big precision boost for the
   voices that actually use the bot:

   ```bash
   .venv/bin/python train_verifier.py \
       --positive-dir ../voice-samples/positive \
       --negative-dir ../voice-samples/negative
   scp models/hei-eppu-verifier.pkl pi:/path/to/eppu-normaali/models/
   # on the Pi: OPENWAKEWORD_VERIFIER_PATH=models/hei-eppu-verifier.pkl
   ```

3. **Tune the threshold** on the Pi (`OPENWAKEWORD_THRESHOLD`, default 0.55):
   set `VOICE_DEBUG=true`, watch the wake-miss scores in the logs, and pick a
   threshold just below what real "Hei Eppu" utterances score.
4. **Raise `n_samples`** in `hei-eppu.yml` (e.g. 50000) and add problematic
   trigger phrases to `custom_negative_phrases`, then retrain.

Until a good model exists, the bot can run with `VOICE_WAKE_ENGINE=transcript`,
which needs no wake model at all (it transcribes every speech segment locally
and looks for "Hei Eppu" in the text — heavier on the Pi but fully functional).

## Disk layout

Everything heavy lives under `training/work/` (gitignored): cloned repos,
downloaded datasets, generated clips, features. Delete `work/hei_eppu/` to
regenerate clips from scratch; delete specific dataset dirs to re-download.
