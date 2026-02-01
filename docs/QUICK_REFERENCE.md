# AWS Nitro Enclave 빠른 참조 카드

## 🚀 5분 만에 시작하기

### 1. EC2 인스턴스 생성 (AWS Console)
```
AMI: Amazon Linux 2023
타입: c5.xlarge (최소)
Nitro Enclave: ✅ Enable (고급 세부 정보에서)
스토리지: 30GB
보안그룹: SSH(22) + TCP(8080)
```

### 2. 인스턴스 접속 후 실행
```bash
# 모든 것을 한 번에 설치
curl -sSL https://raw.githubusercontent.com/your-repo/setup.sh | bash

# 또는 수동 설치
sudo dnf install -y aws-nitro-enclaves-cli docker
sudo systemctl start docker nitro-enclaves-allocator
sudo usermod -aG docker,ne $USER
# 재로그인 필요!
```

### 3. 프로젝트 배포
```bash
cd ~/tee-resource-lock
npm install
docker build -t tee-resource-lock:latest -f Dockerfile.enclave .
nitro-cli build-enclave --docker-uri tee-resource-lock:latest --output-file app.eif
```

### 4. Enclave 실행
```bash
# 시작
nitro-cli run-enclave --cpu-count 2 --memory 4096 --eif-path app.eif --debug-mode

# CID 확인
CID=$(nitro-cli describe-enclaves | jq -r '.[0].EnclaveCID')

# Proxy 시작
vsock-proxy 8080 $CID 5000 &

# 테스트
curl -X POST localhost:8080 -d '{"jsonrpc":"2.0","id":1,"method":"health","params":{}}'
```

---

## 📋 주요 명령어

| 작업 | 명령어 |
|-----|--------|
| Enclave 시작 | `nitro-cli run-enclave --eif-path app.eif --cpu-count 2 --memory 4096` |
| 상태 확인 | `nitro-cli describe-enclaves` |
| 콘솔 로그 | `nitro-cli console --enclave-id <ID>` |
| 종료 | `nitro-cli terminate-enclave --all` |
| EIF 빌드 | `nitro-cli build-enclave --docker-uri <image> --output-file app.eif` |
| PCR 확인 | `nitro-cli describe-eif --eif-path app.eif` |

---

## 🔧 allocator.yaml 설정

```yaml
# /etc/nitro_enclaves/allocator.yaml
memory_mib: 4096  # Enclave용 메모리 (MB)
cpu_count: 2      # Enclave용 CPU 수
```

변경 후: `sudo systemctl restart nitro-enclaves-allocator`

---

## 🌐 vsock 통신

```
외부 → TCP:8080 → [Parent:vsock-proxy] → vsock:CID:5000 → [Enclave]
```

```bash
# vsock-proxy 시작
vsock-proxy <외부포트> <Enclave_CID> <Enclave_PORT> &

# 예시
vsock-proxy 8080 16 5000 &
```

---

## ⚠️ 일반적인 문제

### "Enclave device not found"
→ EC2 콘솔에서 Nitro Enclave 활성화 확인

### "Cannot allocate memory"
→ allocator.yaml에서 메모리 줄이기 또는 큰 인스턴스 사용

### "vsock connection refused"  
→ Enclave가 완전히 부팅될 때까지 대기 (10-30초)

### 로그가 안 보임
→ `--debug-mode` 옵션 추가 (개발용만!)

---

## 💰 비용 (서울 리전 기준)

| 인스턴스 | 시간당 | 월간 (24/7) |
|---------|-------|------------|
| c5.xlarge (On-Demand) | $0.17 | ~$124 |
| c5.xlarge (Spot) | ~$0.05 | ~$36 |
| c6i.2xlarge (On-Demand) | $0.34 | ~$248 |

---

## 📁 프로젝트 구조

```
tee-resource-lock/
├── shared/
│   ├── types.ts        # 공유 타입
│   └── crypto.ts       # 암호화 유틸
├── enclave/
│   └── ccm.ts          # CCM 핵심 로직
├── api/
│   └── server.ts       # API 서버
├── client/
│   ├── sdk.ts          # 클라이언트 SDK
│   └── examples.ts     # 사용 예제
├── Dockerfile.enclave  # Enclave용 Dockerfile
├── package.json
└── tsconfig.json
```

---

## 🔐 프로덕션 체크리스트

- [ ] `--debug-mode` 제거
- [ ] 보안 그룹 IP 제한
- [ ] HTTPS 설정
- [ ] PCR0 값 저장 (attestation용)
- [ ] CloudWatch 로깅 설정
- [ ] Auto-restart systemd 서비스
- [ ] 백업 인스턴스 준비
