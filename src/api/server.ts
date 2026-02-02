/**
 * TEE Resource Lock API Server with vsock support
 * 
 * This server uses raw TCP sockets (net.createServer) instead of HTTP
 * to ensure compatibility with AWS Nitro Enclave's vsock communication.
 * 
 * For development/testing outside enclave, it works as a normal TCP server.
 * Inside Nitro Enclave, vsock connections are handled via virtio-vsock.
 */

import * as net from 'net';
import {
  Address,
  Hash,
  Signature,
  CreateLockRequest,
  CreateLockResponse,
  SignLockRequest,
  SignLockResponse,
  FulfillLockRequest,
  FulfillLockResponse,
  AppAttestation,
  BalanceResponse,
  ResourceLock,
  AssetIdentifier,
} from '../shared/types';

import {
  initializeCCM,
  getCCM,
} from '../enclave/ccm';

// ============================================================================
// API Types
// ============================================================================

interface APIRequest<T = any> {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params: T;
}

interface APIResponse<T = any> {
  jsonrpc: '2.0';
  id: string | number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

interface APIError {
  code: number;
  message: string;
  data?: any;
}

// Error codes
const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Custom errors
  LOCK_NOT_FOUND: -32001,
  INVALID_SIGNATURE: -32002,
  LOCK_EXPIRED: -32003,
  VALIDATION_ERROR: -32004,
  UNAUTHORIZED: -32005,
};

// ============================================================================
// Request Handlers
// ============================================================================

type RequestHandler = (params: any) => Promise<any>;

const handlers: Map<string, RequestHandler> = new Map();

// Health check
handlers.set('health', async () => {
  const ccm = getCCM();
  return {
    status: 'healthy',
    enclaveId: ccm.getEnclaveId(),
    publicKey: ccm.getEnclavePublicKey(),
    stateRoot: ccm.getStateRoot(),
    timestamp: Math.floor(Date.now() / 1000),
  };
});

// Get boot attestation
handlers.set('getBootAttestation', async () => {
  const ccm = getCCM();
  //return ccm.generateBootAttestation();
  return await ccm.generateBootAttestation();
});

// Create a new lock
handlers.set('createLock', async (params: CreateLockRequest): Promise<CreateLockResponse> => {
  validateRequired(params, ['owner', 'asset', 'amount', 'expiresIn', 'fulfillmentCondition']);
  validateAddress(params.owner, 'owner');
  validateAsset(params.asset);
  validateFulfillmentCondition(params.fulfillmentCondition);
  
  const ccm = getCCM();
  return ccm.createLock(params);
});

// Sign a lock (user submits signature, CCM co-signs)
handlers.set('signLock', async (params: SignLockRequest): Promise<SignLockResponse> => {
  validateRequired(params, ['lockId', 'signature']);
  validateHash(params.lockId, 'lockId');
  validateSignature(params.signature);
  
  const ccm = getCCM();
  return ccm.signLock(params);
});

// Verify fulfillment and get settlement UserOp
handlers.set('verifyFulfillment', async (params: FulfillLockRequest): Promise<FulfillLockResponse> => {
  validateRequired(params, ['lockId', 'fulfillmentProof']);
  validateHash(params.lockId, 'lockId');
  validateFulfillmentProof(params.fulfillmentProof);
  
  const ccm = getCCM();
  return ccm.verifyFulfillment(params);
});

// Cancel a lock
handlers.set('cancelLock', async (params: { lockId: Hash; signature: Signature }): Promise<AppAttestation> => {
  validateRequired(params, ['lockId', 'signature']);
  validateHash(params.lockId, 'lockId');
  validateSignature(params.signature);
  
  const ccm = getCCM();
  return ccm.cancelLock(params.lockId, params.signature);
});

// Get lock by ID
handlers.set('getLock', async (params: { lockId: Hash }): Promise<ResourceLock | null> => {
  validateRequired(params, ['lockId']);
  validateHash(params.lockId, 'lockId');
  
  const ccm = getCCM();
  const lock = ccm.getLock(params.lockId);
  return lock || null;
});

// Get active locks for owner
handlers.set('getActiveLocks', async (params: { owner: Address }): Promise<ResourceLock[]> => {
  validateRequired(params, ['owner']);
  validateAddress(params.owner, 'owner');
  
  const ccm = getCCM();
  return ccm.getActiveLocks(params.owner);
});

// Get locked balance
handlers.set('getLockedBalance', async (params: { owner: Address; asset: AssetIdentifier }): Promise<BalanceResponse> => {
  validateRequired(params, ['owner', 'asset']);
  validateAddress(params.owner, 'owner');
  validateAsset(params.asset);
  
  const ccm = getCCM();
  const locks = ccm.getActiveLocks(params.owner);
  const lockedAmount = ccm.getLockedBalance(params.owner, params.asset);
  
  return {
    total: '0',
    available: '0',
    locked: lockedAmount.toString(),
    locks: locks,
  };
});

// Get state root
handlers.set('getStateRoot', async (): Promise<Hash> => {
  const ccm = getCCM();
  return ccm.getStateRoot();
});

// Cleanup expired locks
handlers.set('cleanupExpiredLocks', async (): Promise<{ cleaned: number }> => {
  const ccm = getCCM();
  const cleaned = ccm.cleanupExpiredLocks();
  return { cleaned };
});

// ============================================================================
// Validation Helpers
// ============================================================================

function validateRequired(obj: any, fields: string[]): void {
  for (const field of fields) {
    if (obj[field] === undefined || obj[field] === null) {
      throw createError(ERROR_CODES.INVALID_PARAMS, `Missing required field: ${field}`);
    }
  }
}

function validateAddress(address: any, fieldName: string): void {
  if (typeof address !== 'string' || !address.match(/^0x[a-fA-F0-9]{40}$/)) {
    throw createError(ERROR_CODES.INVALID_PARAMS, `Invalid address for ${fieldName}`);
  }
}

function validateHash(hash: any, fieldName: string): void {
  if (typeof hash !== 'string' || !hash.match(/^0x[a-fA-F0-9]{64}$/)) {
    throw createError(ERROR_CODES.INVALID_PARAMS, `Invalid hash for ${fieldName}`);
  }
}

function validateSignature(sig: any): void {
  if (typeof sig !== 'string' || !sig.match(/^0x[a-fA-F0-9]{130}$/)) {
    throw createError(ERROR_CODES.INVALID_PARAMS, 'Invalid signature format');
  }
}

function validateAsset(asset: any): void {
  if (!asset || typeof asset !== 'object') {
    throw createError(ERROR_CODES.INVALID_PARAMS, 'Invalid asset');
  }
  if (typeof asset.chainId !== 'number') {
    throw createError(ERROR_CODES.INVALID_PARAMS, 'Invalid asset.chainId');
  }
  if (!['native', 'erc20', 'erc721', 'erc1155'].includes(asset.assetType)) {
    throw createError(ERROR_CODES.INVALID_PARAMS, 'Invalid asset.assetType');
  }
}

function validateFulfillmentCondition(condition: any): void {
  if (!condition || typeof condition !== 'object') {
    throw createError(ERROR_CODES.INVALID_PARAMS, 'Invalid fulfillmentCondition');
  }
  if (typeof condition.targetChainId !== 'number') {
    throw createError(ERROR_CODES.INVALID_PARAMS, 'Invalid fulfillmentCondition.targetChainId');
  }
  validateAsset(condition.targetAsset);
  validateAddress(condition.recipient, 'fulfillmentCondition.recipient');
}

function validateFulfillmentProof(proof: any): void {
  if (!proof || typeof proof !== 'object') {
    throw createError(ERROR_CODES.INVALID_PARAMS, 'Invalid fulfillmentProof');
  }
  validateHash(proof.transactionHash, 'fulfillmentProof.transactionHash');
  validateHash(proof.blockHash, 'fulfillmentProof.blockHash');
  if (typeof proof.blockNumber !== 'number') {
    throw createError(ERROR_CODES.INVALID_PARAMS, 'Invalid fulfillmentProof.blockNumber');
  }
}

function createError(code: number, message: string, data?: any): APIError {
  return { code, message, data };
}

// ============================================================================
// Request Processing
// ============================================================================

async function processRequest(request: APIRequest): Promise<APIResponse> {
  const { id, method, params } = request;
  
  try {
    const handler = handlers.get(method);
    if (!handler) {
      return {
        jsonrpc: '2.0',
        id,
        error: createError(ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`),
      };
    }
    
    const result = await handler(params || {});
    
    return {
      jsonrpc: '2.0',
      id,
      result,
    };
  } catch (error: any) {
    // Check if it's an API error
    if (error.code && error.message) {
      return {
        jsonrpc: '2.0',
        id,
        error: error as APIError,
      };
    }
    
    // Unknown error
    console.error(`[API] Error processing ${method}:`, error);
    return {
      jsonrpc: '2.0',
      id,
      error: createError(ERROR_CODES.INTERNAL_ERROR, error.message || 'Internal error'),
    };
  }
}

// ============================================================================
// TCP Socket Connection Handler (vsock compatible)
// ============================================================================

function handleConnection(socket: net.Socket): void {
  console.log('[API] New connection');
  let buffer = '';

  socket.on('data', async (chunk) => {
    buffer += chunk.toString();
    
    // Try to extract JSON from the buffer
    let jsonStr = buffer.trim();
    
    // Check if it's an HTTP request (from curl or socat proxy)
    if (buffer.startsWith('POST') || buffer.startsWith('GET') || buffer.startsWith('OPTIONS')) {
      // Handle CORS preflight
      if (buffer.startsWith('OPTIONS')) {
        socket.write('HTTP/1.1 204 No Content\r\n');
        socket.write('Access-Control-Allow-Origin: *\r\n');
        socket.write('Access-Control-Allow-Methods: POST, OPTIONS\r\n');
        socket.write('Access-Control-Allow-Headers: Content-Type\r\n');
        socket.write('\r\n');
        socket.end();
        buffer = '';
        return;
      }
      
      // Find the body after headers
      const bodyMatch = buffer.match(/\r\n\r\n([\s\S]*)/);
      if (!bodyMatch) {
        return; // Wait for more data (headers not complete)
      }
      
      // Check Content-Length
      const contentLengthMatch = buffer.match(/Content-Length:\s*(\d+)/i);
      if (contentLengthMatch) {
        const contentLength = parseInt(contentLengthMatch[1], 10);
        const body = bodyMatch[1];
        if (body.length < contentLength) {
          return; // Wait for more data
        }
        jsonStr = body.substring(0, contentLength);
      } else {
        jsonStr = bodyMatch[1].trim();
      }
    }
    
    if (!jsonStr) return;
    
    try {
      const request = JSON.parse(jsonStr);
      
      // Validate JSON-RPC request
      if (request.jsonrpc !== '2.0' || !request.method) {
        const errResponse = JSON.stringify({
          jsonrpc: '2.0',
          id: request.id || null,
          error: createError(ERROR_CODES.INVALID_REQUEST, 'Invalid JSON-RPC request'),
        });
        sendHttpResponse(socket, 400, errResponse);
        buffer = '';
        return;
      }
      
      const response = await processRequest(request);
      const responseStr = JSON.stringify(response, (_, value) =>
        typeof value === 'bigint' ? value.toString() : value
      );
      
      sendHttpResponse(socket, 200, responseStr);
      buffer = '';
      
    } catch (e) {
      // Check if we might be waiting for more data
      if (!buffer.includes('}')) {
        return; // Wait for more data
      }
      
      // Malformed JSON
      const errResponse = JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: createError(ERROR_CODES.PARSE_ERROR, 'Invalid JSON'),
      });
      sendHttpResponse(socket, 400, errResponse);
      buffer = '';
    }
  });

  socket.on('error', (err) => {
    console.error('[API] Socket error:', err.message);
  });

  socket.on('close', () => {
    console.log('[API] Connection closed');
  });
}

function sendHttpResponse(socket: net.Socket, statusCode: number, body: string): void {
  const statusText = statusCode === 200 ? 'OK' : 'Bad Request';
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\n`);
  socket.write('Content-Type: application/json\r\n');
  socket.write('Access-Control-Allow-Origin: *\r\n');
  socket.write('Access-Control-Allow-Methods: POST, OPTIONS\r\n');
  socket.write('Access-Control-Allow-Headers: Content-Type\r\n');
  socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n`);
  socket.write('Connection: close\r\n');
  socket.write('\r\n');
  socket.write(body);
  socket.end();
}

// ============================================================================
// Server Startup
// ============================================================================

const PORT = parseInt(process.env.PORT || '5000', 10);
const HOST = process.env.HOST || '0.0.0.0';

export function startServer(): void {
  // Initialize CCM
  console.log('[API] Initializing Credible Commitment Machine...');
  initializeCCM();
  
  // Create TCP server (compatible with both TCP and vsock via virtio)
  const server = net.createServer(handleConnection);
  
  server.on('error', (err) => {
    console.error('[API] Server error:', err);
  });

  //server.listen(PORT, HOST, () => {
  server.listen("/tmp/app.sock", () => {
    //console.log(`[API] TEE Resource Lock API server running on ${HOST}:${PORT}`);
    console.log(`[API] TEE Resource Lock API server running on /tmp/app.sock`);
    console.log('[API] Available methods:');
    for (const method of handlers.keys()) {
      console.log(`  - ${method}`);
    }
  });
  
  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[API] Shutting down...');
    server.close(() => {
      console.log('[API] Server closed');
      process.exit(0);
    });
  });
  
  // Periodic cleanup
  setInterval(() => {
    try {
      const ccm = getCCM();
      ccm.cleanupExpiredLocks();
    } catch (error) {
      console.error('[API] Cleanup error:', error);
    }
  }, 60000); // Every minute
}

// Start if run directly
if (require.main === module) {
  startServer();
}
