/**
 * CCM NSM Integration Patch
 * 
 * 이 파일의 내용을 ccm.ts에 적용하세요.
 */

// 1. 상단에 import 추가:
// import { getAttestationDocument, getSecureRandom, isNsmAvailable } from './nsm';

// 2. generateBootAttestation 함수를 다음으로 교체:

/*
  async generateBootAttestation(): Promise<BootAttestation> {
    const timestamp = this.state.bootTime;
    
    console.log('[CCM] Generating boot attestation...');
    console.log('[CCM] NSM available:', isNsmAvailable());
    
    // NSM에서 실제 attestation document 요청
    const attestation = await getAttestationDocument({
      publicKey: Buffer.from(this.state.publicKey.slice(2), 'hex'),
      userData: Buffer.from(JSON.stringify({
        enclaveId: this.state.enclaveId,
        bootTime: timestamp,
        version: '1.0.0',
      })),
      nonce: Buffer.from(crypto.randomBytes(32)),
    });
    
    if (!attestation.success) {
      console.error('[CCM] Failed to get NSM attestation:', attestation.error);
    }
    
    // PCR0를 codeHash로 사용 (실제 enclave image 해시)
    const codeHash = attestation.pcrs['0'] 
      ? ('0x' + attestation.pcrs['0']) as Hash
      : keccak256(Buffer.from('mock-enclave-v1').toString('hex'));
    
    // Attestation document 서명
    const docHash = keccak256(Buffer.from(attestation.document, 'base64').toString('hex'));
    const signature = signHash(docHash, this.state.privateKey);
    
    return {
      enclaveId: this.state.enclaveId,
      publicKey: this.state.publicKey,
      bootTime: timestamp,
      codeHash,
      awsAttestationDocument: ('0x' + Buffer.from(attestation.document, 'base64').toString('hex')) as Bytes,
      signature,
      // 추가 정보
      pcrs: attestation.pcrs,
      isRealAttestation: !attestation.mock,
    };
  }
*/
