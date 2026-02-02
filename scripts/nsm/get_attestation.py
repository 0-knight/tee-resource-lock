#!/usr/bin/env python3
"""
NSM Attestation Document Generator
"""

import sys
import json
import base64
import argparse
import hashlib
import time

def get_attestation(public_key=None, user_data=None, nonce=None):
    """NSM에서 attestation document 가져오기"""
    try:
        import aws_nsm_interface as nsm
        
        # NSM 디바이스 열기
        fd = nsm.open_nsm_device()
        
        # 요청 파라미터
        kwargs = {}
        if public_key:
            kwargs['public_key'] = base64.b64decode(public_key)
        if user_data:
            kwargs['user_data'] = user_data.encode('utf-8') if isinstance(user_data, str) else user_data
        if nonce:
            kwargs['nonce'] = base64.b64decode(nonce)
        
        # Attestation 요청
        attestation_doc = nsm.get_attestation_doc(fd, **kwargs)
        
        nsm.close_nsm_device(fd)
        
        return {
            'success': True,
            'document': base64.b64encode(attestation_doc).decode('utf-8'),
            'pcrs': {},
        }
        
    except ImportError as e:
        return mock_attestation(f'NSM library not available: {e}')
    except FileNotFoundError as e:
        return mock_attestation(f'NSM device not found: {e}')
    except Exception as e:
        return mock_attestation(f'NSM error: {e}')


def mock_attestation(reason):
    """Mock attestation 반환"""
    mock_pcrs = {
        '0': hashlib.sha384(b'mock-pcr0').hexdigest(),
        '1': hashlib.sha384(b'mock-pcr1').hexdigest(),
        '2': hashlib.sha384(b'mock-pcr2').hexdigest(),
    }
    
    mock_doc = {
        'module_id': 'mock-module',
        'timestamp': int(time.time() * 1000),
        'pcrs': mock_pcrs,
    }
    
    return {
        'success': True,
        'document': base64.b64encode(json.dumps(mock_doc).encode()).decode('utf-8'),
        'pcrs': mock_pcrs,
        'mock': True,
        'mock_reason': reason,
    }


def get_random(length=32):
    """Secure random 생성"""
    try:
        import aws_nsm_interface as nsm
        fd = nsm.open_nsm_device()
        random_bytes = nsm.get_random(fd, length)
        nsm.close_nsm_device(fd)
        return {
            'success': True,
            'random': base64.b64encode(random_bytes).decode('utf-8'),
            'length': length,
        }
    except Exception as e:
        import os
        return {
            'success': True,
            'random': base64.b64encode(os.urandom(length)).decode('utf-8'),
            'length': length,
            'mock': True,
            'mock_reason': str(e),
        }


def describe_nsm():
    """NSM 정보 조회"""
    try:
        import aws_nsm_interface as nsm
        fd = nsm.open_nsm_device()
        info = nsm.describe_nsm(fd)
        nsm.close_nsm_device(fd)
        return {'success': True, 'info': info}
    except Exception as e:
        return {'success': False, 'error': str(e), 'mock': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='NSM Attestation Tool')
    parser.add_argument('--command', choices=['attestation', 'random', 'describe'], 
                        default='attestation')
    parser.add_argument('--public-key', help='Public key (base64)')
    parser.add_argument('--user-data', help='User data string')
    parser.add_argument('--nonce', help='Nonce (base64)')
    parser.add_argument('--length', type=int, default=32)
    
    args = parser.parse_args()
    
    if args.command == 'attestation':
        result = get_attestation(args.public_key, args.user_data, args.nonce)
    elif args.command == 'random':
        result = get_random(args.length)
    elif args.command == 'describe':
        result = describe_nsm()
    else:
        result = {'error': 'Unknown command'}
    
    print(json.dumps(result))
