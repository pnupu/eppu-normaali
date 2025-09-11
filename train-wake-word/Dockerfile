# syntax=docker/dockerfile:1

# Use Python 3.8 on Debian slim to match TF 1.15 compatibility
FROM --platform=linux/amd64 python:3.8-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    libsndfile1 \
    portaudio19-dev \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only what we need for training
COPY requirements.txt /app/requirements.txt

# Pin TF1 + deps for Precise training
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir \
        tensorflow==1.15.5 \
        h5py==2.10.0 \
        "numpy<1.20" \
        mycroft-precise==0.3.0 \
        precise-runner==0.3.1 \
        prettyparse==1.2.0 \
        soundfile \
        librosa \
        sox \
        pyaudio

# We do not copy the dataset into the image; it is bind-mounted at runtime

# Default command shows help
CMD ["bash", "-lc", "precise-train --help | head -n 40"]


