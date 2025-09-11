#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME=eppu-precise-train:py38-tf115
DATASET_DIR=$(cd "$(dirname "$0")" && pwd)

echo "Building image $IMAGE_NAME (linux/amd64)..."
# Ensure buildx is available and current context has a builder
if ! docker buildx version >/dev/null 2>&1; then
  echo "docker buildx not available. Update Docker Desktop or install buildx."
  exit 1
fi

# Workaround for permission denied on ~/.docker/buildx/current
mkdir -p "$HOME/.docker/buildx" || true

docker buildx create --use >/dev/null 2>&1 || true
docker buildx build --platform linux/amd64 -t "$IMAGE_NAME" "$DATASET_DIR" --load

echo "Starting training container..."
docker run --rm -it \
  --platform linux/amd64 \
  -v "$DATASET_DIR":/app \
  -w /app \
  "$IMAGE_NAME" \
  bash -lc "\
    echo 'Python:' && python -V && \
    echo 'precise-train:' && precise-train --help | head -n 10 && \
    echo 'Running training...' && \
    precise-train -e 60 -b 64 models/hei_eppu.net wake-word && \
    echo 'Converting to .pb...' && \
    precise-convert models/hei_eppu.net models/hei_eppu.pb && \
    ls -lh models/hei_eppu.* \
  "


