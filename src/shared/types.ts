/**
 * TEE Resource Lock System - Shared Types
 * 
 * Core data structures for the Credible Commitment Machine (CCM)
 * Based on OneBalance architecture with EVM-focused implementation
 */

// ============================================================================
// Core Cryptographic Types
// ============================================================================

export type Address = `0x${string}`;
export type Hash = `0x${string}`;
export type Signature = `0x${string}`;
export type Bytes = `0x${string}`;

export interface ECDSASignature {
  r: Hash;
  s: Hash;
  v: number;
  yParity: 0 | 1;
}

// ============================================================================
// Resource Lock Core Types
// ============================================================================

export interface ResourceLock {
  id: Hash;                          // Keccak256(lockData)
  owner: Address;                    // Smart account address
  asset: AssetIdentifier;            // CAIP-19 format
  amount: bigint;                    // Amount in wei/smallest unit
  lockedAt: number;                  // Unix timestamp
  expiresAt: number;                 // Unix timestamp
  nonce: bigint;                     // Sequential nonce for replay protection
  fulfillmentCondition: FulfillmentCondition;
  status: LockStatus;
  ccmSignature?: Signature;          // CCM co-signature
  userSignature?: Signature;         // User's EIP-712 signature
}

export enum LockStatus {
  PENDING = 'PENDING',               // Lock requested, awaiting CCM validation
  ACTIVE = 'ACTIVE',                 // Lock confirmed, funds committed
  FULFILLED = 'FULFILLED',           // Condition met, awaiting settlement
  SETTLED = 'SETTLED',               // On-chain settlement complete
  EXPIRED = 'EXPIRED',               // Lock expired without fulfillment
  CANCELLED = 'CANCELLED',           // User rage-quit
}

export interface AssetIdentifier {
  chainId: number;                   // EVM chain ID
  assetType: 'native' | 'erc20' | 'erc721' | 'erc1155';
  contractAddress?: Address;         // For token assets
  tokenId?: bigint;                  // For NFTs
}

export interface FulfillmentCondition {
  targetChainId: number;             // Destination chain
  targetAsset: AssetIdentifier;      // Expected asset to receive
  targetAmount: bigint;              // Expected amount
  recipient: Address;                // Who receives on destination
  executionData?: Bytes;             // Optional calldata for complex conditions
}

// ============================================================================
// Commitment Types (CCM Output)
// ============================================================================

export interface Commitment {
  lockId: Hash;
  version: number;                   // Protocol version
  chainId: number;                   // Source chain
  smartAccount: Address;             // User's smart account
  
  // Lock details
  lockedAsset: AssetIdentifier;
  lockedAmount: bigint;
  
  // Timing
  createdAt: number;
  expiresAt: number;
  settlementDeadline: number;        // Must settle by this time
  
  // Fulfillment
  fulfillmentCondition: FulfillmentCondition;
  
  // Cryptographic proofs
  nonce: bigint;
  stateRoot: Hash;                   // Merkle root of all active locks
  
  // Signatures
  userSignatureHash: Hash;           // Hash of user's EIP-712 signature
  ccmAttestation: CCMAttestation;
}

export interface CCMAttestation {
  enclaveId: Hash;                   // Unique enclave identifier
  timestamp: number;                 // TEE secure time
  commitmentHash: Hash;              // Keccak256(commitment data)
  signature: Signature;              // Enclave's ECDSA signature
  attestationDocument?: Bytes;       // AWS Nitro attestation (optional for verification)
}

// ============================================================================
// EIP-712 Typed Data Structures
// ============================================================================

export interface EIP712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

export interface LockApprovalMessage {
  lockId: Hash;
  owner: Address;
  asset: Hash;                       // Keccak256(encoded AssetIdentifier)
  amount: bigint;
  nonce: bigint;
  expiresAt: number;
  fulfillmentHash: Hash;             // Keccak256(encoded FulfillmentCondition)
}

export const LOCK_APPROVAL_TYPES = {
  LockApproval: [
    { name: 'lockId', type: 'bytes32' },
    { name: 'owner', type: 'address' },
    { name: 'asset', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
    { name: 'fulfillmentHash', type: 'bytes32' },
  ],
} as const;

// ============================================================================
// ERC-4337 UserOperation Types
// ============================================================================

export interface UserOperation {
  sender: Address;
  nonce: bigint;
  initCode: Bytes;
  callData: Bytes;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData: Bytes;
  signature: Bytes;
}

export interface PackedUserOperation {
  sender: Address;
  nonce: bigint;
  initCode: Bytes;
  callData: Bytes;
  accountGasLimits: Bytes;           // packed callGasLimit + verificationGasLimit
  preVerificationGas: bigint;
  gasFees: Bytes;                    // packed maxPriorityFeePerGas + maxFeePerGas
  paymasterAndData: Bytes;
  signature: Bytes;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface CreateLockRequest {
  owner: Address;
  sessionKey: Address;               // For delegated signing
  asset: AssetIdentifier;
  amount: string;                    // String to handle large numbers
  expiresIn: number;                 // Seconds from now
  fulfillmentCondition: FulfillmentCondition;
}

export interface CreateLockResponse {
  lock: ResourceLock;
  typedDataToSign: {
    domain: EIP712Domain;
    types: typeof LOCK_APPROVAL_TYPES;
    primaryType: 'LockApproval';
    message: LockApprovalMessage;
  };
  expirationTimestamp: number;
}

export interface SignLockRequest {
  lockId: Hash;
  signature: Signature;
}

export interface SignLockResponse {
  commitment: Commitment;
  status: LockStatus;
}

export interface FulfillLockRequest {
  lockId: Hash;
  fulfillmentProof: FulfillmentProof;
}

export interface FulfillmentProof {
  transactionHash: Hash;             // Tx on destination chain
  blockNumber: number;
  blockHash: Hash;
  logIndex: number;
  merkleProof?: Hash[];              // For light client verification
}

export interface FulfillLockResponse {
  settlementUserOp: UserOperation;
  commitment: Commitment;
}

export interface GetBalanceRequest {
  owner: Address;
  chainId?: number;
  assetType?: string;
}

export interface BalanceResponse {
  total: string;
  available: string;
  locked: string;
  locks: ResourceLock[];
}

// ============================================================================
// Enclave Internal Types
// ============================================================================

export interface EnclaveState {
  enclaveId: Hash;
  privateKey: Bytes;                 // Enclave's signing key (never leaves TEE)
  publicKey: Address;
  bootTime: number;
  locks: Map<Hash, ResourceLock>;
  nonces: Map<Address, bigint>;      // Per-account nonces
  stateRoot: Hash;
}

export interface EnclaveConfig {
  maxLockDuration: number;           // Max seconds a lock can be held
  minLockDuration: number;           // Min seconds
  supportedChains: number[];
  supportedAssets: AssetIdentifier[];
  settlementBuffer: number;          // Extra time for settlement after fulfillment
  riskLimits: RiskLimits;
}

export interface RiskLimits {
  maxTotalLockedPerAccount: bigint;
  maxSingleLockAmount: bigint;
  maxConcurrentLocks: number;
  maxDailyVolume: bigint;
}

// ============================================================================
// Attestation Types
// ============================================================================

export interface BootAttestation {
  enclaveId: Hash;
  publicKey: Address;
  bootTime: number;
  codeHash: Hash;                    // Hash of enclave binary
  awsAttestationDocument: Bytes;     // Raw AWS Nitro attestation
  signature: Signature;
}

export interface AppAttestation {
  enclaveId: Hash;
  operation: string;
  timestamp: number;
  dataHash: Hash;
  signature: Signature;
}
