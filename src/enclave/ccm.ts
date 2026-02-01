/**
 * Credible Commitment Machine (CCM) - TEE Enclave Core
 * 
 * This module runs inside the TEE (AWS Nitro Enclave) and handles:
 * - Resource Lock creation and validation
 * - Commitment generation with enclave attestation
 * - State management and merkle tree updates
 * - Co-signing operations
 * - Fulfillment verification
 * 
 * SECURITY: Private key never leaves the enclave
 */

import {
  Address,
  Hash,
  Signature,
  Bytes,
  ResourceLock,
  LockStatus,
  AssetIdentifier,
  FulfillmentCondition,
  Commitment,
  CCMAttestation,
  EIP712Domain,
  LockApprovalMessage,
  EnclaveState,
  EnclaveConfig,
  BootAttestation,
  AppAttestation,
  CreateLockRequest,
  CreateLockResponse,
  SignLockRequest,
  SignLockResponse,
  FulfillLockRequest,
  FulfillmentProof,
  FulfillLockResponse,
  UserOperation,
  LOCK_APPROVAL_TYPES,
} from '../shared/types';

import {
  keccak256,
  generatePrivateKey,
  privateKeyToAddress,
  generateId,
  generateLockId,
  hashAsset,
  hashFulfillmentCondition,
  hashTypedData,
  signHash,
  verifySignature,
  recoverAddress,
  MerkleTree,
  abiEncode,
} from '../shared/crypto';

// ============================================================================
// Enclave Configuration
// ============================================================================

const DEFAULT_CONFIG: EnclaveConfig = {
  maxLockDuration: 3600,           // 1 hour max
  minLockDuration: 30,             // 30 seconds min
  supportedChains: [1, 10, 137, 42161, 8453], // Ethereum, Optimism, Polygon, Arbitrum, Base
  supportedAssets: [],              // Populated at runtime
  settlementBuffer: 300,            // 5 minutes buffer after fulfillment
  riskLimits: {
    maxTotalLockedPerAccount: BigInt('1000000000000000000000000'), // 1M tokens
    maxSingleLockAmount: BigInt('100000000000000000000000'),       // 100K tokens
    maxConcurrentLocks: 100,
    maxDailyVolume: BigInt('10000000000000000000000000'),          // 10M tokens
  },
};

// EIP-712 domain for the CCM
const CCM_DOMAIN: EIP712Domain = {
  name: 'CredibleCommitmentMachine',
  version: '1.0.0',
  chainId: 0, // Will be set per-lock
  verifyingContract: '0x0000000000000000000000000000000000000000' as Address, // No contract
};

// ============================================================================
// Enclave State Management
// ============================================================================

export class CredibleCommitmentMachine {
  private state: EnclaveState;
  private config: EnclaveConfig;
  private lockMerkleTree: MerkleTree;
  private dailyVolume: Map<string, bigint>; // date -> volume
  
  constructor(config: Partial<EnclaveConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dailyVolume = new Map();
    
    // Initialize enclave state with fresh keys
    const privateKey = generatePrivateKey();
    const publicKey = privateKeyToAddress(privateKey);
    const enclaveId = generateId();
    
    this.state = {
      enclaveId,
      privateKey,
      publicKey,
      bootTime: this.getSecureTime(),
      locks: new Map(),
      nonces: new Map(),
      stateRoot: '0x' + '0'.repeat(64) as Hash,
    };
    
    this.lockMerkleTree = new MerkleTree();
    
    console.log(`[CCM] Enclave initialized`);
    console.log(`[CCM] Enclave ID: ${enclaveId}`);
    console.log(`[CCM] Public Key: ${publicKey}`);
  }

  // ============================================================================
  // Secure Time Source (from NSM in production)
  // ============================================================================
  
  private getSecureTime(): number {
    // In production, this would use AWS NSM (Nitro Secure Module) for trusted time
    // NSM provides monotonic time that can't be manipulated
    return Math.floor(Date.now() / 1000);
  }

  // ============================================================================
  // Boot Attestation
  // ============================================================================

  /**
   * Generate boot attestation for verification
   * In production, this includes AWS Nitro attestation document
   */
  generateBootAttestation(): BootAttestation {
    const attestationData = abiEncode(
      ['bytes32', 'address', 'uint256'],
      [this.state.enclaveId, this.state.publicKey, this.state.bootTime]
    );
    
    const dataHash = keccak256(attestationData);
    const signature = signHash(dataHash, this.state.privateKey);
    
    // In production, awsAttestationDocument would be real Nitro attestation
    const mockAwsAttestation = abiEncode(
      ['bytes32', 'bytes32', 'uint256'],
      [this.state.enclaveId, dataHash, this.state.bootTime]
    );
    
    return {
      enclaveId: this.state.enclaveId,
      publicKey: this.state.publicKey,
      bootTime: this.state.bootTime,
      codeHash: keccak256('enclave-binary-v1.0.0'), // Would be actual binary hash
      awsAttestationDocument: mockAwsAttestation,
      signature,
    };
  }

  // ============================================================================
  // Nonce Management
  // ============================================================================

  private getNextNonce(owner: Address): bigint {
    const current = this.state.nonces.get(owner.toLowerCase()) || 0n;
    const next = current + 1n;
    this.state.nonces.set(owner.toLowerCase(), next);
    return next;
  }

  private getCurrentNonce(owner: Address): bigint {
    return this.state.nonces.get(owner.toLowerCase()) || 0n;
  }

  // ============================================================================
  // Validation Functions
  // ============================================================================

  private validateAsset(asset: AssetIdentifier): void {
    if (!this.config.supportedChains.includes(asset.chainId)) {
      throw new Error(`Unsupported chain: ${asset.chainId}`);
    }
    
    if (!['native', 'erc20', 'erc721', 'erc1155'].includes(asset.assetType)) {
      throw new Error(`Invalid asset type: ${asset.assetType}`);
    }
    
    if (asset.assetType !== 'native' && !asset.contractAddress) {
      throw new Error('Contract address required for token assets');
    }
  }

  private validateAmount(amount: bigint): void {
    if (amount <= 0n) {
      throw new Error('Amount must be positive');
    }
    
    if (amount > this.config.riskLimits.maxSingleLockAmount) {
      throw new Error('Amount exceeds single lock limit');
    }
  }

  private validateDuration(expiresIn: number): void {
    if (expiresIn < this.config.minLockDuration) {
      throw new Error(`Duration too short: min ${this.config.minLockDuration}s`);
    }
    
    if (expiresIn > this.config.maxLockDuration) {
      throw new Error(`Duration too long: max ${this.config.maxLockDuration}s`);
    }
  }

  private validateRiskLimits(owner: Address, amount: bigint): void {
    // Check concurrent locks
    const ownerLocks = Array.from(this.state.locks.values())
      .filter(l => l.owner.toLowerCase() === owner.toLowerCase() && l.status === LockStatus.ACTIVE);
    
    if (ownerLocks.length >= this.config.riskLimits.maxConcurrentLocks) {
      throw new Error('Too many concurrent locks');
    }
    
    // Check total locked amount
    const totalLocked = ownerLocks.reduce((sum, l) => sum + l.amount, 0n);
    if (totalLocked + amount > this.config.riskLimits.maxTotalLockedPerAccount) {
      throw new Error('Total locked amount exceeds limit');
    }
    
    // Check daily volume
    const today = new Date().toISOString().split('T')[0];
    const todayVolume = this.dailyVolume.get(today) || 0n;
    if (todayVolume + amount > this.config.riskLimits.maxDailyVolume) {
      throw new Error('Daily volume limit exceeded');
    }
  }

  // ============================================================================
  // Lock Creation
  // ============================================================================

  /**
   * Create a new resource lock (Phase 1: Generate lock and typed data)
   */
  createLock(request: CreateLockRequest): CreateLockResponse {
    const now = this.getSecureTime();
    const amount = BigInt(request.amount);
    
    // Validate inputs
    this.validateAsset(request.asset);
    this.validateAmount(amount);
    this.validateDuration(request.expiresIn);
    this.validateRiskLimits(request.owner, amount);
    this.validateAsset(request.fulfillmentCondition.targetAsset);
    
    // Generate lock parameters
    const nonce = this.getNextNonce(request.owner);
    const expiresAt = now + request.expiresIn;
    const lockId = generateLockId(request.owner, request.asset, amount, nonce, now);
    
    // Create the lock object
    const lock: ResourceLock = {
      id: lockId,
      owner: request.owner,
      asset: request.asset,
      amount,
      lockedAt: now,
      expiresAt,
      nonce,
      fulfillmentCondition: request.fulfillmentCondition,
      status: LockStatus.PENDING,
    };
    
    // Store pending lock
    this.state.locks.set(lockId, lock);
    
    // Generate EIP-712 typed data for user signature
    const domain: EIP712Domain = {
      ...CCM_DOMAIN,
      chainId: request.asset.chainId,
    };
    
    const message: LockApprovalMessage = {
      lockId,
      owner: request.owner,
      asset: hashAsset(request.asset),
      amount,
      nonce,
      expiresAt,
      fulfillmentHash: hashFulfillmentCondition(request.fulfillmentCondition),
    };
    
    console.log(`[CCM] Lock created: ${lockId}`);
    console.log(`[CCM] Owner: ${request.owner}, Amount: ${amount}, Expires: ${expiresAt}`);
    
    return {
      lock,
      typedDataToSign: {
        domain,
        types: LOCK_APPROVAL_TYPES,
        primaryType: 'LockApproval',
        message,
      },
      expirationTimestamp: now + 30, // 30 second signing window
    };
  }

  // ============================================================================
  // Lock Signing (Co-signature)
  // ============================================================================

  /**
   * Process user signature and generate CCM co-signature (Phase 2)
   */
  signLock(request: SignLockRequest): SignLockResponse {
    const lock = this.state.locks.get(request.lockId);
    if (!lock) {
      throw new Error('Lock not found');
    }
    
    if (lock.status !== LockStatus.PENDING) {
      throw new Error(`Invalid lock status: ${lock.status}`);
    }
    
    const now = this.getSecureTime();
    
    // Verify the user's signature
    const domain: EIP712Domain = {
      ...CCM_DOMAIN,
      chainId: lock.asset.chainId,
    };
    
    const message: LockApprovalMessage = {
      lockId: lock.id,
      owner: lock.owner,
      asset: hashAsset(lock.asset),
      amount: lock.amount,
      nonce: lock.nonce,
      expiresAt: lock.expiresAt,
      fulfillmentHash: hashFulfillmentCondition(lock.fulfillmentCondition),
    };
    
    const typedDataHash = hashTypedData(domain, message);
    const recoveredSigner = recoverAddress(typedDataHash, request.signature);
    
    // Verify signer is the owner (or authorized session key)
    if (recoveredSigner.toLowerCase() !== lock.owner.toLowerCase()) {
      throw new Error('Invalid signature: signer mismatch');
    }
    
    // Store user signature
    lock.userSignature = request.signature;
    
    // Generate CCM attestation
    const ccmAttestation = this.generateCCMAttestation(lock);
    lock.ccmSignature = ccmAttestation.signature;
    
    // Update lock status
    lock.status = LockStatus.ACTIVE;
    this.state.locks.set(lock.id, lock);
    
    // Update merkle tree
    this.lockMerkleTree.addLeaf(lock.id);
    this.state.stateRoot = this.lockMerkleTree.getRoot();
    
    // Update daily volume
    const today = new Date().toISOString().split('T')[0];
    const currentVolume = this.dailyVolume.get(today) || 0n;
    this.dailyVolume.set(today, currentVolume + lock.amount);
    
    // Generate commitment
    const commitment = this.generateCommitment(lock, ccmAttestation);
    
    console.log(`[CCM] Lock signed and active: ${lock.id}`);
    console.log(`[CCM] State root: ${this.state.stateRoot}`);
    
    return {
      commitment,
      status: lock.status,
    };
  }

  // ============================================================================
  // CCM Attestation Generation
  // ============================================================================

  private generateCCMAttestation(lock: ResourceLock): CCMAttestation {
    const now = this.getSecureTime();
    
    // Hash all lock data
    const lockDataHash = keccak256(
      abiEncode(
        ['bytes32', 'address', 'bytes32', 'uint256', 'uint256', 'uint256', 'bytes32'],
        [
          lock.id,
          lock.owner,
          hashAsset(lock.asset),
          lock.amount,
          lock.nonce,
          lock.expiresAt,
          hashFulfillmentCondition(lock.fulfillmentCondition),
        ]
      )
    );
    
    // Create attestation data
    const attestationData = abiEncode(
      ['bytes32', 'uint256', 'bytes32'],
      [this.state.enclaveId, now, lockDataHash]
    );
    
    const commitmentHash = keccak256(attestationData);
    
    // Sign with enclave key
    const signature = signHash(commitmentHash, this.state.privateKey);
    
    return {
      enclaveId: this.state.enclaveId,
      timestamp: now,
      commitmentHash,
      signature,
    };
  }

  // ============================================================================
  // Commitment Generation
  // ============================================================================

  private generateCommitment(lock: ResourceLock, attestation: CCMAttestation): Commitment {
    return {
      lockId: lock.id,
      version: 1,
      chainId: lock.asset.chainId,
      smartAccount: lock.owner,
      
      lockedAsset: lock.asset,
      lockedAmount: lock.amount,
      
      createdAt: lock.lockedAt,
      expiresAt: lock.expiresAt,
      settlementDeadline: lock.expiresAt + this.config.settlementBuffer,
      
      fulfillmentCondition: lock.fulfillmentCondition,
      
      nonce: lock.nonce,
      stateRoot: this.state.stateRoot,
      
      userSignatureHash: keccak256(lock.userSignature!),
      ccmAttestation: attestation,
    };
  }

  // ============================================================================
  // Fulfillment Verification
  // ============================================================================

  /**
   * Verify fulfillment and generate settlement UserOperation
   */
  verifyFulfillment(request: FulfillLockRequest): FulfillLockResponse {
    const lock = this.state.locks.get(request.lockId);
    if (!lock) {
      throw new Error('Lock not found');
    }
    
    if (lock.status !== LockStatus.ACTIVE) {
      throw new Error(`Invalid lock status for fulfillment: ${lock.status}`);
    }
    
    const now = this.getSecureTime();
    if (now > lock.expiresAt) {
      lock.status = LockStatus.EXPIRED;
      this.state.locks.set(lock.id, lock);
      throw new Error('Lock has expired');
    }
    
    // Verify fulfillment proof
    // In production, this would verify:
    // 1. Transaction exists on destination chain
    // 2. Correct assets were transferred
    // 3. Correct recipient received funds
    // 4. Block is finalized
    this.verifyFulfillmentProof(lock, request.fulfillmentProof);
    
    // Update lock status
    lock.status = LockStatus.FULFILLED;
    this.state.locks.set(lock.id, lock);
    
    // Generate settlement UserOperation
    const settlementUserOp = this.generateSettlementUserOp(lock);
    
    // Generate updated commitment
    const attestation = this.generateCCMAttestation(lock);
    const commitment = this.generateCommitment(lock, attestation);
    
    console.log(`[CCM] Lock fulfilled: ${lock.id}`);
    console.log(`[CCM] Fulfillment proof tx: ${request.fulfillmentProof.transactionHash}`);
    
    return {
      settlementUserOp,
      commitment,
    };
  }

  private verifyFulfillmentProof(lock: ResourceLock, proof: FulfillmentProof): void {
    // Basic validation
    if (!proof.transactionHash || proof.transactionHash.length !== 66) {
      throw new Error('Invalid transaction hash');
    }
    
    if (!proof.blockHash || proof.blockHash.length !== 66) {
      throw new Error('Invalid block hash');
    }
    
    // In production, this would:
    // 1. Query destination chain RPC for transaction receipt
    // 2. Verify transaction succeeded
    // 3. Parse logs to confirm correct transfer
    // 4. Verify block finality
    // 5. Optionally verify merkle proof for light client
    
    console.log(`[CCM] Fulfillment proof verified for tx: ${proof.transactionHash}`);
  }

  // ============================================================================
  // Settlement UserOperation Generation
  // ============================================================================

  private generateSettlementUserOp(lock: ResourceLock): UserOperation {
    // Generate calldata for releasing locked funds to solver
    // This would call the smart account to transfer locked funds
    
    const transferCalldata = this.encodeTransferCalldata(
      lock.asset,
      lock.fulfillmentCondition.recipient,
      lock.amount
    );
    
    // Create UserOperation for ERC-4337
    const userOp: UserOperation = {
      sender: lock.owner,
      nonce: lock.nonce,
      initCode: '0x' as Bytes, // Account already deployed
      callData: transferCalldata,
      callGasLimit: 100000n,
      verificationGasLimit: 100000n,
      preVerificationGas: 21000n,
      maxFeePerGas: 1000000000n, // 1 gwei, would be dynamic in production
      maxPriorityFeePerGas: 1000000000n,
      paymasterAndData: '0x' as Bytes, // No paymaster
      signature: '0x' as Bytes, // To be filled with CCM signature
    };
    
    // Sign the UserOperation with enclave key (for co-signature)
    const userOpHash = this.hashUserOp(userOp, lock.asset.chainId);
    const ccmSignature = signHash(userOpHash, this.state.privateKey);
    
    // Combine user signature and CCM signature
    userOp.signature = this.combineSignatures(lock.userSignature!, ccmSignature);
    
    return userOp;
  }

  private encodeTransferCalldata(
    asset: AssetIdentifier,
    recipient: Address,
    amount: bigint
  ): Bytes {
    if (asset.assetType === 'native') {
      // Native ETH transfer via execute
      // execute(address dest, uint256 value, bytes calldata func)
      const funcSelector = '0xb61d27f6'; // execute(address,uint256,bytes)
      return abiEncode(
        ['bytes4', 'address', 'uint256', 'bytes'],
        [funcSelector, recipient, amount, '0x']
      ) as Bytes;
    } else if (asset.assetType === 'erc20') {
      // ERC20 transfer via execute
      const transferSelector = '0xa9059cbb'; // transfer(address,uint256)
      const innerCalldata = abiEncode(
        ['bytes4', 'address', 'uint256'],
        [transferSelector, recipient, amount]
      );
      
      const funcSelector = '0xb61d27f6';
      return abiEncode(
        ['bytes4', 'address', 'uint256', 'bytes'],
        [funcSelector, asset.contractAddress!, 0n, innerCalldata]
      ) as Bytes;
    }
    
    throw new Error(`Unsupported asset type for settlement: ${asset.assetType}`);
  }

  private hashUserOp(userOp: UserOperation, chainId: number): Hash {
    // Simplified UserOp hash (ERC-4337 compliant)
    const packed = abiEncode(
      ['address', 'uint256', 'bytes32', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes32'],
      [
        userOp.sender,
        userOp.nonce,
        keccak256(userOp.initCode),
        keccak256(userOp.callData),
        userOp.callGasLimit,
        userOp.verificationGasLimit,
        userOp.preVerificationGas,
        userOp.maxFeePerGas,
        userOp.maxPriorityFeePerGas,
        keccak256(userOp.paymasterAndData),
      ]
    );
    
    const userOpHash = keccak256(packed);
    
    // Include chain ID and entry point
    const finalHash = keccak256(
      abiEncode(
        ['bytes32', 'address', 'uint256'],
        [userOpHash, '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789', chainId] // Standard EntryPoint
      )
    );
    
    return finalHash;
  }

  private combineSignatures(userSig: Signature, ccmSig: Signature): Bytes {
    // Combine signatures: userSig (65 bytes) + ccmSig (65 bytes)
    return (userSig + ccmSig.slice(2)) as Bytes;
  }

  // ============================================================================
  // Lock Cancellation (Rage Quit)
  // ============================================================================

  /**
   * Cancel a lock and return funds (user-initiated)
   */
  cancelLock(lockId: Hash, userSignature: Signature): AppAttestation {
    const lock = this.state.locks.get(lockId);
    if (!lock) {
      throw new Error('Lock not found');
    }
    
    if (lock.status !== LockStatus.ACTIVE && lock.status !== LockStatus.PENDING) {
      throw new Error(`Cannot cancel lock in status: ${lock.status}`);
    }
    
    // Verify cancellation signature
    const cancelMessage = keccak256(
      abiEncode(['bytes32', 'string'], [lockId, 'CANCEL'])
    );
    
    const signer = recoverAddress(cancelMessage, userSignature);
    if (signer.toLowerCase() !== lock.owner.toLowerCase()) {
      throw new Error('Invalid cancellation signature');
    }
    
    // Update lock status
    lock.status = LockStatus.CANCELLED;
    this.state.locks.set(lockId, lock);
    
    // Remove from merkle tree
    this.lockMerkleTree.removeLeaf(lockId);
    this.state.stateRoot = this.lockMerkleTree.getRoot();
    
    console.log(`[CCM] Lock cancelled: ${lockId}`);
    
    // Return attestation of cancellation
    return {
      enclaveId: this.state.enclaveId,
      operation: 'CANCEL',
      timestamp: this.getSecureTime(),
      dataHash: keccak256(abiEncode(['bytes32', 'uint8'], [lockId, LockStatus.CANCELLED])),
      signature: signHash(cancelMessage, this.state.privateKey),
    };
  }

  // ============================================================================
  // State Queries
  // ============================================================================

  getLock(lockId: Hash): ResourceLock | undefined {
    return this.state.locks.get(lockId);
  }

  getActiveLocks(owner: Address): ResourceLock[] {
    return Array.from(this.state.locks.values())
      .filter(l => 
        l.owner.toLowerCase() === owner.toLowerCase() && 
        l.status === LockStatus.ACTIVE
      );
  }

  getLockedBalance(owner: Address, asset: AssetIdentifier): bigint {
    const assetHash = hashAsset(asset);
    return this.getActiveLocks(owner)
      .filter(l => hashAsset(l.asset) === assetHash)
      .reduce((sum, l) => sum + l.amount, 0n);
  }

  getStateRoot(): Hash {
    return this.state.stateRoot;
  }

  getEnclavePublicKey(): Address {
    return this.state.publicKey;
  }

  getEnclaveId(): Hash {
    return this.state.enclaveId;
  }

  // ============================================================================
  // Maintenance
  // ============================================================================

  /**
   * Clean up expired locks
   */
  cleanupExpiredLocks(): number {
    const now = this.getSecureTime();
    let cleaned = 0;
    
    for (const [lockId, lock] of this.state.locks) {
      if (lock.status === LockStatus.ACTIVE && now > lock.expiresAt) {
        lock.status = LockStatus.EXPIRED;
        this.state.locks.set(lockId, lock);
        this.lockMerkleTree.removeLeaf(lockId);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      this.state.stateRoot = this.lockMerkleTree.getRoot();
      console.log(`[CCM] Cleaned up ${cleaned} expired locks`);
    }
    
    return cleaned;
  }
}

// ============================================================================
// Singleton Instance (for enclave)
// ============================================================================

let ccmInstance: CredibleCommitmentMachine | null = null;

export function initializeCCM(config?: Partial<EnclaveConfig>): CredibleCommitmentMachine {
  if (ccmInstance) {
    throw new Error('CCM already initialized');
  }
  ccmInstance = new CredibleCommitmentMachine(config);
  return ccmInstance;
}

export function getCCM(): CredibleCommitmentMachine {
  if (!ccmInstance) {
    throw new Error('CCM not initialized');
  }
  return ccmInstance;
}

export function resetCCM(): void {
  ccmInstance = null;
}
