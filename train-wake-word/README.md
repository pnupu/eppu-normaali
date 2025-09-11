# Finnish Wake Word Training Guide

This guide will help you train a custom wake word model for "Eppu" using Mycroft Precise.

## Overview

We'll train a custom wake word model that can detect "Eppu" in Finnish speech, optimized for your Raspberry Pi setup.

## Prerequisites

- Raspberry Pi (3B+ or newer recommended)
- Microphone connected to the Pi
- Python 3.7+ installed
- At least 1GB free disk space

## Quick Start

### Option A: Train on Mac (Recommended)
1. **Setup on Mac:**
   ```bash
   cd train-wake-word
   chmod +x setup-training.sh
   ./setup-training.sh
   source venv/bin/activate
   ```

2. **Collect training data:**
   ```bash
   python collect-data.py
   ```

3. **Train the model:**
   ```bash
   python train-model.py
   ```

4. **Transfer to Pi:**
   ```bash
   ./transfer-to-pi.sh
   ```

### Option B: Train on Raspberry Pi
1. **Setup on Pi:**
   ```bash
   cd train-wake-word
   chmod +x setup-training.sh
   ./setup-training.sh
   source venv/bin/activate
   ```

2. **Collect training data:**
   ```bash
   python collect-data.py
   ```

3. **Train the model:**
   ```bash
   python train-model.py
   ```

4. **Test the model:**
   ```bash
   precise-listen models/eppu.pb
   ```

## Detailed Steps

### Step 1: Environment Setup

The setup script will:
- Create a Python virtual environment
- Install all required dependencies
- Create necessary directories
- Set up audio system

```bash
./setup-training.sh
source venv/bin/activate
```

### Step 2: Data Collection

**Target: Collect 100+ positive samples and 200+ negative samples**

Run the data collection script:
```bash
python collect-data.py
```

**Data Collection Tips:**

1. **Positive Samples ("Eppu"):**
   - Say "Eppu" in different tones
   - Vary your volume (whisper, normal, loud)
   - Use different emotional tones
   - Record in different environments
   - Get multiple people to record if possible

2. **Negative Samples:**
   - Common Finnish words: "hei", "moi", "terve", "kiitos"
   - Similar sounding words: "eppu" variations
   - Background noise and music
   - Other voice commands

3. **Recording Quality:**
   - Use a good microphone
   - Record in a quiet environment
   - Speak clearly and naturally
   - Keep recordings 1-2 seconds long

### Step 3: Model Training

Train the model with your collected data:
```bash
python train-model.py
```

This will:
- Validate your training data
- Convert audio to the correct format
- Train the neural network model
- Convert to edge-optimized format
- Test the model

### Step 4: Integration

Once trained, the model will be available at:
- `models/eppu.pb` - Edge-optimized model for Raspberry Pi
- `models/eppu.net` - Training model (for reference)

The voice command system will automatically use this model.

## Troubleshooting

### Common Issues

1. **"precise-train not found"**
   ```bash
   pip install precise-runner
   ```

2. **Audio recording issues**
   ```bash
   # Test microphone
   arecord -f S16_LE -r 16000 -c 1 -d 5 test.wav
   aplay test.wav
   ```

3. **Low accuracy**
   - Collect more diverse training data
   - Ensure good audio quality
   - Try different sensitivity settings

4. **Model not loading**
   - Check file permissions
   - Verify model file exists
   - Check file path in code

### Performance Tuning

**For Raspberry Pi 3B+:**
- Use sensitivity 0.3-0.5
- Reduce chunk size to 512
- Close unnecessary processes

**For Raspberry Pi 4+:**
- Use sensitivity 0.5-0.7
- Default chunk size (1024)
- Can handle more background processes

### Testing Your Model

1. **Basic test:**
   ```bash
   precise-listen models/eppu.pb --sensitivity 0.5
   ```

2. **Test with different sensitivity:**
   ```bash
   precise-listen models/eppu.pb --sensitivity 0.3  # More sensitive
   precise-listen models/eppu.pb --sensitivity 0.7  # Less sensitive
   ```

3. **Test in your bot:**
   ```bash
   npm start
   # Say "Eppu" followed by a command
   ```

## Advanced Configuration

### Custom Sensitivity

Edit the wake word detector to adjust sensitivity:
```typescript
// In src/voice/wakeWordDetector.ts
this.preciseProcess = spawn('precise-listen', [
  this.modelPath,
  '--sensitivity', '0.5',  // Adjust this value
  '--chunk-size', '1024'
]);
```

### Model Retraining

To improve accuracy:
1. Collect more training data
2. Focus on problematic cases
3. Retrain the model
4. Test and iterate

### Multiple Wake Words

To add more wake words:
1. Collect data for each word
2. Train separate models
3. Modify the detector to handle multiple models

## File Structure

```
train-wake-word/
├── collect-data.py          # Data collection script
├── train-model.py           # Training script
├── setup-training.sh        # Setup script
├── requirements.txt         # Python dependencies
├── README.md               # This guide
├── venv/                   # Virtual environment
├── wake-word/              # Training data
│   ├── wake-word/          # Positive samples
│   └── not-wake-word/      # Negative samples
└── models/                 # Trained models
    ├── eppu.pb            # Edge model
    └── eppu.net           # Training model
```

## Performance Metrics

**Good Model Indicators:**
- High accuracy on test data (>90%)
- Low false positive rate (<5%)
- Fast detection time (<1 second)
- Low CPU usage on Pi

**Model Quality Checklist:**
- ✅ At least 100 positive samples
- ✅ At least 200 negative samples
- ✅ Diverse speakers and environments
- ✅ Good audio quality
- ✅ Balanced positive/negative ratio

## Support

If you encounter issues:

1. Check the troubleshooting section
2. Verify all dependencies are installed
3. Test audio input/output manually
4. Check file permissions and paths
5. Review the training logs

## Next Steps

Once your model is trained and working:

1. **Integrate with your bot** - The system will automatically use your trained model
2. **Test voice commands** - Try the full voice command system
3. **Fine-tune sensitivity** - Adjust based on your environment
4. **Collect more data** - Continuously improve the model
5. **Deploy to production** - Use in your Discord server

Happy training! 🎵

## Usage: Ingest a Discord recording

```bash
# Activate env
cd train-wake-word
source venv/bin/activate

# Basic: split entire file into 2s negatives (silence skipped)
python ingest-discord-recording.py /path/to/discord-recording.m4a

# Mark positives where you said the wake phrase "Hei Eppu"
# Example ranges (seconds): 12.3-14.1 and 45.0-47.2
python ingest-discord-recording.py /path/to/discord-recording.m4a \
  --positives 12.3-14.1,45.0-47.2 \
  --chunk 2.0 --sr 16000

# Output goes to:
#  - wake-word/wake-word/        (positives)
#  - wake-word/not-wake-word/    (negatives)
```

Tips:
- Ranges can be found with any audio editor (Audacity etc.).
- Include near-miss phrases as negatives unless it’s a clear “Hei Eppu”.
- Keep chunk length consistent with your collection script (2s default).
