# Discord Voice Commands

Eppu listens to Discord voice-channel audio only. The Raspberry Pi does not need a microphone, and **everything runs locally** — wake word detection (openWakeWord) and speech recognition (faster-whisper) both run on the Pi with no external services.

## Flow

```text
Discord voice channel
  -> @discordjs/voice receiver
  -> Opus decode
  -> 16 kHz mono WAV segment
  -> persistent local voice worker (scripts/voice_worker.py)
       wake engine 'openwakeword': score segment with local "Hei Eppu" model,
                                   transcribe locally only after a wake hit
       wake engine 'transcript':   transcribe every segment locally, accept if
                                   the text starts with "Hei Eppu"
  -> Eppu command executor
```

The bot must be connected to the voice channel and must join with `selfDeaf: false`, otherwise Discord does not send incoming audio to the receiver.
When `VOICE_COMMANDS_ENABLED` or `VOICE_SAMPLE_COLLECTION_ENABLED` is true, Eppu auto-joins `DEFAULT_VOICE_CHANNEL_ID` at startup for listening.

## Environment

```env
VOICE_COMMANDS_ENABLED=true
VOICE_PYTHON=/path/to/eppu-normaali/.venv-voice/bin/python

# Wake word — 'openwakeword' (trained model, light on CPU) or 'transcript'
# (no model needed; transcribes everything locally, heavier). Defaults to
# openwakeword when a model path is set, transcript otherwise.
#VOICE_WAKE_ENGINE=openwakeword
OPENWAKEWORD_MODEL_PATH=/path/to/eppu-normaali/models/hei-eppu.onnx
OPENWAKEWORD_THRESHOLD=0.55
# Optional precision booster trained from real clips (training/train_verifier.py):
#OPENWAKEWORD_VERIFIER_PATH=/path/to/eppu-normaali/models/hei-eppu-verifier.pkl
#OPENWAKEWORD_VERIFIER_THRESHOLD=0.3

# Local transcription (faster-whisper, multilingual — handles Finnish).
VOICE_STT_ENGINE=local        # 'openai' still works as a legacy fallback
VOICE_WHISPER_MODEL=base      # tiny = fastest, small = most accurate on a Pi
VOICE_LANGUAGE=fi

VOICE_SEGMENT_SILENCE_MS=900
VOICE_MAX_SEGMENT_SECONDS=8
VOICE_COMMAND_COOLDOWN_MS=3000

VOICE_GUILD_ID=your_guild_id
DEFAULT_VOICE_CHANNEL_ID=your_voice_channel_id
```

`OPENWAKEWORD_MODEL_PATH` must point to a trained openWakeWord model for the phrase `Hei Eppu`. Train it locally on a bigger computer with the pipeline in `training/` (see `training/README.md`). Until a model is trained, set `VOICE_WAKE_ENGINE=transcript` to run fully local voice commands without one.

Setup installs openWakeWord 0.6.0 with ONNX dependencies only, avoiding the
TFLite wheel limitation on newer Raspberry Pi Python versions. Use an `.onnx`
wake model with this setup.

## Setup On Pi

```bash
cd /path/to/eppu-normaali
./setup-voice-commands.sh     # installs openwakeword + faster-whisper, caches the whisper model
sudo systemctl restart eppu
journalctl -u eppu -f
```

## Commands

Wake phrase: `Hei Eppu`

Commands work in Finnish or English. Spoken Finnish numbers are converted to digits ("soita kaksikymmentäkaksi" → keyword `22`), and saved keywords match fuzzily, so small transcription errors still resolve.

| Spoken command | Action |
| --- | --- |
| `Hei Eppu soita 22` | Queue the saved keyword `22` |
| `Hei Eppu soita kaksikymmentäkaksi` | Same — number words become digits |
| `Hei Eppu ohita` | Skip current song |
| `Hei Eppu tauko` | Pause playback |
| `Hei Eppu jatka` | Resume playback |
| `Hei Eppu soita Eppu Normaali` | Search YouTube and queue a result |
| `Hei Eppu play Metallica` | Search YouTube and queue a result |
| `Hei Eppu skip` / `pause` / `resume` | English equivalents |

Keywords (presets) are managed on the bot's website: the Voice keywords section saves a phrase → YouTube URL mapping that voice commands resolve before falling back to search.

## Tuning

- Raise `OPENWAKEWORD_THRESHOLD` if Eppu wakes too often; lower it if `Hei Eppu` is missed.
- Train and enable a verifier (`OPENWAKEWORD_VERIFIER_PATH`) if false activations persist — it locks detection to known voices.
- `VOICE_WHISPER_MODEL=tiny` if transcription is too slow on the Pi; `small` if Finnish accuracy is poor (slower).
- Increase `VOICE_SEGMENT_SILENCE_MS` if commands get cut off before transcription.
- Increase `VOICE_MAX_SEGMENT_SECONDS` if longer song requests are truncated.
- Set `VOICE_DEBUG=true` to log wake misses, scores, and voice worker stderr.

## Collecting Training Samples

Real samples recorded through the Discord audio path are the most valuable wake word training data. To collect WAV samples on the Pi, temporarily enable:

```env
VOICE_COMMANDS_ENABLED=false
VOICE_SAMPLE_COLLECTION_ENABLED=true
VOICE_SAMPLE_COLLECTION_DIR=/path/to/eppu-normaali/voice-samples/positive
VOICE_SAMPLE_COLLECTION_LABEL=positive
```

Then make Eppu join the voice channel and say the wake phrase plus short commands, for example `Hei Eppu soita 22`. The receiver stores 16 kHz mono WAV segments in `VOICE_SAMPLE_COLLECTION_DIR`.

Use a separate directory and label for negative samples (normal conversation **without** the wake phrase):

```env
VOICE_SAMPLE_COLLECTION_DIR=/path/to/eppu-normaali/voice-samples/negative
VOICE_SAMPLE_COLLECTION_LABEL=negative
```

Disable sample collection after recording. It intentionally saves voice-channel speech segments while enabled. Copy the samples to the training machine (`rsync -av pi:/path/to/eppu-normaali/voice-samples/ voice-samples/`) and follow `training/README.md`.

## Privacy Boundary

All audio stays on the Pi. Speech segments are decoded into short temporary WAV files, scored/transcribed by the local voice worker, and deleted. Nothing is sent to any external service (unless you explicitly opt into the legacy `VOICE_STT_ENGINE=openai`).
