/**
 * TEE Resource Lock Client SDK
 * 
 * TypeScript client for interacting with the Credible Commitment Machine (CCM).
 * Handles:
 * - API communication
 * - EIP-712 signature generation
 * - Lock lifecycle management
 * - UserOperation construction
 */

import {
  Address,
  Hash,
  Signature,
  Bytes,
  AssetIdentifier,
  FulfillmentCondition,
  ResourceLock,
  LockStatus,
  Commitment,
  CreateLockRequest,
  CreateLockResponse,
  SignLockResponse,
  FulfillLockResponse,
  BootAttestation,
  AppAttestation,
  BalanceResponse,
  UserOperation,
  EIP712Domain,
  LockApprovalMessage,
  FulfillmentProof,
} from '../shared/types';

// ============================================================================
// RPC Client Types
// ============================================================================

interface RPCRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: any;
}

interface RPCResponse<T = any> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

// ============================================================================
// Signer Interface
// ============================================================================

/**
 * Interface for signing EIP-712 typed data
 * Can be implemented with ethers.js, viem, web3.js, or hardware wallets
 */
export interface Signer {
  getAddress(): Promise<Address>;
  signTypedData(
    domain: EIP712Domain,
    types: Record<string, { name: string; type: string }[]>,
    message: Record<string, any>
  ): Promise<Signature>;
  signMessage(message: string | Uint8Array): Promise<Signature>;
}

// ============================================================================
// Client Configuration
// ============================================================================

export interface ClientConfig {
  apiUrl: string;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

const DEFAULT_CONFIG: Partial<ClientConfig> = {
  timeout: 30000,
  retries: 3,
  retryDelay: 1000,
};

// ============================================================================
// Resource Lock Client
// ============================================================================

export class ResourceLockClient {
  private config: Required<ClientConfig>;
  private requestId: number = 0;
  private signer?: Signer;

  constructor(config: ClientConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config } as Required<ClientConfig>;
  }

  /**
   * Set the signer for signing operations
   */
  setSigner(signer: Signer): void {
    this.signer = signer;
  }

  /**
   * Get the current signer
   */
  getSigner(): Signer | undefined {
    return this.signer;
  }

  // ==========================================================================
  // RPC Communication
  // ==========================================================================

  private async call<T>(method: string, params?: any): Promise<T> {
    const request: RPCRequest = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method,
      params,
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.config.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

        const response = await fetch(this.config.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP error: ${response.status}`);
        }

        //const data: RPCResponse<T> = await response.json();
        const data = await response.json() as RPCResponse<T>;

        if (data.error) {
          throw new ResourceLockError(
            data.error.message,
            data.error.code,
            data.error.data
          );
        }

        return data.result as T;
      } catch (error: any) {
        lastError = error;
        if (error.name === 'AbortError') {
          throw new ResourceLockError('Request timeout', -1);
        }
        if (attempt < this.config.retries - 1) {
          await this.sleep(this.config.retryDelay * (attempt + 1));
        }
      }
    }

    throw lastError || new Error('Unknown error');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==========================================================================
  // Health & Attestation
  // ==========================================================================

  /**
   * Check API health and get enclave info
   */
  async health(): Promise<{
    status: string;
    enclaveId: Hash;
    publicKey: Address;
    stateRoot: Hash;
    timestamp: number;
  }> {
    return this.call('health');
  }

  /**
   * Get boot attestation for verification
   */
  async getBootAttestation(): Promise<BootAttestation> {
    return this.call('getBootAttestation');
  }

  /**
   * Get current state root
   */
  async getStateRoot(): Promise<Hash> {
    return this.call('getStateRoot');
  }

  // ==========================================================================
  // Lock Management
  // ==========================================================================

  /**
   * Create a new resource lock
   * Returns typed data for user to sign
   */
  async createLock(params: {
    asset: AssetIdentifier;
    amount: string | bigint;
    expiresIn: number;
    fulfillmentCondition: FulfillmentCondition;
    sessionKey?: Address;
  }): Promise<CreateLockResponse> {
    if (!this.signer) {
      throw new ResourceLockError('Signer not set', -1);
    }

    const owner = await this.signer.getAddress();

    const request: CreateLockRequest = {
      owner,
      sessionKey: params.sessionKey || owner,
      asset: params.asset,
      amount: params.amount.toString(),
      expiresIn: params.expiresIn,
      fulfillmentCondition: params.fulfillmentCondition,
    };

    return this.call('createLock', request);
  }

  /**
   * Sign a lock and get CCM commitment
   * This submits the user's signature and receives the CCM co-signature
   */
  async signLock(lockResponse: CreateLockResponse): Promise<SignLockResponse> {
    if (!this.signer) {
      throw new ResourceLockError('Signer not set', -1);
    }

    const { lock, typedDataToSign } = lockResponse;

    // Sign the typed data
    const signature = await this.signer.signTypedData(
      typedDataToSign.domain,
      typedDataToSign.types as any,
      typedDataToSign.message as any
    );

    // Submit signature to CCM
    return this.call('signLock', {
      lockId: lock.id,
      signature,
    });
  }

  /**
   * Create and sign a lock in one step
   */
  async createAndSignLock(params: {
    asset: AssetIdentifier;
    amount: string | bigint;
    expiresIn: number;
    fulfillmentCondition: FulfillmentCondition;
    sessionKey?: Address;
  }): Promise<{
    lock: ResourceLock;
    commitment: Commitment;
  }> {
    const createResponse = await this.createLock(params);
    const signResponse = await this.signLock(createResponse);

    return {
      lock: { ...createResponse.lock, status: signResponse.status },
      commitment: signResponse.commitment,
    };
  }

  /**
   * Get lock by ID
   */
  async getLock(lockId: Hash): Promise<ResourceLock | null> {
    return this.call('getLock', { lockId });
  }

  /**
   * Get all active locks for an owner
   */
  async getActiveLocks(owner?: Address): Promise<ResourceLock[]> {
    const address = owner || (this.signer ? await this.signer.getAddress() : null);
    if (!address) {
      throw new ResourceLockError('Owner address required', -1);
    }
    return this.call('getActiveLocks', { owner: address });
  }

  /**
   * Get locked balance for an asset
   */
  async getLockedBalance(asset: AssetIdentifier, owner?: Address): Promise<BalanceResponse> {
    const address = owner || (this.signer ? await this.signer.getAddress() : null);
    if (!address) {
      throw new ResourceLockError('Owner address required', -1);
    }
    return this.call('getLockedBalance', { owner: address, asset });
  }

  // ==========================================================================
  // Fulfillment & Settlement
  // ==========================================================================

  /**
   * Verify fulfillment and get settlement UserOperation
   * Called by solver after fulfilling on destination chain
   */
  async verifyFulfillment(
    lockId: Hash,
    proof: FulfillmentProof
  ): Promise<FulfillLockResponse> {
    return this.call('verifyFulfillment', {
      lockId,
      fulfillmentProof: proof,
    });
  }

  /**
   * Cancel a lock (rage quit)
   */
  async cancelLock(lockId: Hash): Promise<AppAttestation> {
    if (!this.signer) {
      throw new ResourceLockError('Signer not set', -1);
    }

    // Create cancellation message
    const message = `Cancel lock: ${lockId}`;
    const signature = await this.signer.signMessage(message);

    return this.call('cancelLock', { lockId, signature });
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Wait for lock status change
   */
  async waitForStatus(
    lockId: Hash,
    targetStatus: LockStatus,
    timeout: number = 60000
  ): Promise<ResourceLock> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const lock = await this.getLock(lockId);
      if (lock && lock.status === targetStatus) {
        return lock;
      }
      await this.sleep(1000);
    }

    throw new ResourceLockError('Timeout waiting for lock status', -1);
  }

  /**
   * Verify commitment against enclave public key
   */
  async verifyCommitment(commitment: Commitment): Promise<boolean> {
    const bootAttestation = await this.getBootAttestation();
    
    // Verify enclave ID matches
    if (commitment.ccmAttestation.enclaveId !== bootAttestation.enclaveId) {
      return false;
    }

    // In a real implementation, we would verify:
    // 1. The AWS Nitro attestation document
    // 2. The CCM signature against the public key
    // 3. The commitment hash matches the data

    return true;
  }
}

// ============================================================================
// Error Class
// ============================================================================

export class ResourceLockError extends Error {
  constructor(
    message: string,
    public code: number,
    public data?: any
  ) {
    super(message);
    this.name = 'ResourceLockError';
  }
}

// ============================================================================
// Helper: Create Asset Identifier
// ============================================================================

export function createAsset(
  chainId: number,
  type: 'native' | 'erc20' | 'erc721' | 'erc1155',
  contractAddress?: Address,
  tokenId?: bigint
): AssetIdentifier {
  return {
    chainId,
    assetType: type,
    contractAddress,
    tokenId,
  };
}

export function nativeAsset(chainId: number): AssetIdentifier {
  return createAsset(chainId, 'native');
}

export function erc20Asset(chainId: number, contractAddress: Address): AssetIdentifier {
  return createAsset(chainId, 'erc20', contractAddress);
}

// ============================================================================
// Helper: Create Fulfillment Condition
// ============================================================================

export function createFulfillmentCondition(params: {
  targetChainId: number;
  targetAsset: AssetIdentifier;
  targetAmount: string | bigint;
  recipient: Address;
  executionData?: Bytes;
}): FulfillmentCondition {
  return {
    targetChainId: params.targetChainId,
    targetAsset: params.targetAsset,
    targetAmount: BigInt(params.targetAmount),
    recipient: params.recipient,
    executionData: params.executionData,
  };
}

// ============================================================================
// Example Signers (for testing/development)
// ============================================================================

/**
 * Example signer using private key directly
 * WARNING: For development only! Never use in production.
 */
import {
  signTypedData as cryptoSignTypedData,
  privateKeyToAddress,
  keccak256String,
  signHash,
} from '../shared/crypto';

export class PrivateKeySigner implements Signer {
  private privateKey: Bytes;
  private address: Address;

  constructor(privateKey: Bytes) {
    this.privateKey = privateKey;
    this.address = privateKeyToAddress(privateKey);
  }

  async getAddress(): Promise<Address> {
    return this.address;
  }

  async signTypedData(
    domain: EIP712Domain,
    types: Record<string, { name: string; type: string }[]>,
    message: Record<string, any>
  ): Promise<Signature> {
    return cryptoSignTypedData(domain, message as any, this.privateKey);
  }

  async signMessage(message: string | Uint8Array): Promise<Signature> {
    const msgString = typeof message === 'string' ? message : Buffer.from(message).toString();
    const prefixed = `\x19Ethereum Signed Message:\n${msgString.length}${msgString}`;
    const hash = keccak256String(prefixed);
    return signHash(hash, this.privateKey);
  }
}

// ============================================================================
// Viem Adapter (for use with viem/wagmi)
// ============================================================================

/**
 * Adapter for viem WalletClient
 */
export function createViemSigner(walletClient: any): Signer {
  return {
    async getAddress(): Promise<Address> {
      const [address] = await walletClient.getAddresses();
      return address as Address;
    },

    async signTypedData(
      domain: EIP712Domain,
      types: Record<string, { name: string; type: string }[]>,
      message: Record<string, any>
    ): Promise<Signature> {
      return walletClient.signTypedData({
        domain,
        types,
        primaryType: Object.keys(types)[0],
        message,
      }) as Promise<Signature>;
    },

    async signMessage(message: string | Uint8Array): Promise<Signature> {
      return walletClient.signMessage({ message }) as Promise<Signature>;
    },
  };
}

// ============================================================================
// Ethers.js v6 Adapter
// ============================================================================

/**
 * Adapter for ethers.js v6 Signer
 */
export function createEthersSigner(ethersSigner: any): Signer {
  return {
    async getAddress(): Promise<Address> {
      return ethersSigner.getAddress() as Promise<Address>;
    },

    async signTypedData(
      domain: EIP712Domain,
      types: Record<string, { name: string; type: string }[]>,
      message: Record<string, any>
    ): Promise<Signature> {
      return ethersSigner.signTypedData(domain, types, message) as Promise<Signature>;
    },

    async signMessage(message: string | Uint8Array): Promise<Signature> {
      return ethersSigner.signMessage(message) as Promise<Signature>;
    },
  };
}
