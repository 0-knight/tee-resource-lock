#!/bin/bash

#############################################################################
# TEE Resource Lock - Quick Setup Script
# 
# 이 스크립트는 AWS EC2 인스턴스에서 실행됩니다.
# Nitro Enclave가 활성화된 인스턴스에서만 동작합니다.
#############################################################################

set -e

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 로그 함수
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# 헤더 출력
echo "=============================================="
echo "   TEE Resource Lock - Quick Setup Script"
echo "=============================================="
echo ""

#############################################################################
# Step 1: 시스템 체크
#############################################################################

log_info "Step 1: Checking system requirements..."

# OS 확인
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$NAME
    log_info "Detected OS: $OS"
else
    log_error "Cannot detect OS"
fi

# Nitro Enclave 지원 확인
if [ ! -c /dev/nitro_enclaves ]; then
    log_error "Nitro Enclave device not found. Make sure you're running on an enclave-enabled EC2 instance."
fi

log_success "System check passed"

#############################################################################
# Step 2: 패키지 설치
#############################################################################

log_info "Step 2: Installing required packages..."

if [[ "$OS" == *"Amazon Linux"* ]]; then
    sudo dnf update -y
    sudo dnf install -y aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel docker jq
elif [[ "$OS" == *"Ubuntu"* ]]; then
    sudo apt update
    sudo apt install -y docker.io jq
    # Nitro CLI는 수동 설치 필요
    if ! command -v nitro-cli &> /dev/null; then
        log_warn "Please install Nitro CLI manually for Ubuntu"
    fi
else
    log_warn "Unknown OS. Please install packages manually."
fi

# Docker 시작
sudo systemctl start docker
sudo systemctl enable docker

# 현재 사용자를 그룹에 추가
sudo usermod -aG docker $USER 2>/dev/null || true
sudo usermod -aG ne $USER 2>/dev/null || true

log_success "Packages installed"

#############################################################################
# Step 3: Node.js 설치
#############################################################################

log_info "Step 3: Installing Node.js..."

if ! command -v node &> /dev/null; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    nvm install 20
    nvm use 20
fi

log_success "Node.js $(node --version) installed"

#############################################################################
# Step 4: Nitro Enclave 설정
#############################################################################

log_info "Step 4: Configuring Nitro Enclave allocator..."

# allocator 설정
sudo tee /etc/nitro_enclaves/allocator.yaml > /dev/null << 'EOF'
---
memory_mib: 4096
cpu_count: 2
EOF

# allocator 서비스 재시작
sudo systemctl restart nitro-enclaves-allocator.service
sudo systemctl enable nitro-enclaves-allocator.service

log_success "Nitro Enclave allocator configured"

#############################################################################
# Step 5: 프로젝트 설정
#############################################################################

log_info "Step 5: Setting up project..."

PROJECT_DIR="$HOME/tee-resource-lock"
mkdir -p $PROJECT_DIR
cd $PROJECT_DIR

# package.json이 없으면 생성
if [ ! -f package.json ]; then
    log_info "Creating package.json..."
    cat > package.json << 'EOF'
{
  "name": "tee-resource-lock",
  "version": "1.0.0",
  "scripts": {
    "build": "tsc",
    "start:server": "ts-node api/server.ts"
  },
  "dependencies": {
    "@noble/curves": "^1.4.0",
    "@noble/hashes": "^1.4.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "typescript": "^5.3.0",
    "ts-node": "^10.9.0"
  }
}
EOF
fi

# 의존성 설치
if [ ! -d node_modules ]; then
    log_info "Installing npm dependencies..."
    npm install
fi

log_success "Project setup complete"

#############################################################################
# Step 6: Docker 이미지 빌드
#############################################################################

log_info "Step 6: Building Docker image..."

# Dockerfile 생성
cat > Dockerfile.enclave << 'EOF'
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
RUN npm install -g typescript ts-node
COPY tsconfig.json ./
COPY shared/ ./shared/
COPY enclave/ ./enclave/
COPY api/ ./api/
RUN npm run build 2>/dev/null || true
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5000
EXPOSE 5000
CMD ["node", "dist/api/server.js"]
EOF

# 소스 파일 확인
if [ ! -f shared/types.ts ] || [ ! -f enclave/ccm.ts ] || [ ! -f api/server.ts ]; then
    log_warn "Source files not found. Please copy the TypeScript files to:"
    log_warn "  - $PROJECT_DIR/shared/types.ts"
    log_warn "  - $PROJECT_DIR/shared/crypto.ts"
    log_warn "  - $PROJECT_DIR/enclave/ccm.ts"
    log_warn "  - $PROJECT_DIR/api/server.ts"
    log_warn "  - $PROJECT_DIR/client/sdk.ts"
    log_warn "Then run this script again."
    exit 0
fi

# Docker 이미지 빌드
sg docker -c "docker build -t tee-resource-lock:latest -f Dockerfile.enclave ."

log_success "Docker image built"

#############################################################################
# Step 7: Enclave 이미지 빌드
#############################################################################

log_info "Step 7: Building Enclave Image File (EIF)..."

# EIF 빌드
nitro-cli build-enclave \
    --docker-uri tee-resource-lock:latest \
    --output-file tee-resource-lock.eif 2>&1 | tee build-output.txt

# PCR0 추출
PCR0=$(grep -oP '"PCR0": "\K[^"]+' build-output.txt || echo "unknown")
log_info "PCR0 (Code Hash): $PCR0"
echo $PCR0 > pcr0.txt

log_success "Enclave image built: tee-resource-lock.eif"

#############################################################################
# Step 8: 실행 스크립트 생성
#############################################################################

log_info "Step 8: Creating helper scripts..."

# 시작 스크립트
cat > start-enclave.sh << 'SCRIPT'
#!/bin/bash
set -e

echo "[*] Starting Enclave..."

# 기존 enclave 종료
nitro-cli terminate-enclave --all 2>/dev/null || true

# Enclave 시작
RESULT=$(nitro-cli run-enclave \
    --cpu-count 2 \
    --memory 4096 \
    --eif-path tee-resource-lock.eif \
    --debug-mode)

ENCLAVE_ID=$(echo $RESULT | jq -r '.EnclaveID')
ENCLAVE_CID=$(echo $RESULT | jq -r '.EnclaveCID')

echo "[*] Enclave started"
echo "    Enclave ID: $ENCLAVE_ID"
echo "    Enclave CID: $ENCLAVE_CID"

# CID 저장
echo $ENCLAVE_CID > enclave-cid.txt

# vsock-proxy 시작
pkill vsock-proxy 2>/dev/null || true
sleep 1
vsock-proxy 8080 $ENCLAVE_CID 5000 &
PROXY_PID=$!
echo $PROXY_PID > vsock-proxy.pid

echo "[*] vsock-proxy started (PID: $PROXY_PID)"
echo "[*] API available at http://localhost:8080"
echo ""
echo "[*] Test with:"
echo '    curl -X POST http://localhost:8080 -H "Content-Type: application/json" -d '\''{"jsonrpc":"2.0","id":1,"method":"health","params":{}}'\'''
SCRIPT
chmod +x start-enclave.sh

# 중지 스크립트
cat > stop-enclave.sh << 'SCRIPT'
#!/bin/bash
echo "[*] Stopping Enclave..."
nitro-cli terminate-enclave --all
pkill vsock-proxy 2>/dev/null || true
rm -f enclave-cid.txt vsock-proxy.pid
echo "[*] Enclave stopped"
SCRIPT
chmod +x stop-enclave.sh

# 상태 확인 스크립트
cat > status-enclave.sh << 'SCRIPT'
#!/bin/bash
echo "=== Enclave Status ==="
nitro-cli describe-enclaves
echo ""
echo "=== vsock-proxy Status ==="
if [ -f vsock-proxy.pid ]; then
    PID=$(cat vsock-proxy.pid)
    if ps -p $PID > /dev/null 2>&1; then
        echo "Running (PID: $PID)"
    else
        echo "Not running"
    fi
else
    echo "Not running"
fi
SCRIPT
chmod +x status-enclave.sh

# 로그 확인 스크립트
cat > logs-enclave.sh << 'SCRIPT'
#!/bin/bash
ENCLAVE_ID=$(nitro-cli describe-enclaves | jq -r '.[0].EnclaveID')
if [ "$ENCLAVE_ID" != "null" ] && [ -n "$ENCLAVE_ID" ]; then
    echo "[*] Enclave console (Ctrl+C to exit):"
    nitro-cli console --enclave-id $ENCLAVE_ID
else
    echo "[!] No running enclave found"
fi
SCRIPT
chmod +x logs-enclave.sh

# 테스트 스크립트
cat > test-api.sh << 'SCRIPT'
#!/bin/bash
API_URL="${1:-http://localhost:8080}"

echo "=== Testing TEE Resource Lock API ==="
echo "API URL: $API_URL"
echo ""

# Health check
echo "1. Health Check:"
curl -s -X POST $API_URL \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"health","params":{}}' | jq .
echo ""

# Get boot attestation
echo "2. Boot Attestation:"
curl -s -X POST $API_URL \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":2,"method":"getBootAttestation","params":{}}' | jq .
echo ""

# Create lock (will fail without proper signature, but tests API)
echo "3. Create Lock (test):"
curl -s -X POST $API_URL \
    -H "Content-Type: application/json" \
    -d '{
        "jsonrpc":"2.0",
        "id":3,
        "method":"createLock",
        "params":{
            "owner":"0x1234567890123456789012345678901234567890",
            "sessionKey":"0x1234567890123456789012345678901234567890",
            "asset":{"chainId":1,"assetType":"native"},
            "amount":"1000000000000000000",
            "expiresIn":300,
            "fulfillmentCondition":{
                "targetChainId":42161,
                "targetAsset":{"chainId":42161,"assetType":"native"},
                "targetAmount":"500000000000000000",
                "recipient":"0x1234567890123456789012345678901234567890"
            }
        }
    }' | jq .
echo ""

echo "=== Tests Complete ==="
SCRIPT
chmod +x test-api.sh

log_success "Helper scripts created"

#############################################################################
# 완료
#############################################################################

echo ""
echo "=============================================="
echo "   Setup Complete!"
echo "=============================================="
echo ""
echo "Project directory: $PROJECT_DIR"
echo ""
echo "Available commands:"
echo "  ./start-enclave.sh    - Start the enclave"
echo "  ./stop-enclave.sh     - Stop the enclave"
echo "  ./status-enclave.sh   - Check enclave status"
echo "  ./logs-enclave.sh     - View enclave logs (debug mode)"
echo "  ./test-api.sh         - Test the API endpoints"
echo ""
echo "Quick start:"
echo "  cd $PROJECT_DIR"
echo "  ./start-enclave.sh"
echo "  ./test-api.sh"
echo ""

# 그룹 변경사항 적용 안내
if groups $USER | grep -q '\bdocker\b'; then
    log_info "Docker group already applied"
else
    log_warn "Please log out and log back in to apply docker group changes"
    log_warn "Or run: newgrp docker"
fi
