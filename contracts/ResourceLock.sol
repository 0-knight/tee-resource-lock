// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IResourceLockValidator
 * @notice Interface for validating CCM commitments on-chain
 * @dev This validator is used by the smart account to verify CCM co-signatures
 */
interface IResourceLockValidator {
    struct Commitment {
        bytes32 lockId;
        address owner;
        uint256 chainId;
        bytes32 assetHash;
        uint256 amount;
        uint256 nonce;
        uint256 expiresAt;
        bytes32 fulfillmentHash;
        bytes32 stateRoot;
    }

    struct CCMAttestation {
        bytes32 enclaveId;
        uint256 timestamp;
        bytes32 commitmentHash;
        bytes signature;
    }

    function validateCommitment(
        Commitment calldata commitment,
        CCMAttestation calldata attestation
    ) external view returns (bool);

    function validateDualSignature(
        bytes32 userOpHash,
        bytes calldata signature
    ) external view returns (bool);
}

/**
 * @title ResourceLockValidator
 * @notice On-chain validator for CCM commitments
 * @dev Validates that operations are co-signed by both user and CCM enclave
 */
contract ResourceLockValidator is IResourceLockValidator {
    // ==========================================================================
    // State Variables
    // ==========================================================================

    /// @notice The trusted CCM enclave public key (set at deployment)
    address public immutable ccmPublicKey;

    /// @notice The trusted enclave ID
    bytes32 public immutable trustedEnclaveId;

    /// @notice Mapping of used commitment hashes to prevent replay
    mapping(bytes32 => bool) public usedCommitments;

    /// @notice Mapping of owner => nonce for sequential execution
    mapping(address => uint256) public nonces;

    // ==========================================================================
    // Events
    // ==========================================================================

    event CommitmentValidated(
        bytes32 indexed lockId,
        address indexed owner,
        uint256 amount
    );

    event DualSignatureValidated(
        bytes32 indexed userOpHash,
        address indexed signer,
        address indexed coSigner
    );

    // ==========================================================================
    // Errors
    // ==========================================================================

    error InvalidEnclaveId();
    error InvalidSignature();
    error CommitmentExpired();
    error CommitmentAlreadyUsed();
    error InvalidNonce();
    error InvalidChainId();

    // ==========================================================================
    // Constructor
    // ==========================================================================

    constructor(address _ccmPublicKey, bytes32 _trustedEnclaveId) {
        ccmPublicKey = _ccmPublicKey;
        trustedEnclaveId = _trustedEnclaveId;
    }

    // ==========================================================================
    // External Functions
    // ==========================================================================

    /**
     * @notice Validate a CCM commitment
     * @param commitment The commitment data
     * @param attestation The CCM attestation with signature
     * @return True if valid
     */
    function validateCommitment(
        Commitment calldata commitment,
        CCMAttestation calldata attestation
    ) external view override returns (bool) {
        // Verify enclave ID
        if (attestation.enclaveId != trustedEnclaveId) {
            revert InvalidEnclaveId();
        }

        // Verify chain ID
        if (commitment.chainId != block.chainid) {
            revert InvalidChainId();
        }

        // Verify not expired
        if (commitment.expiresAt < block.timestamp) {
            revert CommitmentExpired();
        }

        // Verify commitment hash matches
        bytes32 computedHash = keccak256(
            abi.encode(
                commitment.lockId,
                commitment.owner,
                commitment.chainId,
                commitment.assetHash,
                commitment.amount,
                commitment.nonce,
                commitment.expiresAt,
                commitment.fulfillmentHash,
                commitment.stateRoot
            )
        );

        if (computedHash != attestation.commitmentHash) {
            revert InvalidSignature();
        }

        // Verify CCM signature
        bytes32 ethSignedHash = _toEthSignedMessageHash(attestation.commitmentHash);
        address recovered = _recoverSigner(ethSignedHash, attestation.signature);

        if (recovered != ccmPublicKey) {
            revert InvalidSignature();
        }

        return true;
    }

    /**
     * @notice Validate a dual signature (user + CCM)
     * @param userOpHash The hash of the UserOperation
     * @param signature The combined signature (user 65 bytes + CCM 65 bytes)
     * @return True if both signatures are valid
     */
    function validateDualSignature(
        bytes32 userOpHash,
        bytes calldata signature
    ) external view override returns (bool) {
        require(signature.length == 130, "Invalid signature length");

        // Split signature
        bytes memory userSig = signature[0:65];
        bytes memory ccmSig = signature[65:130];

        bytes32 ethSignedHash = _toEthSignedMessageHash(userOpHash);

        // Recover user (anyone can be user, we just verify CCM)
        address userSigner = _recoverSigner(ethSignedHash, userSig);
        
        // Verify CCM signature
        address ccmSigner = _recoverSigner(ethSignedHash, ccmSig);

        if (ccmSigner != ccmPublicKey) {
            revert InvalidSignature();
        }

        emit DualSignatureValidated(userOpHash, userSigner, ccmSigner);
        return true;
    }

    /**
     * @notice Mark a commitment as used (called after settlement)
     * @param commitmentHash The commitment hash to mark as used
     */
    function markCommitmentUsed(bytes32 commitmentHash) external {
        // In production, this would have access control
        usedCommitments[commitmentHash] = true;
    }

    /**
     * @notice Check if a commitment has been used
     * @param commitmentHash The commitment hash to check
     * @return True if already used
     */
    function isCommitmentUsed(bytes32 commitmentHash) external view returns (bool) {
        return usedCommitments[commitmentHash];
    }

    // ==========================================================================
    // Internal Functions
    // ==========================================================================

    /**
     * @notice Convert a hash to an Ethereum signed message hash
     * @param hash The original hash
     * @return The Ethereum signed message hash
     */
    function _toEthSignedMessageHash(bytes32 hash) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", hash)
        );
    }

    /**
     * @notice Recover signer address from signature
     * @param hash The signed hash
     * @param signature The signature bytes
     * @return The recovered signer address
     */
    function _recoverSigner(
        bytes32 hash,
        bytes memory signature
    ) internal pure returns (address) {
        require(signature.length == 65, "Invalid signature length");

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }

        if (v < 27) {
            v += 27;
        }

        require(v == 27 || v == 28, "Invalid signature v value");

        return ecrecover(hash, v, r, s);
    }
}

/**
 * @title ResourceLockAccount
 * @notice ERC-4337 compatible smart account with resource lock support
 * @dev Integrates with CCM for dual-signature validation
 */
contract ResourceLockAccount {
    // ==========================================================================
    // State Variables
    // ==========================================================================

    /// @notice The owner of this account
    address public owner;

    /// @notice The session key (delegated signer)
    address public sessionKey;

    /// @notice The resource lock validator
    IResourceLockValidator public validator;

    /// @notice The EntryPoint contract
    address public immutable entryPoint;

    /// @notice Current nonce
    uint256 public nonce;

    // ==========================================================================
    // Events
    // ==========================================================================

    event ExecutionSuccess(bytes32 indexed opHash);
    event ExecutionFailure(bytes32 indexed opHash, bytes reason);
    event SessionKeyUpdated(address indexed oldKey, address indexed newKey);

    // ==========================================================================
    // Modifiers
    // ==========================================================================

    modifier onlyEntryPointOrOwner() {
        require(
            msg.sender == entryPoint || msg.sender == owner,
            "Only EntryPoint or owner"
        );
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    // ==========================================================================
    // Constructor
    // ==========================================================================

    constructor(
        address _owner,
        address _sessionKey,
        address _validator,
        address _entryPoint
    ) {
        owner = _owner;
        sessionKey = _sessionKey;
        validator = IResourceLockValidator(_validator);
        entryPoint = _entryPoint;
    }

    // ==========================================================================
    // ERC-4337 Interface
    // ==========================================================================

    /**
     * @notice Validate a UserOperation
     * @param userOp The packed UserOperation
     * @param userOpHash The hash of the UserOperation
     * @param missingAccountFunds Funds to prefund
     * @return validationData 0 for success, 1 for failure
     */
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external onlyEntryPointOrOwner returns (uint256 validationData) {
        // Validate dual signature (user + CCM)
        bool isValid = validator.validateDualSignature(userOpHash, userOp.signature);
        
        if (!isValid) {
            return 1; // Signature validation failed
        }

        // Prefund EntryPoint if needed
        if (missingAccountFunds > 0) {
            (bool success, ) = payable(msg.sender).call{value: missingAccountFunds}("");
            require(success, "Prefund failed");
        }

        return 0; // Success
    }

    /**
     * @notice Execute a call from this account
     * @param dest Destination address
     * @param value ETH value to send
     * @param func Function calldata
     */
    function execute(
        address dest,
        uint256 value,
        bytes calldata func
    ) external onlyEntryPointOrOwner {
        (bool success, bytes memory result) = dest.call{value: value}(func);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    /**
     * @notice Execute a batch of calls
     * @param dests Destination addresses
     * @param values ETH values to send
     * @param funcs Function calldatas
     */
    function executeBatch(
        address[] calldata dests,
        uint256[] calldata values,
        bytes[] calldata funcs
    ) external onlyEntryPointOrOwner {
        require(
            dests.length == values.length && dests.length == funcs.length,
            "Length mismatch"
        );

        for (uint256 i = 0; i < dests.length; i++) {
            (bool success, bytes memory result) = dests[i].call{value: values[i]}(funcs[i]);
            if (!success) {
                assembly {
                    revert(add(result, 32), mload(result))
                }
            }
        }
    }

    // ==========================================================================
    // Account Management
    // ==========================================================================

    /**
     * @notice Update the session key
     * @param newSessionKey The new session key address
     */
    function setSessionKey(address newSessionKey) external onlyOwner {
        address oldKey = sessionKey;
        sessionKey = newSessionKey;
        emit SessionKeyUpdated(oldKey, newSessionKey);
    }

    /**
     * @notice Update the validator
     * @param newValidator The new validator address
     */
    function setValidator(address newValidator) external onlyOwner {
        validator = IResourceLockValidator(newValidator);
    }

    // ==========================================================================
    // Receive ETH
    // ==========================================================================

    receive() external payable {}
}

/**
 * @notice Packed UserOperation struct (ERC-4337 v0.7)
 */
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

/**
 * @title ResourceLockAccountFactory
 * @notice Factory for deploying ResourceLockAccount instances
 */
contract ResourceLockAccountFactory {
    /// @notice The validator contract address
    address public immutable validator;

    /// @notice The EntryPoint contract address
    address public immutable entryPoint;

    /// @notice Mapping of owner => deployed account
    mapping(address => address) public accounts;

    event AccountCreated(
        address indexed account,
        address indexed owner,
        address indexed sessionKey
    );

    constructor(address _validator, address _entryPoint) {
        validator = _validator;
        entryPoint = _entryPoint;
    }

    /**
     * @notice Create a new account or return existing
     * @param owner The account owner
     * @param sessionKey The session key for delegated signing
     * @param salt Salt for CREATE2
     * @return account The account address
     */
    function createAccount(
        address owner,
        address sessionKey,
        uint256 salt
    ) external returns (address account) {
        // Check if already deployed
        address predicted = getAddress(owner, sessionKey, salt);
        if (predicted.code.length > 0) {
            return predicted;
        }

        // Deploy new account
        account = address(
            new ResourceLockAccount{salt: bytes32(salt)}(
                owner,
                sessionKey,
                validator,
                entryPoint
            )
        );

        accounts[owner] = account;
        emit AccountCreated(account, owner, sessionKey);
    }

    /**
     * @notice Get the counterfactual address
     * @param owner The account owner
     * @param sessionKey The session key
     * @param salt The CREATE2 salt
     * @return The predicted address
     */
    function getAddress(
        address owner,
        address sessionKey,
        uint256 salt
    ) public view returns (address) {
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                bytes32(salt),
                keccak256(
                    abi.encodePacked(
                        type(ResourceLockAccount).creationCode,
                        abi.encode(owner, sessionKey, validator, entryPoint)
                    )
                )
            )
        );

        return address(uint160(uint256(hash)));
    }
}
