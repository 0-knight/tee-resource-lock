# AWS Nitro Enclave 완벽 가이드: Resource Lock 시스템 배포

이 가이드는 AWS Nitro Enclave를 처음 사용하는 개발자를 위해 작성되었습니다.
환경 설정부터 TEE Resource Lock 시스템 배포 및 테스트까지 전 과정을 다룹니다.

## 목차

1. [Nitro Enclave 개요](#1-nitro-enclave-개요)
2. [사전 요구사항](#2-사전-요구사항)
3. [EC2 인스턴스 설정](#3-ec2-인스턴스-설정)
4. [Nitro Enclave CLI 설치](#4-nitro-enclave-cli-설치)
5. [개발 환경 구성](#5-개발-환경-구성)
6. [Enclave 이미지 빌드](#6-enclave-이미지-빌드)
7. [Enclave 실행 및 테스트](#7-enclave-실행-및-테스트)
8. [Parent-Enclave 통신](#8-parent-enclave-통신)
9. [프로덕션 배포](#9-프로덕션-배포)
10. [트러블슈팅](#10-트러블슈팅)

---

## 1. Nitro Enclave 개요

### 1.1 Nitro Enclave란?

AWS Nitro Enclave는 EC2 인스턴스 내에서 격리된 실행 환경을 제공하는 기술입니다.

```
┌─────────────────────────────────────────────────────────────┐
│                      EC2 Instance                            │
│  ┌─────────────────────┐    ┌─────────────────────────────┐ │
│  │    Parent Instance  │    │      Nitro Enclave          │ │
│  │                     │    │  ┌───────────────────────┐  │ │
│  │  - 일반 애플리케이션   │◄──►│  │  격리된 실행 환경      │  │ │
│  │  - 네트워크 접근 가능  │vsock│  │  - 네트워크 없음       │  │ │
│  │  - 스토리지 접근      │    │  │  - 스토리지 없음       │  │ │
│  │                     │    │  │  - 전용 CPU/메모리     │  │ │
│  └─────────────────────┘    │  └───────────────────────┘  │ │
│                             └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 주요 특징

| 특징 | 설명 |
|-----|-----|
| **격리** | Parent instance와 완전히 분리된 메모리/CPU |
| **무네트워크** | 직접 네트워크 접근 불가, vsock으로만 통신 |
| **무스토리지** | 영구 스토리지 없음, 모든 데이터는 휘발성 |
| **Attestation** | 코드 무결성을 암호학적으로 증명 가능 |
| **보안 시간** | NSM(Nitro Secure Module)에서 신뢰할 수 있는 시간 제공 |

### 1.3 Resource Lock에서 왜 Nitro Enclave를 사용하는가?

1. **Private Key 보호**: 서명 키가 enclave 외부로 절대 노출되지 않음
2. **Attestation**: Solver가 올바른 코드가 실행 중임을 검증 가능
3. **Tamper Resistance**: 운영자도 실행 중인 코드를 변조할 수 없음

---

## 2. 사전 요구사항

### 2.1 AWS 계정 설정

```bash
# AWS CLI 설치 (macOS)
brew install awscli

# AWS CLI 설치 (Linux)
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install

# AWS 자격 증명 설정
aws configure
# AWS Access Key ID: [your-access-key]
# AWS Secret Access Key: [your-secret-key]
# Default region name: ap-northeast-2 (또는 원하는 리전)
# Default output format: json
```

### 2.2 지원되는 인스턴스 타입

Nitro Enclave를 사용하려면 특정 인스턴스 타입이 필요합니다:

| 시리즈 | 지원 타입 | 권장 용도 |
|-------|----------|----------|
| **C5** | c5.xlarge, c5.2xlarge, ... | 개발/테스트 |
| **C6i** | c6i.xlarge, c6i.2xlarge, ... | 프로덕션 권장 |
| **M5** | m5.xlarge, m5.2xlarge, ... | 범용 |
| **R5** | r5.xlarge, r5.2xlarge, ... | 메모리 집약적 |

**최소 권장**: `c5.xlarge` (4 vCPU, 8GB RAM) - 개발용
**프로덕션 권장**: `c6i.2xlarge` (8 vCPU, 16GB RAM)

### 2.3 비용 예상

```
c5.xlarge (ap-northeast-2 기준):
- On-Demand: ~$0.17/시간 (~$124/월)
- Spot: ~$0.05/시간 (~$36/월) - 개발용 추천
```

---

## 3. EC2 인스턴스 설정

### 3.1 AWS Console을 통한 설정

1. **EC2 대시보드** → **Launch Instance**

2. **AMI 선택**:
   - Amazon Linux 2023 (권장)
   - 또는 Ubuntu 22.04 LTS

3. **인스턴스 타입**:
   - `c5.xlarge` 선택

4. **고급 세부 정보** (중요!):
   - **Nitro Enclave**: ✅ Enable
   
   ```
   ⚠️ 이 옵션을 활성화하지 않으면 Enclave를 실행할 수 없습니다!
   ```

5. **스토리지**:
   - 최소 30GB gp3 (Docker 이미지 빌드용)

6. **보안 그룹**:
   ```
   Inbound Rules:
   - SSH (22): Your IP
   - Custom TCP (8080): 0.0.0.0/0 (API 테스트용, 프로덕션에서는 제한)
   ```

### 3.2 AWS CLI를 통한 설정

```bash
# 키 페어 생성
aws ec2 create-key-pair \
  --key-name nitro-enclave-key \
  --query 'KeyMaterial' \
  --output text > nitro-enclave-key.pem

chmod 400 nitro-enclave-key.pem

# 보안 그룹 생성
aws ec2 create-security-group \
  --group-name nitro-enclave-sg \
  --description "Security group for Nitro Enclave development"

SECURITY_GROUP_ID=$(aws ec2 describe-security-groups \
  --group-names nitro-enclave-sg \
  --query 'SecurityGroups[0].GroupId' \
  --output text)

# SSH 접근 허용
aws ec2 authorize-security-group-ingress \
  --group-id $SECURITY_GROUP_ID \
  --protocol tcp \
  --port 22 \
  --cidr 0.0.0.0/0

# API 포트 허용
aws ec2 authorize-security-group-ingress \
  --group-id $SECURITY_GROUP_ID \
  --protocol tcp \
  --port 8080 \
  --cidr 0.0.0.0/0

# EC2 인스턴스 시작 (Nitro Enclave 활성화)
aws ec2 run-instances \
  --image-id ami-0c9c942bd7bf113a2 \
  --instance-type c5.xlarge \
  --key-name nitro-enclave-key \
  --security-group-ids $SECURITY_GROUP_ID \
  --enclave-options 'Enabled=true' \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":30,"VolumeType":"gp3"}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=nitro-enclave-dev}]'
```

### 3.3 인스턴스 접속

```bash
# Public IP 확인
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=nitro-enclave-dev" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text)

PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids $INSTANCE_ID \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)

echo "Instance IP: $PUBLIC_IP"

# SSH 접속
ssh -i nitro-enclave-key.pem ec2-user@$PUBLIC_IP
```

---

## 4. Nitro Enclave CLI 설치

### 4.1 Amazon Linux 2023에서 설치

```bash
# 시스템 업데이트
sudo dnf update -y

# Nitro Enclave CLI 설치
sudo dnf install aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel -y

# Docker 설치 (Enclave 이미지 빌드에 필요)
sudo dnf install docker -y
sudo systemctl start docker
sudo systemctl enable docker

# 현재 사용자를 docker 및 ne 그룹에 추가
sudo usermod -aG docker ec2-user
sudo usermod -aG ne ec2-user

# Nitro Enclave allocator 서비스 시작
sudo systemctl start nitro-enclaves-allocator.service
sudo systemctl enable nitro-enclaves-allocator.service

# 변경사항 적용을 위해 재로그인
exit
```

### 4.2 Ubuntu 22.04에서 설치

```bash
# 시스템 업데이트
sudo apt update && sudo apt upgrade -y

# 필수 패키지 설치
sudo apt install -y docker.io build-essential

# Nitro Enclave CLI 설치
wget https://github.com/aws/aws-nitro-enclaves-cli/releases/download/v1.3.0/aws-nitro-enclaves-cli_1.3.0_amd64.deb
sudo dpkg -i aws-nitro-enclaves-cli_1.3.0_amd64.deb

# 그룹 추가
sudo usermod -aG docker $USER
sudo usermod -aG ne $USER

# 서비스 시작
sudo systemctl start nitro-enclaves-allocator.service
sudo systemctl enable nitro-enclaves-allocator.service

exit
```

### 4.3 Enclave 리소스 할당 설정

```bash
# 재접속 후
ssh -i nitro-enclave-key.pem ec2-user@$PUBLIC_IP

# Enclave 리소스 설정 파일 편집
sudo vi /etc/nitro_enclaves/allocator.yaml
```

**allocator.yaml 설정**:
```yaml
---
# Enclave에 할당할 메모리 (MB)
# c5.xlarge의 경우 총 8GB 중 4GB를 enclave에 할당
memory_mib: 4096

# Enclave에 할당할 CPU 수
# c5.xlarge의 경우 총 4 vCPU 중 2개를 enclave에 할당
cpu_count: 2

# CPU pool (자동 할당하려면 비워둠)
# cpu_ids:
#   - 2
#   - 3
```

```bash
# 설정 적용
sudo systemctl restart nitro-enclaves-allocator.service

# 설정 확인
nitro-cli describe-enclaves
# 아직 실행 중인 enclave가 없으므로 빈 배열 반환
```

### 4.4 설치 확인

```bash
# Nitro CLI 버전 확인
nitro-cli --version
# 출력: Nitro CLI 1.3.x

# Docker 확인
docker --version
# 출력: Docker version 24.x.x

# Enclave 리소스 확인
cat /etc/nitro_enclaves/allocator.yaml
```

---

## 5. 개발 환경 구성

### 5.1 Node.js 설치

```bash
# nvm 설치
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc

# Node.js 20 LTS 설치
nvm install 20
nvm use 20

# 확인
node --version  # v20.x.x
npm --version   # 10.x.x
```

### 5.2 프로젝트 설정

```bash
# 프로젝트 디렉토리 생성
mkdir -p ~/tee-resource-lock
cd ~/tee-resource-lock

# 프로젝트 파일 가져오기 (여러 방법 중 선택)

# 방법 1: Git clone (프로젝트가 GitHub에 있는 경우)
# git clone https://github.com/your-repo/tee-resource-lock.git .

# 방법 2: SCP로 로컬에서 업로드
# 로컬 머신에서:
# scp -i nitro-enclave-key.pem -r ./tee-resource-lock/* ec2-user@$PUBLIC_IP:~/tee-resource-lock/

# 방법 3: 직접 파일 생성 (아래 섹션 참조)
```

### 5.3 프로젝트 파일 생성

이전에 생성한 모든 파일을 EC2 인스턴스에 생성합니다:

```bash
# 디렉토리 구조 생성
mkdir -p shared enclave api client contracts

# package.json 생성
cat > package.json << 'EOF'
{
  "name": "tee-resource-lock",
  "version": "1.0.0",
  "description": "TEE-based Resource Lock System",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start:server": "ts-node api/server.ts",
    "start:examples": "ts-node client/examples.ts"
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

# tsconfig.json 생성
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "moduleResolution": "node"
  },
  "include": ["shared/**/*", "enclave/**/*", "api/**/*", "client/**/*"],
  "exclude": ["node_modules", "dist", "contracts"]
}
EOF

# 의존성 설치
npm install
```

> 📝 **참고**: `shared/types.ts`, `shared/crypto.ts`, `enclave/ccm.ts`, `api/server.ts`, `client/sdk.ts`, `client/examples.ts` 파일들은 이전에 제공한 코드를 복사해서 생성하세요.

### 5.4 로컬 테스트 (Enclave 없이)

```bash
# 먼저 로컬에서 테스트하여 코드가 정상 동작하는지 확인
npm run start:server &

# 다른 터미널에서 테스트
curl -X POST http://localhost:8080 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"health","params":{}}'

# 예상 출력:
# {"jsonrpc":"2.0","id":1,"result":{"status":"healthy","enclaveId":"0x...","publicKey":"0x...",...}}

# 서버 중지
pkill -f "ts-node api/server.ts"
```

---

## 6. Enclave 이미지 빌드

### 6.1 Enclave용 Dockerfile 작성

```bash
cat > Dockerfile.enclave << 'EOF'
# Enclave용 경량 Node.js 이미지
FROM node:20-alpine

# 작업 디렉토리 설정
WORKDIR /app

# 패키지 파일 복사
COPY package*.json ./
COPY tsconfig.json ./

# 의존성 설치 (production only)
RUN npm ci --only=production

# TypeScript 컴파일러 설치 (빌드용)
RUN npm install -g typescript ts-node

# 소스 코드 복사
COPY shared/ ./shared/
COPY enclave/ ./enclave/
COPY api/ ./api/

# TypeScript 빌드
RUN npm run build

# Enclave 내 환경 변수
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=5000

# vsock 포트 (CID 5000으로 설정)
EXPOSE 5000

# Enclave 시작 명령
CMD ["node", "dist/api/server.js"]
EOF
```

### 6.2 Docker 이미지 빌드

```bash
# Docker 이미지 빌드
docker build -t tee-resource-lock:latest -f Dockerfile.enclave .

# 빌드 확인
docker images | grep tee-resource-lock
# 출력: tee-resource-lock   latest   xxxxxxxxxxxx   ...   ~200MB
```

### 6.3 Enclave Image File (EIF) 빌드

```bash
# EIF 파일 빌드
# 이 명령은 Docker 이미지를 Nitro Enclave가 실행할 수 있는 형식으로 변환합니다
nitro-cli build-enclave \
  --docker-uri tee-resource-lock:latest \
  --output-file tee-resource-lock.eif

# 빌드 출력 예시:
# Start building the Enclave Image...
# Enclave Image successfully created.
# {
#   "Measurements": {
#     "HashAlgorithm": "Sha384 { ... }",
#     "PCR0": "abc123...",  ← 이것이 코드 해시 (attestation에 사용)
#     "PCR1": "def456...",
#     "PCR2": "ghi789..."
#   }
# }
```

### 6.4 Measurements 저장

```bash
# PCR 값들을 저장 (나중에 attestation 검증에 사용)
nitro-cli build-enclave \
  --docker-uri tee-resource-lock:latest \
  --output-file tee-resource-lock.eif 2>&1 | tee build-output.txt

# PCR0 추출 (코드 해시)
grep -oP '"PCR0": "\K[^"]+' build-output.txt > pcr0.txt
echo "PCR0 (Code Hash): $(cat pcr0.txt)"
```

**PCR 값의 의미**:
| PCR | 내용 |
|-----|-----|
| PCR0 | Enclave 이미지 해시 (코드 무결성) |
| PCR1 | Linux 커널 및 부트스트랩 해시 |
| PCR2 | 애플리케이션 해시 |
| PCR8 | Enclave 서명 인증서 (서명된 경우) |

---

## 7. Enclave 실행 및 테스트

### 7.1 Enclave 실행

```bash
# Enclave 시작
nitro-cli run-enclave \
  --cpu-count 2 \
  --memory 4096 \
  --eif-path tee-resource-lock.eif \
  --debug-mode

# 출력 예시:
# Start allocating memory...
# Started enclave with enclave-cid: 16, memory: 4096 MiB, cpu-ids: [2, 3]
# {
#   "EnclaveName": "tee-resource-lock",
#   "EnclaveID": "i-xxxxxxxxxx-enc-xxxxxxxxxx",
#   "ProcessID": 12345,
#   "EnclaveCID": 16,        ← 이 CID를 기억하세요!
#   "NumberOfCPUs": 2,
#   "CPUIDs": [2, 3],
#   "MemoryMiB": 4096
# }
```

> ⚠️ `--debug-mode`는 개발 시에만 사용하세요. 프로덕션에서는 제거해야 합니다.

### 7.2 Enclave 상태 확인

```bash
# 실행 중인 enclave 목록
nitro-cli describe-enclaves

# 출력 예시:
# [
#   {
#     "EnclaveName": "tee-resource-lock",
#     "EnclaveID": "i-xxx-enc-xxx",
#     "ProcessID": 12345,
#     "EnclaveCID": 16,
#     "State": "RUNNING",
#     "Flags": "DEBUG_MODE",
#     "NumberOfCPUs": 2,
#     "MemoryMiB": 4096
#   }
# ]
```

### 7.3 Enclave 콘솔 로그 확인

```bash
# Debug 모드에서만 가능
nitro-cli console --enclave-id i-xxx-enc-xxx

# 또는 EnclaveID 자동 감지
ENCLAVE_ID=$(nitro-cli describe-enclaves | jq -r '.[0].EnclaveID')
nitro-cli console --enclave-id $ENCLAVE_ID
```

### 7.4 Enclave 종료

```bash
# 특정 enclave 종료
nitro-cli terminate-enclave --enclave-id $ENCLAVE_ID

# 또는 모든 enclave 종료
nitro-cli terminate-enclave --all
```

---

## 8. Parent-Enclave 통신

### 8.1 vsock 이해하기

Enclave는 네트워크에 직접 접근할 수 없습니다. 대신 **vsock**(Virtual Socket)을 사용하여 parent instance와 통신합니다.

```
┌─────────────────────────────────────────────────────────────┐
│                      EC2 Instance                            │
│                                                             │
│  ┌─────────────────┐         vsock          ┌─────────────┐ │
│  │  Parent (Proxy) │◄──────CID:PORT────────►│   Enclave   │ │
│  │   Port 8080     │                        │   Port 5000 │ │
│  └────────┬────────┘                        └─────────────┘ │
│           │                                                  │
│           │ TCP                                              │
└───────────┼──────────────────────────────────────────────────┘
            │
            ▼
       External Client
```

**CID (Context ID)**:
- Parent instance: CID 3
- Enclave: 실행 시 할당 (예: CID 16)

### 8.2 vsock Proxy 설치 및 설정

```bash
# vsock-proxy 설치 (aws-nitro-enclaves-cli에 포함)
# 이미 설치되어 있음

# vsock-proxy 시작 (백그라운드)
# 외부 TCP 8080 → Enclave vsock CID:5000
vsock-proxy 8080 3 5000 &

# 또는 systemd 서비스로 설정
sudo cat > /etc/systemd/system/vsock-proxy.service << 'EOF'
[Unit]
Description=vsock Proxy for Nitro Enclave
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/vsock-proxy 8080 3 5000
Restart=always
RestartSec=5
User=ec2-user

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable vsock-proxy
sudo systemctl start vsock-proxy
```

### 8.3 Parent에서 Enclave로 요청 전달하는 Proxy 구현

더 복잡한 시나리오를 위한 Node.js proxy:

```bash
cat > proxy/vsock-proxy.ts << 'EOF'
/**
 * vsock Proxy Server
 * 
 * HTTP 요청을 받아서 vsock으로 Enclave에 전달합니다.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import * as net from 'net';

// vsock 바인딩 (native module 필요)
// 실제 구현에서는 @aspect-build/vsock 패키지 사용
const ENCLAVE_CID = parseInt(process.env.ENCLAVE_CID || '16');
const ENCLAVE_PORT = parseInt(process.env.ENCLAVE_PORT || '5000');
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8080');

interface VsockSocket extends net.Socket {
  connect(port: number, cid: number, callback?: () => void): this;
}

// vsock 연결 함수 (네이티브 바인딩 필요)
function connectVsock(cid: number, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    // 실제 구현에서는 vsock 네이티브 모듈 사용
    // 여기서는 TCP로 시뮬레이션 (vsock-proxy 사용 시)
    const socket = new net.Socket();
    socket.connect(port, 'localhost', () => {
      resolve(socket);
    });
    socket.on('error', reject);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }
  
  // Body 읽기
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }
  
  try {
    // Enclave로 전달
    const socket = await connectVsock(ENCLAVE_CID, ENCLAVE_PORT);
    
    // 요청 전송
    socket.write(body);
    
    // 응답 읽기
    let response = '';
    socket.on('data', (data) => {
      response += data.toString();
    });
    
    socket.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(response);
    });
    
    socket.on('error', (err) => {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    });
    
  } catch (error: any) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: error.message }));
  }
}

const server = createServer(handleRequest);
server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`Proxy server listening on port ${PROXY_PORT}`);
  console.log(`Forwarding to Enclave CID ${ENCLAVE_CID}:${ENCLAVE_PORT}`);
});
EOF
```

### 8.4 Enclave 내부 vsock 서버

Enclave 내부에서 vsock을 수신하려면 API 서버를 수정해야 합니다:

```bash
cat > api/vsock-server.ts << 'EOF'
/**
 * vsock Server for Nitro Enclave
 * 
 * Enclave 내부에서 실행되며 vsock으로 요청을 수신합니다.
 */

// Enclave 환경에서는 @aspect-build/vsock 패키지 사용
// npm install @aspect-build/vsock

import { createServer } from 'net';
import {
  CredibleCommitmentMachine,
  initializeCCM,
  getCCM,
} from '../enclave/ccm';

const VSOCK_PORT = parseInt(process.env.PORT || '5000');

// CCM 초기화
initializeCCM();
console.log('[Enclave] CCM initialized');

// vsock 서버 생성
const server = createServer((socket) => {
  console.log('[Enclave] New connection');
  
  let data = '';
  
  socket.on('data', (chunk) => {
    data += chunk.toString();
    
    // 완전한 JSON인지 확인
    try {
      const request = JSON.parse(data);
      handleRequest(request)
        .then((response) => {
          socket.write(JSON.stringify(response));
          socket.end();
        })
        .catch((error) => {
          socket.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32603, message: error.message }
          }));
          socket.end();
        });
    } catch {
      // JSON이 완전하지 않음, 더 많은 데이터 대기
    }
  });
  
  socket.on('error', (err) => {
    console.error('[Enclave] Socket error:', err);
  });
});

async function handleRequest(request: any): Promise<any> {
  const ccm = getCCM();
  const { id, method, params } = request;
  
  switch (method) {
    case 'health':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          status: 'healthy',
          enclaveId: ccm.getEnclaveId(),
          publicKey: ccm.getEnclavePublicKey(),
          stateRoot: ccm.getStateRoot(),
          timestamp: Math.floor(Date.now() / 1000),
        }
      };
    
    case 'createLock':
      return {
        jsonrpc: '2.0',
        id,
        result: ccm.createLock(params),
      };
    
    case 'signLock':
      return {
        jsonrpc: '2.0',
        id,
        result: ccm.signLock(params),
      };
    
    // ... 다른 메소드들
    
    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      };
  }
}

// vsock에서 리슨 (CID 3은 parent)
server.listen(VSOCK_PORT, () => {
  console.log(`[Enclave] vsock server listening on port ${VSOCK_PORT}`);
});
EOF
```

### 8.5 통합 테스트

```bash
# 1. Enclave 실행
ENCLAVE_ID=$(nitro-cli run-enclave \
  --cpu-count 2 \
  --memory 4096 \
  --eif-path tee-resource-lock.eif \
  --debug-mode | jq -r '.EnclaveID')

ENCLAVE_CID=$(nitro-cli describe-enclaves | jq -r '.[0].EnclaveCID')

echo "Enclave ID: $ENCLAVE_ID"
echo "Enclave CID: $ENCLAVE_CID"

# 2. vsock-proxy 시작
vsock-proxy 8080 $ENCLAVE_CID 5000 &

# 3. 잠시 대기 (enclave 부팅)
sleep 10

# 4. API 테스트
curl -X POST http://localhost:8080 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"health","params":{}}'

# 5. 외부에서 테스트 (EC2 public IP 사용)
# 로컬 머신에서:
# curl -X POST http://$PUBLIC_IP:8080 \
#   -H "Content-Type: application/json" \
#   -d '{"jsonrpc":"2.0","id":1,"method":"health","params":{}}'
```

---

## 9. 프로덕션 배포

### 9.1 보안 강화

```bash
# 1. Debug 모드 제거
nitro-cli run-enclave \
  --cpu-count 2 \
  --memory 4096 \
  --eif-path tee-resource-lock.eif
  # --debug-mode 제거!

# 2. 보안 그룹 강화
aws ec2 revoke-security-group-ingress \
  --group-id $SECURITY_GROUP_ID \
  --protocol tcp \
  --port 8080 \
  --cidr 0.0.0.0/0

# 특정 IP만 허용
aws ec2 authorize-security-group-ingress \
  --group-id $SECURITY_GROUP_ID \
  --protocol tcp \
  --port 8080 \
  --cidr YOUR_IP/32
```

### 9.2 systemd 서비스 설정

```bash
# Enclave 자동 시작 서비스
sudo cat > /etc/systemd/system/tee-resource-lock.service << 'EOF'
[Unit]
Description=TEE Resource Lock Enclave
After=nitro-enclaves-allocator.service docker.service
Requires=nitro-enclaves-allocator.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/nitro-cli run-enclave --cpu-count 2 --memory 4096 --eif-path /home/ec2-user/tee-resource-lock/tee-resource-lock.eif
ExecStop=/usr/bin/nitro-cli terminate-enclave --all
User=ec2-user
Group=ne

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable tee-resource-lock
sudo systemctl start tee-resource-lock
```

### 9.3 모니터링 설정

```bash
# CloudWatch 에이전트 설치
sudo yum install amazon-cloudwatch-agent -y

# 로그 수집 설정
sudo cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'EOF'
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/nitro_enclaves/nitro_enclaves.log",
            "log_group_name": "/tee-resource-lock/enclave",
            "log_stream_name": "{instance_id}"
          }
        ]
      }
    }
  }
}
EOF

sudo systemctl enable amazon-cloudwatch-agent
sudo systemctl start amazon-cloudwatch-agent
```

### 9.4 Attestation 검증 엔드포인트

프로덕션에서는 클라이언트가 enclave의 attestation을 검증할 수 있어야 합니다:

```typescript
// attestation 검증 예시 (클라이언트 측)
async function verifyAttestation(attestationDoc: Uint8Array): Promise<boolean> {
  // 1. AWS Nitro attestation 문서 파싱
  // 2. AWS 루트 인증서로 서명 검증
  // 3. PCR 값이 예상 값과 일치하는지 확인
  // 4. 시간이 유효한지 확인
  
  // AWS 제공 라이브러리 사용:
  // https://github.com/aws/aws-nitro-enclaves-nsm-api
  return true;
}
```

---

## 10. 트러블슈팅

### 10.1 일반적인 오류

#### "Enclave failed to start"
```bash
# 메모리/CPU 할당 확인
cat /etc/nitro_enclaves/allocator.yaml

# 리소스 사용량 확인
nitro-cli describe-enclaves
free -m
```

#### "vsock connection refused"
```bash
# Enclave가 실행 중인지 확인
nitro-cli describe-enclaves

# CID 확인
ENCLAVE_CID=$(nitro-cli describe-enclaves | jq -r '.[0].EnclaveCID')
echo "CID: $ENCLAVE_CID"

# vsock-proxy 재시작
pkill vsock-proxy
vsock-proxy 8080 $ENCLAVE_CID 5000 &
```

#### "No such file: /dev/nitro_enclaves"
```bash
# Nitro Enclave가 활성화된 인스턴스인지 확인
# EC2 콘솔에서 인스턴스 설정 확인

# allocator 서비스 상태 확인
sudo systemctl status nitro-enclaves-allocator

# 서비스 재시작
sudo systemctl restart nitro-enclaves-allocator
```

### 10.2 디버깅 팁

```bash
# Enclave 콘솔 로그 (debug 모드 필요)
nitro-cli console --enclave-id $ENCLAVE_ID

# dmesg에서 nitro 관련 로그
dmesg | grep -i nitro

# Enclave 상세 정보
nitro-cli describe-enclaves --enclave-id $ENCLAVE_ID
```

### 10.3 성능 튜닝

```bash
# CPU pinning (특정 CPU를 enclave 전용으로)
sudo vi /etc/nitro_enclaves/allocator.yaml
```

```yaml
memory_mib: 4096
cpu_count: 2
cpu_ids:
  - 2
  - 3
```

---

## 부록

### A. 유용한 명령어 모음

```bash
# Enclave 관리
nitro-cli run-enclave ...        # 시작
nitro-cli describe-enclaves      # 목록
nitro-cli console --enclave-id   # 콘솔 (debug)
nitro-cli terminate-enclave ...  # 종료

# 이미지 관리
nitro-cli build-enclave ...      # EIF 빌드

# PCR 확인
nitro-cli describe-eif --eif-path xxx.eif
```

### B. 참고 자료

- [AWS Nitro Enclaves User Guide](https://docs.aws.amazon.com/enclaves/latest/user/)
- [Nitro Enclaves CLI GitHub](https://github.com/aws/aws-nitro-enclaves-cli)
- [NSM API](https://github.com/aws/aws-nitro-enclaves-nsm-api)
- [Attestation 검증](https://docs.aws.amazon.com/enclaves/latest/user/verify-root.html)

### C. 비용 최적화

```bash
# Spot 인스턴스 사용 (개발용)
aws ec2 request-spot-instances \
  --instance-count 1 \
  --launch-specification '{
    "ImageId": "ami-xxx",
    "InstanceType": "c5.xlarge",
    "KeyName": "nitro-enclave-key",
    "SecurityGroupIds": ["sg-xxx"],
    "BlockDeviceMappings": [
      {"DeviceName": "/dev/xvda", "Ebs": {"VolumeSize": 30}}
    ]
  }'
```

---

## 다음 단계

1. ✅ AWS 계정 및 EC2 인스턴스 설정
2. ✅ Nitro Enclave CLI 설치
3. ✅ Resource Lock 코드 배포
4. ✅ Enclave 이미지 빌드 및 실행
5. ⬜ Attestation 검증 구현
6. ⬜ 프로덕션 보안 강화
7. ⬜ 모니터링 및 알림 설정
8. ⬜ CI/CD 파이프라인 구축

질문이 있으시면 언제든 문의해 주세요!
