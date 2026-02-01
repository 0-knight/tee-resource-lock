/**
 * TEE Resource Lock System
 * 
 * A TEE-based Resource Lock implementation inspired by OneBalance's 
 * Credible Commitment Machine (CCM) architecture.
 */

// Shared types and utilities
export * from './shared';

// Client SDK (for dApps and users)
export * from './client';

// Note: Enclave module is not exported here as it should only run inside TEE
// Import directly from './enclave' if needed for development/testing
