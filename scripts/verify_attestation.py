#!/usr/bin/env python3
"""
Attestation Document Verifier

AWS Nitro Enclave attestation document를 검증합니다.

Usage:
    python3 verify_attestation.py <attestation_hex> [--expected-pcr0 <value>]
"""

import sys
import json
import base64
import argparse
from datetime import datetime

# AWS Root Certificate (공개됨)
AWS_ROOT_CERT_PEM = """-----BEGIN CERTIFICATE-----
MIICETCCAZagAwIBAgIRAPkxdWgbkK/hHUbMtOTn+FYwCgYIKoZIzj0EAwMwSTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoMBkFtYXpvbjEMMAoGA1UECwwDQVdTMRswGQYD
VQQDDBJhd3Mubml0cm8tZW5jbGF2ZXMwHhcNMTkxMDI4MTMyODA1WhcNNDkxMDI4
MTQyODA1WjBJMQswCQYDVQQGEwJVUzEPMA0GA1UECgwGQW1hem9uMQwwCgYDVQQL
DANBV1MxGzAZBgNVBAMMEmF3cy5uaXRyby1lbmNsYXZlczB2MBAGByqGSM49AgEG
BSuBBAAiA2IABPwCVOumCMHzaHDimtqQvkY4MpJzbolL//Zy2YlES1BR5TSksfbb
48C8WBoyt7F2Bw7eEtaaP+ohG2bnUs990d0JX28TcPQXCEPZ3BABIeTPYwEoCWZE
h8l5YoQwTcU/9KNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUkCW1DdkF
R+eWw5b6cp3PmanfS5YwDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMDA2kAMGYC
MQCjfy+Rocm9Xue4YnwWmNJVA44fA0P5W2OpYow9OYCVRaEevL8uO1XYru5xtMPW
rfMCMQCi85sWBbJwKKXdS6BptQFuZbT73o/gBh1qUxl/nNr12UO8Yfwr6wPLb+6N
IwLz3/Y=
-----END CERTIFICATE-----"""

def verify_attestation(attestation_hex: str, expected_pcr0: str = None) -> dict:
    """Attestation document 검증"""
    
    result = {
        'valid': False,
        'checks': [],
        'pcrs': {},
        'errors': [],
    }
    
    try:
        import cbor2
    except ImportError:
        result['errors'].append("cbor2 not installed. Run: pip3 install cbor2")
        return result
    
    try:
        # 1. Hex 디코딩
        hex_clean = attestation_hex.replace('0x', '')
        doc_bytes = bytes.fromhex(hex_clean)
        result['checks'].append("✓ Hex decoding successful")
        
        # 2. COSE_Sign1 파싱 시도
        try:
            cose = cbor2.loads(doc_bytes)
            
            if isinstance(cose, list) and len(cose) == 4:
                protected, unprotected, payload, signature = cose
                result['checks'].append("✓ Valid COSE_Sign1 structure")
                result['is_real_attestation'] = True
                
                # Payload 디코딩
                attestation = cbor2.loads(payload)
                
                # PCR 추출
                if 'pcrs' in attestation:
                    for pcr_idx, pcr_val in attestation['pcrs'].items():
                        pcr_hex = pcr_val.hex() if isinstance(pcr_val, bytes) else str(pcr_val)
                        result['pcrs'][str(pcr_idx)] = pcr_hex
                    result['checks'].append(f"✓ Found {len(result['pcrs'])} PCR values")
                
                # Timestamp
                if 'timestamp' in attestation:
                    ts = attestation['timestamp']
                    result['timestamp'] = ts
                    dt = datetime.fromtimestamp(ts / 1000) if ts > 1e12 else datetime.fromtimestamp(ts)
                    result['checks'].append(f"✓ Timestamp: {dt.isoformat()}")
                
                # Module ID
                if 'module_id' in attestation:
                    result['module_id'] = attestation['module_id']
                    result['checks'].append(f"✓ Module ID: {attestation['module_id']}")
                
                # User data
                if 'user_data' in attestation and attestation['user_data']:
                    try:
                        ud = attestation['user_data']
                        if isinstance(ud, bytes):
                            result['user_data'] = ud.decode('utf-8')
                        result['checks'].append("✓ User data present")
                    except:
                        pass
                
                # Certificate chain 확인
                if 'certificate' in attestation:
                    result['checks'].append("✓ Certificate present")
                if 'cabundle' in attestation:
                    result['checks'].append(f"✓ CA bundle: {len(attestation.get('cabundle', []))} certs")
                
                # TODO: 실제 서명 검증 (cryptography 라이브러리 필요)
                result['checks'].append("⚠ Signature verification: Not implemented")
                
            else:
                raise ValueError("Not a valid COSE_Sign1 structure")
                
        except Exception as e:
            # COSE 파싱 실패 - JSON으로 시도 (mock attestation)
            result['is_real_attestation'] = False
            result['checks'].append(f"⚠ Not COSE format: {str(e)[:50]}")
            
            try:
                doc = json.loads(doc_bytes.decode('utf-8'))
                result['checks'].append("✓ Valid JSON (mock attestation)")
                
                if 'pcrs' in doc:
                    result['pcrs'] = doc['pcrs']
                elif 'pcr0' in doc:
                    result['pcrs'] = {'0': doc.get('pcr0'), '1': doc.get('pcr1'), '2': doc.get('pcr2')}
                    
            except json.JSONDecodeError:
                result['errors'].append("Failed to parse as COSE or JSON")
                return result
        
        # 3. PCR0 검증
        if expected_pcr0:
            actual_pcr0 = result['pcrs'].get('0', '')
            if actual_pcr0 == expected_pcr0:
                result['checks'].append(f"✓ PCR0 matches expected value")
            else:
                result['errors'].append(f"✗ PCR0 mismatch!\n  Expected: {expected_pcr0}\n  Actual:   {actual_pcr0}")
        
        # 최종 판정
        if not result['errors']:
            result['valid'] = True
            
    except Exception as e:
        result['errors'].append(f"Verification failed: {str(e)}")
    
    return result

def main():
    parser = argparse.ArgumentParser(description='Verify Nitro Attestation Document')
    parser.add_argument('attestation', nargs='?', help='Attestation document (hex)')
    parser.add_argument('--expected-pcr0', help='Expected PCR0 value')
    parser.add_argument('--file', help='Read attestation from file')
    
    args = parser.parse_args()
    
    # 입력 읽기
    if args.file:
        with open(args.file, 'r') as f:
            attestation = f.read().strip()
    elif args.attestation:
        attestation = args.attestation
    else:
        print("Enter attestation document (hex):")
        attestation = input().strip()
    
    # 검증
    result = verify_attestation(attestation, args.expected_pcr0)
    
    # 결과 출력
    print("\n" + "="*60)
    print("ATTESTATION VERIFICATION RESULT")
    print("="*60)
    
    print(f"\nValid: {'✓ YES' if result['valid'] else '✗ NO'}")
    print(f"Real Attestation: {'YES' if result.get('is_real_attestation') else 'NO (mock)'}")
    
    if result['pcrs']:
        print("\nPCR Values:")
        for idx, val in sorted(result['pcrs'].items()):
            print(f"  PCR{idx}: {val[:32]}..." if len(str(val)) > 32 else f"  PCR{idx}: {val}")
    
    if result['checks']:
        print("\nChecks:")
        for check in result['checks']:
            print(f"  {check}")
    
    if result['errors']:
        print("\nErrors:")
        for error in result['errors']:
            print(f"  {error}")
    
    print("\n" + "="*60)
    
    # Exit code
    sys.exit(0 if result['valid'] else 1)

if __name__ == '__main__':
    main()
