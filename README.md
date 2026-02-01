# TEE Resource Lock

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)

A **Trusted Execution Environment (TEE)** based Resource Lock system for secure cross-chain transactions. Inspired by [OneBalance's Credible Commitment Machine (CCM)](https://docs.onebalance.io/concepts/resource-locks) architecture.

## 🎯 Overview

Resource Locks enable **instant cross-chain transactions** by allowing users to credibly commit their assets without waiting for blockchain finality. The TEE (AWS Nitro Enclave) ensures that:

1. **Private keys never leave the enclave** - Signatures can only be generated inside the TEE
2. **No double-spending** - The CCM co-signs transactions, preventing equivocation
3. **Verifiable execution** - Anyone can verify the enclave is running the correct code via attestation

```
┌─────────────────────────────────────────────────────────────────┐
│                         Architecture                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   User ──► Lock Assets ──► CCM (TEE) ──► Commitment             │
│                               │                                  │
│                               ▼                                  │
│   Solver ◄── Verify ◄── Attestation                             │
│      │                                                          │
│      ▼                                                          │
│   Fulfill on Destination Chain                                  │
│      │                                                          │
│      ▼                                                          │
│   Submit Proof ──► CCM ──► Settlement UserOp ──► On-chain       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## ✨ Features

- **EVM Compatible** - Works with Ethereum, Arbitrum, Optimism, Base, Polygon, etc.
- **ERC-4337 Integration** - Smart account based settlement with gas abstraction
- **EIP-712 Signatures** - Human-readable transaction signing
- **Merkle State Proofs** - Efficient state verification
- **Dual Signature Model** - User + CCM co-signature prevents fraud
- **Rage Quit** - Users can always withdraw their assets

## 📁 Project Structure

```
tee-resource-lock/
├── src/
│   ├── shared/           # Shared types and crypto utilities
│   │   ├── types.ts      # TypeScript type definitions
│   │   ├── crypto.ts     # Cryptographic primitives (ECDSA, Keccak256, etc.)
│   │   └── index.ts
│   ├── enclave/          # TEE-only code (runs inside Nitro Enclave)
│   │   ├── ccm.ts        # Credible Commitment Machine core logic
│   │   └── index.ts
│   ├── api/              # API server (runs inside Nitro Enclave)
│   │   └── server.ts     # JSON-RPC 2.0 API server
│   ├── client/           # Client SDK (runs on user's machine)
│   │   ├── sdk.ts        # TypeScript SDK for dApps
│   │   ├── examples.ts   # Usage examples
│   │   └── index.ts
│   └── index.ts          # Package exports
├── contracts/            # Solidity smart contracts
│   └── ResourceLock.sol  # On-chain validator and smart account
├── docs/                 # Documentation
│   ├── NITRO_ENCLAVE_GUIDE.md  # Detailed setup guide
│   └── QUICK_REFERENCE.md      # Quick reference card
├── scripts/              # Utility scripts
│   └── setup.sh          # Automated setup script
├── Dockerfile.enclave    # Docker image for Nitro Enclave
├── package.json
├── tsconfig.json
└── README.md
```

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Docker (for building enclave image)
- AWS account with EC2 access (for production deployment)

### Local Development

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/tee-resource-lock.git
cd tee-resource-lock

# Install dependencies
npm install

# Build
npm run build

# Run API server locally (without TEE, for development)
npm run start:server

# In another terminal, run examples
npm run start:examples
```

### Test the API

```bash
# Health check
curl -X POST http://localhost:8080 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"health","params":{}}'

# Create a lock
curl -X POST http://localhost:8080 \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"createLock",
    "params":{
      "owner":"0x1234567890123456789012345678901234567890",
      "sessionKey":"0x1234567890123456789012345678901234567890",
      "asset":{"chainId":1,"assetType":"erc20","contractAddress":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"},
      "amount":"1000000000",
      "expiresIn":300,
      "fulfillmentCondition":{
        "targetChainId":42161,
        "targetAsset":{"chainId":42161,"assetType":"native"},
        "targetAmount":"500000000000000000",
        "recipient":"0x1234567890123456789012345678901234567890"
      }
    }
  }'
```

## 🔐 Production Deployment (AWS Nitro Enclave)

See [docs/NITRO_ENCLAVE_GUIDE.md](docs/NITRO_ENCLAVE_GUIDE.md) for detailed instructions.

### Quick Overview

```bash
# 1. Launch EC2 instance with Nitro Enclave enabled (c5.xlarge or larger)

# 2. SSH into instance and run setup script
curl -sSL https://raw.githubusercontent.com/YOUR_USERNAME/tee-resource-lock/main/scripts/setup.sh | bash

# 3. Build enclave image
docker build -t tee-resource-lock:latest -f Dockerfile.enclave .
nitro-cli build-enclave --docker-uri tee-resource-lock:latest --output-file tee-resource-lock.eif

# 4. Run enclave
nitro-cli run-enclave --cpu-count 2 --memory 4096 --eif-path tee-resource-lock.eif

# 5. Start vsock proxy
CID=$(nitro-cli describe-enclaves | jq -r '.[0].EnclaveCID')
vsock-proxy 8080 $CID 5000 &
```

## 📖 API Reference

### Methods

| Method | Description |
|--------|-------------|
| `health` | Health check and enclave info |
| `getBootAttestation` | Get enclave attestation document |
| `createLock` | Create a new resource lock |
| `signLock` | Sign a lock with CCM co-signature |
| `verifyFulfillment` | Verify fulfillment and get settlement UserOp |
| `cancelLock` | Cancel a lock (rage quit) |
| `getLock` | Get lock by ID |
| `getActiveLocks` | Get all active locks for an owner |
| `getLockedBalance` | Get locked balance for an asset |
| `getStateRoot` | Get current Merkle state root |

### Client SDK Usage

```typescript
import { ResourceLockClient, erc20Asset, createFulfillmentCondition } from 'tee-resource-lock';

// Initialize client
const client = new ResourceLockClient({
  apiUrl: 'https://your-enclave-api.com',
});

// Set signer (viem, ethers, or custom)
client.setSigner(yourSigner);

// Create and sign a lock
const { lock, commitment } = await client.createAndSignLock({
  asset: erc20Asset(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), // USDC on Ethereum
  amount: '1000000000', // 1000 USDC
  expiresIn: 300, // 5 minutes
  fulfillmentCondition: createFulfillmentCondition({
    targetChainId: 42161, // Arbitrum
    targetAsset: { chainId: 42161, assetType: 'native' },
    targetAmount: '500000000000000000', // 0.5 ETH
    recipient: userAddress,
  }),
});

console.log('Lock ID:', lock.id);
console.log('Commitment:', commitment);
```

## 🔒 Security Considerations

1. **Never run in debug mode in production** - Debug mode allows console access
2. **Verify PCR values** - Always verify the enclave attestation before trusting commitments
3. **Use proper key management** - Consider using AWS KMS for additional key protection
4. **Implement rate limiting** - Protect against DoS attacks
5. **Monitor and alert** - Set up CloudWatch for enclave monitoring

## 🤝 Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [OneBalance](https://onebalance.io/) - For the CCM architecture inspiration
- [Turnkey](https://turnkey.com/) - For TEE infrastructure patterns
- [AWS Nitro Enclaves](https://aws.amazon.com/ec2/nitro/nitro-enclaves/) - For the secure execution environment

## 📚 Resources

- [OneBalance Resource Locks Documentation](https://docs.onebalance.io/concepts/resource-locks)
- [AWS Nitro Enclaves User Guide](https://docs.aws.amazon.com/enclaves/latest/user/)
- [ERC-4337: Account Abstraction](https://eips.ethereum.org/EIPS/eip-4337)
- [EIP-712: Typed Data Signing](https://eips.ethereum.org/EIPS/eip-712)
