/**
 * TEE Resource Lock - Usage Examples
 * 
 * Demonstrates the complete flow:
 * 1. Initialize client
 * 2. Create a resource lock
 * 3. Sign the lock
 * 4. Verify fulfillment
 * 5. Settlement
 */

import {
  ResourceLockClient,
  PrivateKeySigner,
  nativeAsset,
  erc20Asset,
  createFulfillmentCondition,
  ResourceLockError,
} from './sdk';

import {
  Address,
  Hash,
  LockStatus,
  FulfillmentProof,
} from '../shared/types';

import { generatePrivateKey } from '../shared/crypto';

// ============================================================================
// Example 1: Basic Cross-Chain Swap
// ============================================================================

async function exampleCrossChainSwap() {
  console.log('\n=== Example 1: Cross-Chain Swap ===\n');

  // Initialize client
  const client = new ResourceLockClient({
    apiUrl: 'http://localhost:8080',
  });

  // Create a test signer (in production, use wallet connector)
  const privateKey = generatePrivateKey();
  const signer = new PrivateKeySigner(privateKey);
  client.setSigner(signer);

  const userAddress = await signer.getAddress();
  console.log('User address:', userAddress);

  // Check API health
  const health = await client.health();
  console.log('Enclave ID:', health.enclaveId);
  console.log('Enclave Public Key:', health.publicKey);

  // Define the swap:
  // Lock 1000 USDC on Ethereum, receive 0.5 ETH on Arbitrum
  const sourceAsset = erc20Asset(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address); // USDC on Ethereum
  const targetAsset = nativeAsset(42161); // ETH on Arbitrum

  try {
    // Step 1: Create lock
    console.log('\n--- Step 1: Creating lock ---');
    const createResponse = await client.createLock({
      asset: sourceAsset,
      amount: '1000000000', // 1000 USDC (6 decimals)
      expiresIn: 300, // 5 minutes
      fulfillmentCondition: createFulfillmentCondition({
        targetChainId: 42161,
        targetAsset,
        targetAmount: '500000000000000000', // 0.5 ETH
        recipient: userAddress,
      }),
    });

    console.log('Lock ID:', createResponse.lock.id);
    console.log('Lock Status:', createResponse.lock.status);
    console.log('Expires at:', new Date(createResponse.lock.expiresAt * 1000).toISOString());
    console.log('Typed data to sign:', JSON.stringify(createResponse.typedDataToSign, null, 2));

    // Step 2: Sign the lock
    console.log('\n--- Step 2: Signing lock ---');
    const signResponse = await client.signLock(createResponse);
    
    console.log('Lock Status:', signResponse.status);
    console.log('Commitment created!');
    console.log('  - Lock ID:', signResponse.commitment.lockId);
    console.log('  - State Root:', signResponse.commitment.stateRoot);
    console.log('  - CCM Attestation:');
    console.log('    - Enclave ID:', signResponse.commitment.ccmAttestation.enclaveId);
    console.log('    - Timestamp:', signResponse.commitment.ccmAttestation.timestamp);
    console.log('    - Commitment Hash:', signResponse.commitment.ccmAttestation.commitmentHash);

    // Step 3: Solver fulfills on destination chain
    // (In reality, this happens off-chain by the solver)
    console.log('\n--- Step 3: Verifying fulfillment ---');
    
    const fulfillmentProof: FulfillmentProof = {
      transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as Hash,
      blockNumber: 12345678,
      blockHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as Hash,
      logIndex: 0,
    };

    const fulfillResponse = await client.verifyFulfillment(
      createResponse.lock.id,
      fulfillmentProof
    );

    console.log('Fulfillment verified!');
    console.log('Settlement UserOp:');
    console.log('  - Sender:', fulfillResponse.settlementUserOp.sender);
    console.log('  - Nonce:', fulfillResponse.settlementUserOp.nonce.toString());
    console.log('  - CallData:', fulfillResponse.settlementUserOp.callData.slice(0, 66) + '...');

    // Step 4: Check lock status
    console.log('\n--- Step 4: Final lock status ---');
    const finalLock = await client.getLock(createResponse.lock.id);
    console.log('Lock Status:', finalLock?.status);

  } catch (error) {
    if (error instanceof ResourceLockError) {
      console.error('Resource Lock Error:', error.message, `(code: ${error.code})`);
    } else {
      throw error;
    }
  }
}

// ============================================================================
// Example 2: Multiple Concurrent Locks
// ============================================================================

async function exampleMultipleLocks() {
  console.log('\n=== Example 2: Multiple Concurrent Locks ===\n');

  const client = new ResourceLockClient({
    apiUrl: 'http://localhost:8080',
  });

  const privateKey = generatePrivateKey();
  const signer = new PrivateKeySigner(privateKey);
  client.setSigner(signer);

  const userAddress = await signer.getAddress();
  console.log('User address:', userAddress);

  // Create multiple locks
  const locks = [];
  
  for (let i = 0; i < 3; i++) {
    const response = await client.createAndSignLock({
      asset: erc20Asset(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address),
      amount: (100 * (i + 1)).toString() + '000000', // 100, 200, 300 USDC
      expiresIn: 300,
      fulfillmentCondition: createFulfillmentCondition({
        targetChainId: 10, // Optimism
        targetAsset: nativeAsset(10),
        targetAmount: (BigInt(i + 1) * BigInt('50000000000000000')).toString(), // 0.05, 0.1, 0.15 ETH
        recipient: userAddress,
      }),
    });
    
    locks.push(response);
    console.log(`Lock ${i + 1} created: ${response.lock.id}`);
  }

  // Get all active locks
  const activeLocks = await client.getActiveLocks();
  console.log(`\nTotal active locks: ${activeLocks.length}`);
  
  for (const lock of activeLocks) {
    console.log(`  - ${lock.id}: ${lock.amount} (expires: ${new Date(lock.expiresAt * 1000).toISOString()})`);
  }
}

// ============================================================================
// Example 3: Lock Cancellation (Rage Quit)
// ============================================================================

async function exampleCancelLock() {
  console.log('\n=== Example 3: Lock Cancellation ===\n');

  const client = new ResourceLockClient({
    apiUrl: 'http://localhost:8080',
  });

  const privateKey = generatePrivateKey();
  const signer = new PrivateKeySigner(privateKey);
  client.setSigner(signer);

  // Create a lock
  const { lock } = await client.createAndSignLock({
    asset: nativeAsset(1),
    amount: '1000000000000000000', // 1 ETH
    expiresIn: 300,
    fulfillmentCondition: createFulfillmentCondition({
      targetChainId: 137, // Polygon
      targetAsset: erc20Asset(137, '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as Address), // USDC on Polygon
      targetAmount: '2000000000', // 2000 USDC
      recipient: await signer.getAddress(),
    }),
  });

  console.log('Lock created:', lock.id);
  console.log('Status:', lock.status);

  // Cancel the lock (rage quit)
  console.log('\nCancelling lock...');
  const attestation = await client.cancelLock(lock.id);
  
  console.log('Lock cancelled!');
  console.log('Attestation:');
  console.log('  - Operation:', attestation.operation);
  console.log('  - Timestamp:', attestation.timestamp);
  console.log('  - Signature:', attestation.signature.slice(0, 40) + '...');

  // Verify lock is cancelled
  const cancelledLock = await client.getLock(lock.id);
  console.log('\nFinal status:', cancelledLock?.status);
}

// ============================================================================
// Example 4: Solver Integration
// ============================================================================

async function exampleSolverFlow() {
  console.log('\n=== Example 4: Solver Integration Flow ===\n');

  const client = new ResourceLockClient({
    apiUrl: 'http://localhost:8080',
  });

  // Solver monitors for new commitments
  console.log('Solver: Monitoring for new commitments...');

  // Get boot attestation to verify enclave
  const attestation = await client.getBootAttestation();
  console.log('Verified enclave:');
  console.log('  - Enclave ID:', attestation.enclaveId);
  console.log('  - Public Key:', attestation.publicKey);
  console.log('  - Boot Time:', new Date(attestation.bootTime * 1000).toISOString());

  // Simulate: User creates a lock
  const userPrivateKey = generatePrivateKey();
  const userSigner = new PrivateKeySigner(userPrivateKey);
  client.setSigner(userSigner);

  const { lock, commitment } = await client.createAndSignLock({
    asset: erc20Asset(1, '0xdAC17F958D2ee523a2206206994597C13D831ec7' as Address), // USDT
    amount: '5000000000', // 5000 USDT
    expiresIn: 600, // 10 minutes
    fulfillmentCondition: createFulfillmentCondition({
      targetChainId: 8453, // Base
      targetAsset: nativeAsset(8453),
      targetAmount: '2000000000000000000', // 2 ETH
      recipient: await userSigner.getAddress(),
    }),
  });

  console.log('\nUser created lock:', lock.id);

  // Solver verifies commitment
  console.log('\nSolver: Verifying commitment...');
  const isValid = await client.verifyCommitment(commitment);
  console.log('Commitment valid:', isValid);

  // Solver checks if profitable
  console.log('\nSolver: Checking profitability...');
  console.log('  - Source: 5000 USDT on Ethereum');
  console.log('  - Target: 2 ETH on Base');
  console.log('  - Expiry:', new Date(lock.expiresAt * 1000).toISOString());

  // Solver decides to fulfill
  console.log('\nSolver: Executing fulfillment on Base...');
  // ... (actual chain interaction would happen here)

  // Submit fulfillment proof
  const proof: FulfillmentProof = {
    transactionHash: '0x' + 'a'.repeat(64) as Hash,
    blockNumber: 1000000,
    blockHash: '0x' + 'b'.repeat(64) as Hash,
    logIndex: 0,
  };

  const settlement = await client.verifyFulfillment(lock.id, proof);
  console.log('\nFulfillment verified!');
  console.log('Settlement UserOp ready for submission');
  console.log('  - Sender:', settlement.settlementUserOp.sender);
  console.log('  - Nonce:', settlement.settlementUserOp.nonce.toString());
}

// ============================================================================
// Example 5: React Hook Pattern (Web Integration)
// ============================================================================

function showReactHookExample() {
  const reactHookExample = `
// Example of how you might use the SDK in a React app with wagmi
// This is pseudo-code to show the pattern

import { useWalletClient } from 'wagmi';
import { ResourceLockClient, createViemSigner } from '@tee-resource-lock/client';

// Initialize client
const client = new ResourceLockClient({
  apiUrl: process.env.NEXT_PUBLIC_CCM_API_URL,
});

// Hook for creating locks
function useResourceLock() {
  const { data: walletClient } = useWalletClient();
  
  useEffect(() => {
    if (walletClient) {
      client.setSigner(createViemSigner(walletClient));
    }
  }, [walletClient]);
  
  const createLock = async (params) => {
    const { lock, commitment } = await client.createAndSignLock(params);
    return { lock, commitment };
  };
  
  const cancelLock = async (lockId) => {
    return client.cancelLock(lockId);
  };
  
  return { createLock, cancelLock };
}
`;

  console.log('\n=== Example 5: React Hook Pattern ===\n');
  console.log(reactHookExample);
}

// ============================================================================
// Run Examples
// ============================================================================

async function main() {
  console.log('========================================');
  console.log('  TEE Resource Lock - Usage Examples');
  console.log('========================================');

  try {
    // Note: These examples require the API server to be running
    // Start the server first with: npx ts-node api/server.ts
    
    await exampleCrossChainSwap();
    await exampleMultipleLocks();
    await exampleCancelLock();
    await exampleSolverFlow();
    showReactHookExample();
    
  } catch (error) {
    if (error instanceof Error && error.message.includes('fetch')) {
      console.log('\n[Note] API server not running. Start it with:');
      console.log('  npx ts-node api/server.ts');
    } else {
      throw error;
    }
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

export {
  exampleCrossChainSwap,
  exampleMultipleLocks,
  exampleCancelLock,
  exampleSolverFlow,
};
