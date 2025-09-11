#!/usr/bin/env python3
"""
Minimal precise-listen replacement using precise-runner.

Usage (on Pi):
  python3 train-wake-word/precise-listen.py models/hei_eppu.pb --sensitivity 0.5

This prints 'HOTWORD' upon detection (compatible with wakeWordDetector.ts).
Requires: pip install precise-runner pyaudio soundfile; and the precise-engine binary available in PATH.
"""

import argparse
import shutil
import sys
import time

try:
    from precise_runner import PreciseRunner, PreciseEngine
except Exception as e:
    print("precise-runner not installed: pip install precise-runner", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('model', help='Path to .pb model')
    parser.add_argument('--sensitivity', default='0.5', help='Sensitivity 0.0-1.0 (default 0.5)')
    parser.add_argument('--chunk-size', default='1024', help='Chunk size (ignored by runner, kept for compatibility)')
    args = parser.parse_args()

    engine_path = shutil.which('precise-engine')
    if not engine_path:
        print("precise-engine not found in PATH. Ensure precise-runner is installed or place precise-engine in PATH.", file=sys.stderr)
        return 2

    try:
        engine = PreciseEngine(engine_path, args.model)
    except Exception as e:
        print(f"Failed to start engine: {e}", file=sys.stderr)
        return 2

    def on_activation():
        print('HOTWORD', flush=True)

    # trigger_level=1 fires as soon as the wake is detected
    runner = PreciseRunner(engine, sensitivity=float(args.sensitivity), trigger_level=1)
    runner.on_activation = on_activation
    runner.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        runner.stop()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())


