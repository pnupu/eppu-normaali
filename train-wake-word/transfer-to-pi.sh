#!/bin/bash

# Transfer trained wake word model to Raspberry Pi

echo "=== Transferring Wake Word Model to Raspberry Pi ==="

# Check if model exists
if [ ! -f "models/eppu.pb" ]; then
    echo "❌ Trained model not found: models/eppu.pb"
    echo "Please train the model first: python train-model.py"
    exit 1
fi

# Get Pi connection details
echo "Enter your Raspberry Pi connection details:"
read -p "Pi IP address or hostname: " PI_HOST
read -p "Pi username (default: pi): " PI_USER
PI_USER=${PI_USER:-pi}

# Optional: Use SSH key
read -p "Use SSH key? (y/n): " USE_SSH_KEY

if [[ "$USE_SSH_KEY" == "y" ]]; then
    SSH_CMD="ssh -i ~/.ssh/id_rsa"
    SCP_CMD="scp -i ~/.ssh/id_rsa"
else
    SSH_CMD="ssh"
    SCP_CMD="scp"
fi

echo ""
echo "Testing connection to Pi..."
if $SSH_CMD $PI_USER@$PI_HOST "echo 'Connection successful'"; then
    echo "✅ Connection to Pi successful"
else
    echo "❌ Cannot connect to Pi. Please check:"
    echo "  - Pi is running and accessible"
    echo "  - SSH is enabled on Pi"
    echo "  - Username and IP are correct"
    echo "  - SSH key is set up (if using key authentication)"
    exit 1
fi

echo ""
echo "Creating models directory on Pi..."
$SSH_CMD $PI_USER@$PI_HOST "mkdir -p ~/eppunormaali/train-wake-word/models"

echo ""
echo "Transferring model files..."
$SCP_CMD models/eppu.pb $PI_USER@$PI_HOST:~/eppunormaali/train-wake-word/models/
$SCP_CMD models/eppu.net $PI_USER@$PI_HOST:~/eppunormaali/train-wake-word/models/ 2>/dev/null || echo "Note: .net file not found (optional)"

echo ""
echo "Installing Precise on Pi..."
$SSH_CMD $PI_USER@$PI_HOST "pip3 install precise-runner"

echo ""
echo "Testing model on Pi..."
$SSH_CMD $PI_USER@$PI_HOST "cd ~/eppunormaali && precise-listen train-wake-word/models/eppu.pb --sensitivity 0.5 --timeout 5" &
TEST_PID=$!

echo "Say 'Eppu' to test the model (5 second timeout)..."
sleep 5
kill $TEST_PID 2>/dev/null

echo ""
echo "✅ Model transfer complete!"
echo ""
echo "Next steps on your Pi:"
echo "1. cd ~/eppunormaali"
echo "2. npm start"
echo "3. Say 'Eppu' followed by a command"
echo ""
echo "Model location on Pi: ~/eppunormaali/train-wake-word/models/eppu.pb"
