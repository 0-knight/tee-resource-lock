/**
 * Cryptographic Utilities for TEE Resource Lock
 * 
 * Implements:
 * - Keccak256 hashing
 * - ECDSA signing/verification (secp256k1)
 * - EIP-712 typed data hashing
 * - Merkle tree operations
 */

import { createHash, randomBytes } from 'crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

import {
  Address,
  Hash,
  Signature,
  Bytes,
  ECDSASignature,
  EIP712Domain,
  AssetIdentifier,
  FulfillmentCondition,
  LockApprovalMessage,
  LOCK_APPROVAL_TYPES,
} from './types';

// ============================================================================
// Hashing Functions
// ============================================================================

/**
 * Compute Keccak256 hash
 */
export function keccak256(data: Uint8Array | string): Hash {
  const input = typeof data === 'string' 
    ? hexToBytes(data.replace('0x', ''))
    : data;
  return `0x${bytesToHex(keccak_256(input))}` as Hash;
}

/**
 * Hash a string directly (UTF-8 encoded)
 */
export function keccak256String(str: string): Hash {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(str)))}` as Hash;
}

/**
 * ABI encode and hash multiple values
 */
export function encodePacked(...values: (string | number | bigint | boolean)[]): Bytes {
  let result = '0x';
  for (const value of values) {
    if (typeof value === 'string') {
      if (value.startsWith('0x')) {
        result += value.slice(2);
      } else {
        result += Buffer.from(value).toString('hex');
      }
    } else if (typeof value === 'number') {
      result += value.toString(16).padStart(64, '0');
    } else if (typeof value === 'bigint') {
      result += value.toString(16).padStart(64, '0');
    } else if (typeof value === 'boolean') {
      result += value ? '01' : '00';
    }
  }
  return result as Bytes;
}

/**
 * ABI encode with types (simplified version)
 */
export function abiEncode(types: string[], values: any[]): Bytes {
  let encoded = '0x';
  
  for (let i = 0; i < types.length; i++) {
    const type = types[i];
    const value = values[i];
    
    if (type === 'address') {
      encoded += (value as string).slice(2).toLowerCase().padStart(64, '0');
    } else if (type === 'uint256' || type === 'int256') {
      const bn = BigInt(value);
      encoded += bn.toString(16).padStart(64, '0');
    } else if (type === 'bytes32') {
      encoded += (value as string).slice(2).padStart(64, '0');
    } else if (type === 'bool') {
      encoded += value ? '0'.repeat(63) + '1' : '0'.repeat(64);
    } else if (type === 'bytes') {
      const data = (value as string).slice(2);
      const length = data.length / 2;
      encoded += length.toString(16).padStart(64, '0');
      encoded += data.padEnd(Math.ceil(data.length / 64) * 64, '0');
    }
  }
  
  return encoded as Bytes;
}

// ============================================================================
// EIP-712 Typed Data Hashing
// ============================================================================

const EIP712_DOMAIN_TYPEHASH = keccak256String(
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
);

/**
 * Hash the EIP-712 domain separator
 */
export function hashDomain(domain: EIP712Domain): Hash {
  const encoded = abiEncode(
    ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
    [
      EIP712_DOMAIN_TYPEHASH,
      keccak256String(domain.name),
      keccak256String(domain.version),
      domain.chainId,
      domain.verifyingContract,
    ]
  );
  return keccak256(encoded);
}

/**
 * Hash the struct type
 */
export function hashType(typeName: string, types: Record<string, { name: string; type: string }[]>): Hash {
  const typeFields = types[typeName];
  const typeString = `${typeName}(${typeFields.map(f => `${f.type} ${f.name}`).join(',')})`;
  return keccak256String(typeString);
}

/**
 * Hash a LockApproval message
 */
export function hashLockApproval(message: LockApprovalMessage): Hash {
  const LOCK_APPROVAL_TYPEHASH = hashType('LockApproval', LOCK_APPROVAL_TYPES as any);
  
  const encoded = abiEncode(
    ['bytes32', 'bytes32', 'address', 'bytes32', 'uint256', 'uint256', 'uint256', 'bytes32'],
    [
      LOCK_APPROVAL_TYPEHASH,
      message.lockId,
      message.owner,
      message.asset,
      message.amount,
      message.nonce,
      message.expiresAt,
      message.fulfillmentHash,
    ]
  );
  
  return keccak256(encoded);
}

/**
 * Create EIP-712 typed data hash for signing
 */
export function hashTypedData(domain: EIP712Domain, message: LockApprovalMessage): Hash {
  const domainSeparator = hashDomain(domain);
  const structHash = hashLockApproval(message);
  
  // \x19\x01 + domainSeparator + structHash
  const prefix = new Uint8Array([0x19, 0x01]);
  const combined = new Uint8Array(66);
  combined.set(prefix, 0);
  combined.set(hexToBytes(domainSeparator.slice(2)), 2);
  combined.set(hexToBytes(structHash.slice(2)), 34);
  
  return keccak256(combined);
}

// ============================================================================
// ECDSA Signing and Verification
// ============================================================================

/**
 * Sign a message hash with a private key
 */
export function signHash(messageHash: Hash, privateKey: Bytes): Signature {
  const hashBytes = hexToBytes(messageHash.slice(2));
  const privKeyBytes = hexToBytes(privateKey.slice(2));
  
  const sig = secp256k1.sign(hashBytes, privKeyBytes);
  
  // Encode as Ethereum signature (r + s + v)
  const r = sig.r.toString(16).padStart(64, '0');
  const s = sig.s.toString(16).padStart(64, '0');
  const v = (sig.recovery! + 27).toString(16).padStart(2, '0');
  
  return `0x${r}${s}${v}` as Signature;
}

/**
 * Sign EIP-712 typed data
 */
export function signTypedData(
  domain: EIP712Domain,
  message: LockApprovalMessage,
  privateKey: Bytes
): Signature {
  const hash = hashTypedData(domain, message);
  return signHash(hash, privateKey);
}

/**
 * Parse an Ethereum signature into components
 */
export function parseSignature(signature: Signature): ECDSASignature {
  const sig = signature.slice(2);
  return {
    r: `0x${sig.slice(0, 64)}` as Hash,
    s: `0x${sig.slice(64, 128)}` as Hash,
    v: parseInt(sig.slice(128, 130), 16),
    yParity: parseInt(sig.slice(128, 130), 16) === 27 ? 0 : 1,
  };
}

/**
 * Recover signer address from signature
 */
export function recoverAddress(messageHash: Hash, signature: Signature): Address {
  const hashBytes = hexToBytes(messageHash.slice(2));
  const parsed = parseSignature(signature);
  
  const sig = new secp256k1.Signature(
    BigInt(parsed.r),
    BigInt(parsed.s)
  ).addRecoveryBit(parsed.yParity);
  
  const pubKey = sig.recoverPublicKey(hashBytes);
  const pubKeyBytes = pubKey.toRawBytes(false).slice(1); // Remove 0x04 prefix
  const addressHash = keccak256(pubKeyBytes);
  
  return `0x${addressHash.slice(-40)}` as Address;
}

/**
 * Verify a signature against expected signer
 */
export function verifySignature(
  messageHash: Hash,
  signature: Signature,
  expectedSigner: Address
): boolean {
  try {
    const recovered = recoverAddress(messageHash, signature);
    return recovered.toLowerCase() === expectedSigner.toLowerCase();
  } catch {
    return false;
  }
}

// ============================================================================
// Key Generation
// ============================================================================

/**
 * Generate a new random private key
 */
export function generatePrivateKey(): Bytes {
  const privKey = secp256k1.utils.randomPrivateKey();
  return `0x${bytesToHex(privKey)}` as Bytes;
}

/**
 * Derive public key (address) from private key
 */
export function privateKeyToAddress(privateKey: Bytes): Address {
  const privKeyBytes = hexToBytes(privateKey.slice(2));
  const pubKey = secp256k1.getPublicKey(privKeyBytes, false).slice(1);
  const addressHash = keccak256(pubKey);
  return `0x${addressHash.slice(-40)}` as Address;
}

/**
 * Generate a unique ID
 */
export function generateId(): Hash {
  const random = randomBytes(32);
  return `0x${random.toString('hex')}` as Hash;
}

// ============================================================================
// Merkle Tree Operations
// ============================================================================

/**
 * Simple Merkle tree for state root computation
 */
export class MerkleTree {
  private leaves: Hash[];
  private layers: Hash[][];

  constructor(leaves: Hash[] = []) {
    this.leaves = leaves;
    this.layers = [];
    if (leaves.length > 0) {
      this.buildTree();
    }
  }

  private buildTree(): void {
    this.layers = [this.leaves];
    
    while (this.layers[this.layers.length - 1].length > 1) {
      const currentLayer = this.layers[this.layers.length - 1];
      const nextLayer: Hash[] = [];
      
      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i];
        const right = currentLayer[i + 1] || left;
        
        // Sort to ensure consistent ordering
        const [a, b] = left < right ? [left, right] : [right, left];
        const combined = encodePacked(a, b);
        nextLayer.push(keccak256(combined));
      }
      
      this.layers.push(nextLayer);
    }
  }

  getRoot(): Hash {
    if (this.layers.length === 0) {
      return '0x' + '0'.repeat(64) as Hash;
    }
    return this.layers[this.layers.length - 1][0];
  }

  getProof(index: number): Hash[] {
    const proof: Hash[] = [];
    let idx = index;
    
    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      
      if (siblingIdx < layer.length) {
        proof.push(layer[siblingIdx]);
      }
      
      idx = Math.floor(idx / 2);
    }
    
    return proof;
  }

  static verifyProof(leaf: Hash, proof: Hash[], root: Hash): boolean {
    let computedHash = leaf;
    
    for (const proofElement of proof) {
      const [a, b] = computedHash < proofElement 
        ? [computedHash, proofElement] 
        : [proofElement, computedHash];
      computedHash = keccak256(encodePacked(a, b));
    }
    
    return computedHash === root;
  }

  addLeaf(leaf: Hash): void {
    this.leaves.push(leaf);
    this.buildTree();
  }

  removeLeaf(leaf: Hash): boolean {
    const index = this.leaves.indexOf(leaf);
    if (index === -1) return false;
    
    this.leaves.splice(index, 1);
    if (this.leaves.length > 0) {
      this.buildTree();
    } else {
      this.layers = [];
    }
    return true;
  }
}

// ============================================================================
// Asset and Condition Hashing
// ============================================================================

/**
 * Hash an AssetIdentifier for use in signatures
 */
export function hashAsset(asset: AssetIdentifier): Hash {
  const encoded = abiEncode(
    ['uint256', 'uint8', 'address', 'uint256'],
    [
      asset.chainId,
      asset.assetType === 'native' ? 0 : asset.assetType === 'erc20' ? 1 : asset.assetType === 'erc721' ? 2 : 3,
      asset.contractAddress || '0x0000000000000000000000000000000000000000',
      asset.tokenId || 0n,
    ]
  );
  return keccak256(encoded);
}

/**
 * Hash a FulfillmentCondition for use in signatures
 */
export function hashFulfillmentCondition(condition: FulfillmentCondition): Hash {
  const assetHash = hashAsset(condition.targetAsset);
  const encoded = abiEncode(
    ['uint256', 'bytes32', 'uint256', 'address', 'bytes32'],
    [
      condition.targetChainId,
      assetHash,
      condition.targetAmount,
      condition.recipient,
      condition.executionData ? keccak256(condition.executionData) : '0x' + '0'.repeat(64),
    ]
  );
  return keccak256(encoded);
}

/**
 * Generate a unique lock ID
 */
export function generateLockId(
  owner: Address,
  asset: AssetIdentifier,
  amount: bigint,
  nonce: bigint,
  timestamp: number
): Hash {
  const assetHash = hashAsset(asset);
  const encoded = abiEncode(
    ['address', 'bytes32', 'uint256', 'uint256', 'uint256'],
    [owner, assetHash, amount, nonce, timestamp]
  );
  return keccak256(encoded);
}
