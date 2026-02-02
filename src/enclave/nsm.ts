/**
 * NSM (Nitro Secure Module) Interface
 * 
 * AWS Nitro Enclave의 NSM과 통신하여 실제 attestation을 생성합니다.
 * Python 스크립트를 통해 NSM API를 호출합니다.
 */

import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as crypto from 'crypto';

// NSM Python 스크립트 경로
const NSM_SCRIPT = '/app/scripts/nsm/get_attestation.py';
const NSM_DEVICE = '/dev/nsm';

export interface AttestationRequest {
  publicKey?: Buffer;     // 포함할 공개키 (최대 1024 bytes)
  userData?: Buffer;      // 사용자 데이터 (최대 512 bytes)
  nonce?: Buffer;         // nonce (최대 512 bytes)
}

export interface AttestationDocument {
  success: boolean;
  document: string;       // Base64 encoded attestation document
  pcrs: {
    [key: string]: string; // PCR index -> hex value
  };
  error?: string;
  mock?: boolean;
}

export interface RandomResult {
  success: boolean;
  random: string;         // Base64 encoded random bytes
  length: number;
  error?: string;
  mock?: boolean;
}

export interface NsmInfo {
  success: boolean;
  info?: any;
  error?: string;
  mock?: boolean;
}

/**
 * NSM 디바이스가 사용 가능한지 확인
 */
export function isNsmAvailable(): boolean {
  try {
    return fs.existsSync(NSM_DEVICE);
  } catch {
    return false;
  }
}

/**
 * Python 스크립트가 사용 가능한지 확인
 */
export function isNsmScriptAvailable(): boolean {
  try {
    return fs.existsSync(NSM_SCRIPT);
  } catch {
    return false;
  }
}

/**
 * NSM에서 Attestation Document 가져오기
 */
export async function getAttestationDocument(
  request: AttestationRequest = {}
): Promise<AttestationDocument> {
  
  // NSM 스크립트 없으면 mock 반환
  if (!isNsmScriptAvailable()) {
    console.log('[NSM] Script not found, returning mock attestation');
    return getMockAttestation(request);
  }
  
  try {
    // Python 스크립트 인자 구성
    const args = ['--command', 'attestation'];
    
    if (request.publicKey) {
      args.push('--public-key', request.publicKey.toString('base64'));
    }
    
    if (request.userData) {
      args.push('--user-data', request.userData.toString('utf-8'));
    }
    
    if (request.nonce) {
      args.push('--nonce', request.nonce.toString('base64'));
    }
    
    // Python 스크립트 실행
    const result = execSync(`python3 ${NSM_SCRIPT} ${args.join(' ')}`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    
    const parsed = JSON.parse(result);
    
    console.log('[NSM] Attestation document generated:', parsed.success ? 'SUCCESS' : 'FAILED');
    if (parsed.mock) {
      console.log('[NSM] Warning: Running in mock mode (not in real Enclave)');
    }
    
    return parsed;
    
  } catch (error: any) {
    console.error('[NSM] Failed to get attestation:', error.message);
    return {
      success: false,
      document: '',
      pcrs: {},
      error: error.message,
    };
  }
}

/**
 * NSM에서 Secure Random 가져오기
 */
export async function getSecureRandom(length: number = 32): Promise<Buffer> {
  if (!isNsmScriptAvailable()) {
    console.log('[NSM] Script not found, using crypto.randomBytes');
    return crypto.randomBytes(length);
  }
  
  try {
    const result = execSync(
      `python3 ${NSM_SCRIPT} --command random --length ${length}`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    
    const parsed: RandomResult = JSON.parse(result);
    
    if (parsed.success && parsed.random) {
      return Buffer.from(parsed.random, 'base64');
    }
    
    throw new Error(parsed.error || 'Unknown error');
    
  } catch (error: any) {
    console.error('[NSM] Failed to get random, using crypto:', error.message);
    return crypto.randomBytes(length);
  }
}

/**
 * NSM 정보 조회
 */
export async function describeNsm(): Promise<NsmInfo> {
  if (!isNsmScriptAvailable()) {
    return {
      success: false,
      error: 'NSM script not available',
      mock: true,
    };
  }
  
  try {
    const result = execSync(
      `python3 ${NSM_SCRIPT} --command describe`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    
    return JSON.parse(result);
    
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Mock Attestation (NSM 없을 때)
 */
function getMockAttestation(request: AttestationRequest): AttestationDocument {
  const timestamp = Date.now();
  
  const mockDoc = {
    module_id: 'mock-enclave-module',
    digest: 'SHA384',
    timestamp,
    pcrs: {
      0: crypto.createHash('sha384').update('mock-pcr0').digest('hex'),
      1: crypto.createHash('sha384').update('mock-pcr1').digest('hex'),
      2: crypto.createHash('sha384').update('mock-pcr2').digest('hex'),
    },
    public_key: request.publicKey?.toString('base64') || null,
    user_data: request.userData?.toString('base64') || null,
    nonce: request.nonce?.toString('base64') || null,
    certificate: 'mock-certificate',
    cabundle: [],
  };
  
  return {
    success: true,
    document: Buffer.from(JSON.stringify(mockDoc)).toString('base64'),
    pcrs: {
      '0': mockDoc.pcrs[0],
      '1': mockDoc.pcrs[1],
      '2': mockDoc.pcrs[2],
    },
    mock: true,
  };
}
