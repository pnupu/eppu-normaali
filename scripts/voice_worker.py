#!/usr/bin/env python3
"""Persistent local voice worker for the Eppu Discord bot.

Reads one JSON request per line from stdin and writes one JSON response per
line to stdout. Everything runs locally: openWakeWord scores the wake phrase
and faster-whisper transcribes commands. No network access is needed at
runtime (faster-whisper downloads its model once on first use unless it is
already cached).

Requests:
  {"id": 1, "op": "ping"}
  {"id": 2, "op": "wake", "path": "/tmp/clip.wav", "threshold": 0.55}
  {"id": 3, "op": "transcribe", "path": "/tmp/clip.wav", "language": "fi",
   "initialPrompt": "Hei Eppu, soita 22."}

Responses always echo the request id and carry "ok": true/false.
"""

import argparse
import json
import os
import sys
import traceback


def log(message: str) -> None:
    print(f"[voice-worker] {message}", file=sys.stderr, flush=True)


def respond(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


class WakeDetector:
    def __init__(self, model_path: str, verifier_path: str = "", verifier_threshold: float = 0.3):
        from openwakeword.model import Model

        kwargs = {
            "wakeword_models": [model_path],
            "inference_framework": "onnx" if model_path.lower().endswith(".onnx") else "tflite",
        }
        if verifier_path:
            model_key = os.path.splitext(os.path.basename(model_path))[0]
            kwargs["custom_verifier_models"] = {model_key: verifier_path}
            kwargs["custom_verifier_threshold"] = verifier_threshold
        self.model = Model(**kwargs)
        log(f"loaded openWakeWord model {model_path}"
            + (f" with verifier {verifier_path}" if verifier_path else ""))

    def score(self, wav_path: str) -> dict:
        if hasattr(self.model, "reset"):
            self.model.reset()
        predictions = self.model.predict_clip(wav_path)

        best_model = None
        best_score = 0.0
        # predict_clip returns a list of frame-level dicts in current
        # openwakeword releases; older versions returned a dict of arrays.
        if isinstance(predictions, dict):
            frames = []
            for name, scores in predictions.items():
                values = scores.tolist() if hasattr(scores, "tolist") else list(scores)
                frames.extend({name: float(v)} for v in values)
        else:
            frames = predictions

        for frame in frames:
            for name, value in frame.items():
                value = float(value)
                if value > best_score:
                    best_score = value
                    best_model = name

        return {"score": best_score, "model": best_model}


class Transcriber:
    def __init__(self, model_name: str, device: str, compute_type: str, download_root: str = ""):
        from faster_whisper import WhisperModel

        log(f"loading faster-whisper model '{model_name}' (device={device}, compute={compute_type})...")
        self.model = WhisperModel(
            model_name,
            device=device,
            compute_type=compute_type,
            download_root=download_root or None,
        )
        log("faster-whisper model ready")

    def transcribe(self, wav_path: str, language: str = "", initial_prompt: str = "") -> str:
        segments, _info = self.model.transcribe(
            wav_path,
            language=language or None,
            beam_size=1,
            condition_on_previous_text=False,
            initial_prompt=initial_prompt or None,
            vad_filter=False,
        )
        return " ".join(segment.text.strip() for segment in segments).strip()


def main() -> int:
    parser = argparse.ArgumentParser(description="Eppu local voice worker (wake word + transcription).")
    parser.add_argument("--oww-model", default="", help="Path to an openWakeWord .onnx/.tflite model")
    parser.add_argument("--oww-verifier", default="", help="Path to a custom verifier .pkl model")
    parser.add_argument("--oww-verifier-threshold", type=float, default=0.3)
    parser.add_argument("--whisper-model", default="base", help="faster-whisper model name or path")
    parser.add_argument("--whisper-device", default="cpu")
    parser.add_argument("--whisper-compute", default="int8")
    parser.add_argument("--whisper-download-root", default="")
    parser.add_argument("--preload-whisper", action="store_true",
                        help="Load the whisper model at startup instead of on first use")
    args = parser.parse_args()

    detector = None
    if args.oww_model:
        try:
            detector = WakeDetector(args.oww_model, args.oww_verifier, args.oww_verifier_threshold)
        except Exception as exc:
            log(f"failed to load openWakeWord model: {exc}")
            log(traceback.format_exc())

    transcriber = None

    def get_transcriber() -> Transcriber:
        nonlocal transcriber
        if transcriber is None:
            transcriber = Transcriber(
                args.whisper_model,
                args.whisper_device,
                args.whisper_compute,
                args.whisper_download_root,
            )
        return transcriber

    if args.preload_whisper:
        try:
            get_transcriber()
        except Exception as exc:
            log(f"failed to preload whisper model: {exc}")

    respond({"id": 0, "ok": True, "event": "ready", "wake": detector is not None})
    log("ready")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            op = request.get("op")

            if op == "ping":
                respond({
                    "id": request_id,
                    "ok": True,
                    "wake": detector is not None,
                    "whisperLoaded": transcriber is not None,
                })
            elif op == "wake":
                if detector is None:
                    respond({"id": request_id, "ok": False, "error": "No openWakeWord model loaded"})
                    continue
                threshold = float(request.get("threshold", 0.55))
                result = detector.score(request["path"])
                respond({
                    "id": request_id,
                    "ok": True,
                    "detected": result["score"] >= threshold,
                    "score": result["score"],
                    "model": result["model"],
                })
            elif op == "transcribe":
                text = get_transcriber().transcribe(
                    request["path"],
                    language=request.get("language", ""),
                    initial_prompt=request.get("initialPrompt", ""),
                )
                respond({"id": request_id, "ok": True, "text": text})
            else:
                respond({"id": request_id, "ok": False, "error": f"Unknown op: {op}"})
        except Exception as exc:
            log(traceback.format_exc())
            respond({"id": request_id, "ok": False, "error": str(exc)})

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
