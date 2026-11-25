// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ChainTraceRegistry
 * @notice Enterprise decentralized supply-chain registry supporting O(1)-gas Merkle batch
 *         anchoring for 1M+ units, lazy on-chain product materialization, two-step custody
 *         transfers with monotonic nonces, EIP-712 meta-transactions, and sealed claim secrets.
 */
contract ChainTraceRegistry is AccessControl, EIP712, ReentrancyGuard {
    bytes32 public constant MANUFACTURER_ROLE = keccak256("MANUFACTURER_ROLE");
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");
    bytes32 public constant WAREHOUSE_ROLE = keccak256("WAREHOUSE_ROLE");
    bytes32 public constant RETAILER_ROLE = keccak256("RETAILER_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");

    bytes32 public constant TRANSFER_TYPEHASH =
        keccak256(
            "TransferIntent(bytes32 productId,address from,address to,uint64 expectedNonce,uint256 deadline)"
        );

    bytes32 public constant CLAIM_TYPEHASH =
        keccak256(
            "ClaimIntent(bytes32 batchId,bytes32 productId,address claimant,bytes32 claimSecretDigest,uint64 expectedNonce,uint256 deadline)"
        );

    enum CustodyStatus {
        Uninitialized,
        Manufactured,
        InTransit,
        AtDistributor,
        AtWarehouse,
        AtRetailer,
        Claimed,
        Recalled
    }

    struct Batch {
        bytes32 merkleRoot;
        address manufacturer;
        address batchCustodian;
        address pendingBatchCustodian;
        uint64 unitCount;
        uint64 splitCount;
        uint64 createdAt;
        uint64 batchNonce;
        CustodyStatus batchStatus;
        CustodyStatus previousBatchStatus;
        CustodyStatus pendingBatchTargetStatus;
        bool exists;
        bool recalled;
        string ipfsCid;
    }

    struct Product {
        bytes32 batchId;
        bytes32 metadataHash;
        bytes32 claimSecretHash;
        address custodian;
        address pendingCustodian;
        uint64 nonce;
        uint64 updatedAt;
        CustodyStatus status;
        CustodyStatus previousStatus;
        CustodyStatus targetStatus;
        bool initialized;
        bool claimed;
        bool recalled;
    }

    struct AuthenticityResult {
        bool isMerkleValid;
        bool isInitialized;
        bool isRecalled;
        bool isClaimed;
        address currentCustodian;
        address pendingCustodian;
        CustodyStatus currentStatus;
        uint64 currentNonce;
        address manufacturer;
        string ipfsCid;
    }

    mapping(bytes32 => Batch) private _batches;
    mapping(bytes32 => Product) private _products;

    // Custom Errors
    error InvalidZeroAddress();
    error InvalidZeroBytes32();
    error EmptyString(string field);
    error InvalidUnitCount();
    error BatchAlreadyExists(bytes32 batchId);
    error BatchNotFound(bytes32 batchId);
    error BatchMismatch(bytes32 expectedBatchId, bytes32 providedBatchId);
    error ProductNotInitialized(bytes32 productId);
    error InvalidMerkleProof();
    error UnauthorizedCustodian(address expected, address actual);
    error UnauthorizedRecipientRole(address recipient);
    error InvalidPendingCustodian(address expected, address actual);
    error NoPendingTransfer();
    error TransferAlreadyPending();
    error StaleNonce(uint64 expected, uint64 provided);
    error ProductOrBatchRecalled();
    error AlreadyClaimed();
    error InvalidClaimSecret();
    error UnauthorizedClaimWithoutSecret(address custodian, address claimant);
    error InvalidStatusTransition(CustodyStatus current, CustodyStatus next);
    error SelfTransferNotAllowed();
    error SignatureExpired(uint256 deadline, uint256 currentTime);
    error InvalidSignature(address expectedSigner, address recovered);
    error UnauthorizedRecallCaller();

    // Indexed Lifecycle Events
    event BatchRegistered(
        bytes32 indexed batchId,
        address indexed manufacturer,
        bytes32 merkleRoot,
        string ipfsCid,
        uint64 unitCount,
        uint64 timestamp
    );

    event BatchTransferInitiated(
        bytes32 indexed batchId,
        address indexed from,
        address indexed to,
        uint64 batchNonce,
        CustodyStatus targetStatus,
        string shipmentRef
    );

    event BatchCustodyAccepted(
        bytes32 indexed batchId,
        address indexed previousCustodian,
        address indexed newCustodian,
        uint64 batchNonce,
        CustodyStatus newStatus
    );

    event BatchTransferCancelled(
        bytes32 indexed batchId,
        address indexed custodian,
        uint64 batchNonce
    );

    event BatchStatusUpdated(
        bytes32 indexed batchId,
        address indexed custodian,
        CustodyStatus newStatus,
        string locationNote
    );

    event ProductMaterialized(
        bytes32 indexed productId,
        bytes32 indexed batchId,
        address indexed custodian,
        bytes32 metadataHash,
        uint64 timestamp
    );

    event TransferInitiated(
        bytes32 indexed productId,
        bytes32 indexed batchId,
        address indexed from,
        address to,
        uint64 nonce,
        CustodyStatus targetStatus,
        string shipmentRef
    );

    event CustodyAccepted(
        bytes32 indexed productId,
        bytes32 indexed batchId,
        address indexed newCustodian,
        address previousCustodian,
        uint64 nonce,
        CustodyStatus newStatus,
        string locationNote
    );

    event TransferCancelled(
        bytes32 indexed productId,
        address indexed custodian,
        uint64 nonce
    );

    event DeliveryStatusUpdated(
        bytes32 indexed productId,
        address indexed custodian,
        CustodyStatus newStatus,
        string locationNote
    );

    event ProductClaimed(
        bytes32 indexed productId,
        bytes32 indexed batchId,
        address indexed claimant,
        uint64 nonce,
        uint64 timestamp
    );

    event BatchRecalled(
        bytes32 indexed batchId,
        address indexed actor,
        string reason,
        uint64 timestamp
    );

    event ProductFlagged(
        bytes32 indexed productId,
        address indexed actor,
        string reason,
        uint64 timestamp
    );

    constructor(address initialAdmin) EIP712("ChainTraceRegistry", "1") {
        if (initialAdmin == address(0)) revert InvalidZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(AUDITOR_ROLE, initialAdmin);
    }

    // -------------------------------------------------------------------------
    // Hashing & Role Helpers (must match @chaintrace/shared canonical leaf builder)
    // -------------------------------------------------------------------------

    function computeLeaf(
        bytes32 batchId,
        bytes32 productId,
        string calldata serialNumber,
        bytes32 metadataHash,
        bytes32 claimSecretHash
    ) public pure returns (bytes32) {
        bytes32 inner = keccak256(
            abi.encode(batchId, productId, serialNumber, metadataHash, claimSecretHash)
        );
        return keccak256(bytes.concat(inner));
    }

    function _resolveB2BTargetStatus(address account) internal view returns (CustodyStatus) {
        if (hasRole(RETAILER_ROLE, account)) return CustodyStatus.AtRetailer;
        if (hasRole(WAREHOUSE_ROLE, account)) return CustodyStatus.AtWarehouse;
        if (hasRole(DISTRIBUTOR_ROLE, account)) return CustodyStatus.AtDistributor;
        if (hasRole(MANUFACTURER_ROLE, account)) return CustodyStatus.Manufactured;
        revert UnauthorizedRecipientRole(account);
    }

    function _canHoldStatus(address account, CustodyStatus status) internal view returns (bool) {
        if (status == CustodyStatus.InTransit) {
            return
                hasRole(MANUFACTURER_ROLE, account) ||
                hasRole(DISTRIBUTOR_ROLE, account) ||
                hasRole(WAREHOUSE_ROLE, account) ||
                hasRole(RETAILER_ROLE, account);
        }
        if (status == CustodyStatus.Manufactured) return hasRole(MANUFACTURER_ROLE, account);
        if (status == CustodyStatus.AtDistributor) return hasRole(DISTRIBUTOR_ROLE, account);
        if (status == CustodyStatus.AtWarehouse) return hasRole(WAREHOUSE_ROLE, account);
        if (status == CustodyStatus.AtRetailer) return hasRole(RETAILER_ROLE, account);
        return false;
    }

    // -------------------------------------------------------------------------
    // Batch Registration & Whole-Batch Custody
    // -------------------------------------------------------------------------

    function registerBatch(
        bytes32 batchId,
        bytes32 merkleRoot,
        string calldata ipfsCid,
        uint64 unitCount
    ) external onlyRole(MANUFACTURER_ROLE) nonReentrant {
        if (batchId == bytes32(0) || merkleRoot == bytes32(0)) revert InvalidZeroBytes32();
        if (bytes(ipfsCid).length == 0) revert EmptyString("ipfsCid");
        if (unitCount == 0) revert InvalidUnitCount();
        if (_batches[batchId].exists) revert BatchAlreadyExists(batchId);

        uint64 ts = uint64(block.timestamp);
        _batches[batchId] = Batch({
            merkleRoot: merkleRoot,
            manufacturer: msg.sender,
            batchCustodian: msg.sender,
            pendingBatchCustodian: address(0),
            unitCount: unitCount,
            splitCount: 0,
            createdAt: ts,
            batchNonce: 0,
            batchStatus: CustodyStatus.Manufactured,
            previousBatchStatus: CustodyStatus.Manufactured,
            pendingBatchTargetStatus: CustodyStatus.Uninitialized,
            exists: true,
            recalled: false,
            ipfsCid: ipfsCid
        });

        emit BatchRegistered(batchId, msg.sender, merkleRoot, ipfsCid, unitCount, ts);
    }

    function initiateBatchTransfer(
        bytes32 batchId,
        address to,
        uint64 expectedBatchNonce,
        string calldata shipmentRef
    ) external nonReentrant {
        Batch storage batch = _batches[batchId];
        if (!batch.exists) revert BatchNotFound(batchId);
        if (batch.recalled) revert ProductOrBatchRecalled();
        if (batch.batchCustodian != msg.sender) {
            revert UnauthorizedCustodian(batch.batchCustodian, msg.sender);
        }
        if (to == address(0)) revert InvalidZeroAddress();
        if (to == msg.sender) revert SelfTransferNotAllowed();
        if (batch.pendingBatchCustodian != address(0)) revert TransferAlreadyPending();
        if (batch.batchNonce != expectedBatchNonce) {
            revert StaleNonce(batch.batchNonce, expectedBatchNonce);
        }

        CustodyStatus targetStatus = _resolveB2BTargetStatus(to);
        batch.previousBatchStatus = batch.batchStatus;
        batch.pendingBatchCustodian = to;
        batch.pendingBatchTargetStatus = targetStatus;
        batch.batchStatus = CustodyStatus.InTransit;
        batch.batchNonce += 1;

        emit BatchTransferInitiated(
            batchId,
            msg.sender,
            to,
            batch.batchNonce,
            targetStatus,
            shipmentRef
        );
    }

    function acceptBatchCustody(bytes32 batchId, uint64 expectedBatchNonce) external nonReentrant {
        Batch storage batch = _batches[batchId];
        if (!batch.exists) revert BatchNotFound(batchId);
        if (batch.recalled) revert ProductOrBatchRecalled();
        if (batch.pendingBatchCustodian == address(0)) revert NoPendingTransfer();
        if (batch.pendingBatchCustodian != msg.sender) {
            revert InvalidPendingCustodian(batch.pendingBatchCustodian, msg.sender);
        }
        if (batch.batchNonce != expectedBatchNonce) {
            revert StaleNonce(batch.batchNonce, expectedBatchNonce);
        }

        CustodyStatus verifiedTarget = _resolveB2BTargetStatus(msg.sender);
        address previousCustodian = batch.batchCustodian;
        batch.batchCustodian = msg.sender;
        batch.pendingBatchCustodian = address(0);
        batch.batchStatus = verifiedTarget;
        batch.previousBatchStatus = verifiedTarget;
        batch.pendingBatchTargetStatus = CustodyStatus.Uninitialized;
        batch.batchNonce += 1;

        emit BatchCustodyAccepted(
            batchId,
            previousCustodian,
            msg.sender,
            batch.batchNonce,
            verifiedTarget
        );
    }

    function cancelBatchTransfer(bytes32 batchId, uint64 expectedBatchNonce) external nonReentrant {
        Batch storage batch = _batches[batchId];
        if (!batch.exists) revert BatchNotFound(batchId);
        if (batch.batchCustodian != msg.sender) {
            revert UnauthorizedCustodian(batch.batchCustodian, msg.sender);
        }
        if (batch.pendingBatchCustodian == address(0)) revert NoPendingTransfer();
        if (batch.batchNonce != expectedBatchNonce) {
            revert StaleNonce(batch.batchNonce, expectedBatchNonce);
        }

        batch.pendingBatchCustodian = address(0);
        batch.pendingBatchTargetStatus = CustodyStatus.Uninitialized;
        batch.batchStatus = batch.previousBatchStatus;
        batch.batchNonce += 1;

        emit BatchTransferCancelled(batchId, msg.sender, batch.batchNonce);
    }

    function updateBatchDeliveryStatus(
        bytes32 batchId,
        CustodyStatus newStatus,
        string calldata locationNote
    ) external nonReentrant {
        Batch storage batch = _batches[batchId];
        if (!batch.exists) revert BatchNotFound(batchId);
        if (batch.recalled) revert ProductOrBatchRecalled();
        if (batch.batchCustodian != msg.sender) {
            revert UnauthorizedCustodian(batch.batchCustodian, msg.sender);
        }
        if (batch.pendingBatchCustodian != address(0)) revert TransferAlreadyPending();
        if (!_canHoldStatus(msg.sender, newStatus)) {
            revert InvalidStatusTransition(batch.batchStatus, newStatus);
        }

        batch.batchStatus = newStatus;
        batch.previousBatchStatus = newStatus;
        emit BatchStatusUpdated(batchId, msg.sender, newStatus, locationNote);
    }

    // -------------------------------------------------------------------------
    // Lazy Product Materialization & Individual Custody Transfers
    // -------------------------------------------------------------------------

    function _ensureMaterialized(
        bytes32 batchId,
        bytes32 productId,
        string calldata serialNumber,
        bytes32 metadataHash,
        bytes32 claimSecretHash,
        bytes32[] calldata merkleProof,
        bool allowPendingBatch
    ) internal returns (Product storage product, Batch storage batch) {
        batch = _batches[batchId];
        if (!batch.exists) revert BatchNotFound(batchId);
        if (batch.recalled) revert ProductOrBatchRecalled();
        if (productId == bytes32(0)) revert InvalidZeroBytes32();

        product = _products[productId];
        if (!product.initialized) {
            if (!allowPendingBatch && batch.pendingBatchCustodian != address(0)) {
                revert TransferAlreadyPending();
            }
            bytes32 leaf = computeLeaf(
                batchId,
                productId,
                serialNumber,
                metadataHash,
                claimSecretHash
            );
            if (!MerkleProof.verify(merkleProof, batch.merkleRoot, leaf)) {
                revert InvalidMerkleProof();
            }

            uint64 ts = uint64(block.timestamp);
            product.batchId = batchId;
            product.metadataHash = metadataHash;
            product.claimSecretHash = claimSecretHash;
            product.custodian = batch.batchCustodian;
            product.pendingCustodian = address(0);
            product.nonce = 0;
            product.updatedAt = ts;
            product.status = batch.batchStatus;
            product.previousStatus = batch.batchStatus;
            product.targetStatus = CustodyStatus.Uninitialized;
            product.initialized = true;
            product.claimed = false;
            product.recalled = false;

            batch.splitCount += 1;

            emit ProductMaterialized(productId, batchId, batch.batchCustodian, metadataHash, ts);
        } else if (product.batchId != batchId) {
            revert BatchMismatch(product.batchId, batchId);
        }
    }

    function _initiateProductTransfer(
        Product storage product,
        bytes32 productId,
        address sender,
        address to,
        uint64 expectedNonce,
        string calldata shipmentRef
    ) internal {
        if (product.recalled || _batches[product.batchId].recalled) {
            revert ProductOrBatchRecalled();
        }
        if (product.claimed) revert AlreadyClaimed();
        if (product.custodian != sender) {
            revert UnauthorizedCustodian(product.custodian, sender);
        }
        if (to == address(0)) revert InvalidZeroAddress();
        if (to == sender) revert SelfTransferNotAllowed();
        if (product.pendingCustodian != address(0)) revert TransferAlreadyPending();
        if (product.nonce != expectedNonce) {
            revert StaleNonce(product.nonce, expectedNonce);
        }

        CustodyStatus targetStatus = _resolveB2BTargetStatus(to);
        product.previousStatus = product.status;
        product.pendingCustodian = to;
        product.targetStatus = targetStatus;
        product.status = CustodyStatus.InTransit;
        product.nonce += 1;
        product.updatedAt = uint64(block.timestamp);

        emit TransferInitiated(
            productId,
            product.batchId,
            sender,
            to,
            product.nonce,
            targetStatus,
            shipmentRef
        );
    }

    function materializeAndInitiateTransfer(
        bytes32 batchId,
        bytes32 productId,
        string calldata serialNumber,
        bytes32 metadataHash,
        bytes32 claimSecretHash,
        bytes32[] calldata merkleProof,
        address to,
        uint64 expectedNonce,
        string calldata shipmentRef
    ) external nonReentrant {
        (Product storage product, ) = _ensureMaterialized(
            batchId,
            productId,
            serialNumber,
            metadataHash,
            claimSecretHash,
            merkleProof,
            false
        );
        _initiateProductTransfer(product, productId, msg.sender, to, expectedNonce, shipmentRef);
    }

    function initiateTransfer(
        bytes32 productId,
        address to,
        uint64 expectedNonce,
        string calldata shipmentRef
    ) external nonReentrant {
        Product storage product = _products[productId];
        if (!product.initialized) revert ProductNotInitialized(productId);
        _initiateProductTransfer(product, productId, msg.sender, to, expectedNonce, shipmentRef);
    }

    function executeTransferBySig(
        bytes32 productId,
        address from,
        address to,
        uint64 expectedNonce,
        uint256 deadline,
        string calldata shipmentRef,
        bytes calldata signature
    ) external nonReentrant {
        if (block.timestamp > deadline) revert SignatureExpired(deadline, block.timestamp);
        Product storage product = _products[productId];
        if (!product.initialized) revert ProductNotInitialized(productId);

        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_TYPEHASH, productId, from, to, expectedNonce, deadline)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        if (signer == address(0) || signer != from) {
            revert InvalidSignature(from, signer);
        }

        _initiateProductTransfer(product, productId, from, to, expectedNonce, shipmentRef);
    }

    function acceptCustody(
        bytes32 productId,
        uint64 expectedNonce,
        string calldata locationNote
    ) external nonReentrant {
        Product storage product = _products[productId];
        if (!product.initialized) revert ProductNotInitialized(productId);
        if (product.recalled || _batches[product.batchId].recalled) {
            revert ProductOrBatchRecalled();
        }
        if (product.pendingCustodian == address(0)) revert NoPendingTransfer();
        if (product.pendingCustodian != msg.sender) {
            revert InvalidPendingCustodian(product.pendingCustodian, msg.sender);
        }
        if (product.nonce != expectedNonce) {
            revert StaleNonce(product.nonce, expectedNonce);
        }

        CustodyStatus verifiedTarget = _resolveB2BTargetStatus(msg.sender);
        address previousCustodian = product.custodian;
        product.custodian = msg.sender;
        product.pendingCustodian = address(0);
        product.status = verifiedTarget;
        product.previousStatus = verifiedTarget;
        product.targetStatus = CustodyStatus.Uninitialized;
        product.nonce += 1;
        product.updatedAt = uint64(block.timestamp);

        emit CustodyAccepted(
            productId,
            product.batchId,
            msg.sender,
            previousCustodian,
            product.nonce,
            verifiedTarget,
            locationNote
        );
    }

    function cancelTransfer(bytes32 productId, uint64 expectedNonce) external nonReentrant {
        Product storage product = _products[productId];
        if (!product.initialized) revert ProductNotInitialized(productId);
        if (product.custodian != msg.sender) {
            revert UnauthorizedCustodian(product.custodian, msg.sender);
        }
        if (product.pendingCustodian == address(0)) revert NoPendingTransfer();
        if (product.nonce != expectedNonce) {
            revert StaleNonce(product.nonce, expectedNonce);
        }

        product.pendingCustodian = address(0);
        product.targetStatus = CustodyStatus.Uninitialized;
        product.status = product.previousStatus;
        product.nonce += 1;
        product.updatedAt = uint64(block.timestamp);

        emit TransferCancelled(productId, msg.sender, product.nonce);
    }

    function updateDeliveryStatus(
        bytes32 productId,
        CustodyStatus newStatus,
        string calldata locationNote
    ) external nonReentrant {
        Product storage product = _products[productId];
        if (!product.initialized) revert ProductNotInitialized(productId);
        if (product.recalled || _batches[product.batchId].recalled) {
            revert ProductOrBatchRecalled();
        }
        if (product.claimed) revert AlreadyClaimed();
        if (product.pendingCustodian != address(0)) revert TransferAlreadyPending();
        if (product.custodian != msg.sender) {
            revert UnauthorizedCustodian(product.custodian, msg.sender);
        }
        if (!_canHoldStatus(msg.sender, newStatus)) {
            revert InvalidStatusTransition(product.status, newStatus);
        }

        product.status = newStatus;
        product.previousStatus = newStatus;
        product.updatedAt = uint64(block.timestamp);

        emit DeliveryStatusUpdated(productId, msg.sender, newStatus, locationNote);
    }

    // -------------------------------------------------------------------------
    // Customer Sealed Claim & Anti-Counterfeit Verification
    // -------------------------------------------------------------------------

    function _claim(
        Product storage product,
        bytes32 productId,
        address claimant,
        string calldata claimSecret
    ) internal {
        if (product.recalled || _batches[product.batchId].recalled) {
            revert ProductOrBatchRecalled();
        }
        if (product.claimed) revert AlreadyClaimed();
        if (product.pendingCustodian != address(0)) revert TransferAlreadyPending();
        if (
            product.status != CustodyStatus.AtRetailer &&
            product.status != CustodyStatus.Manufactured
        ) {
            revert InvalidStatusTransition(product.status, CustodyStatus.Claimed);
        }
        if (product.claimSecretHash != bytes32(0)) {
            if (bytes(claimSecret).length == 0) revert InvalidClaimSecret();
            if (keccak256(abi.encodePacked(claimSecret)) != product.claimSecretHash) {
                revert InvalidClaimSecret();
            }
        } else if (claimant != product.custodian) {
            revert UnauthorizedClaimWithoutSecret(product.custodian, claimant);
        }

        uint64 ts = uint64(block.timestamp);
        product.claimed = true;
        product.custodian = claimant;
        product.status = CustodyStatus.Claimed;
        product.nonce += 1;
        product.updatedAt = ts;

        emit ProductClaimed(productId, product.batchId, claimant, product.nonce, ts);
    }

    function claimProduct(
        bytes32 batchId,
        bytes32 productId,
        string calldata serialNumber,
        bytes32 metadataHash,
        bytes32 claimSecretHash,
        bytes32[] calldata merkleProof,
        string calldata claimSecret
    ) external nonReentrant {
        (Product storage product, ) = _ensureMaterialized(
            batchId,
            productId,
            serialNumber,
            metadataHash,
            claimSecretHash,
            merkleProof,
            false
        );
        _claim(product, productId, msg.sender, claimSecret);
    }

    function claimProductBySig(
        bytes32 batchId,
        bytes32 productId,
        string calldata serialNumber,
        bytes32 metadataHash,
        bytes32 claimSecretHash,
        bytes32[] calldata merkleProof,
        address claimant,
        string calldata claimSecret,
        uint64 expectedNonce,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (claimant == address(0)) revert InvalidZeroAddress();
        if (block.timestamp > deadline) revert SignatureExpired(deadline, block.timestamp);

        (Product storage product, ) = _ensureMaterialized(
            batchId,
            productId,
            serialNumber,
            metadataHash,
            claimSecretHash,
            merkleProof,
            false
        );

        if (product.nonce != expectedNonce) {
            revert StaleNonce(product.nonce, expectedNonce);
        }

        bytes32 claimSecretDigest = keccak256(abi.encodePacked(claimSecret));
        bytes32 structHash = keccak256(
            abi.encode(
                CLAIM_TYPEHASH,
                batchId,
                productId,
                claimant,
                claimSecretDigest,
                expectedNonce,
                deadline
            )
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer == address(0) || signer != claimant) {
            revert InvalidSignature(claimant, signer);
        }

        _claim(product, productId, claimant, claimSecret);
    }

    // -------------------------------------------------------------------------
    // Recall & Suspicious Product Flagging
    // -------------------------------------------------------------------------

    function recallBatch(bytes32 batchId, string calldata reason) external nonReentrant {
        Batch storage batch = _batches[batchId];
        if (!batch.exists) revert BatchNotFound(batchId);
        if (
            msg.sender != batch.manufacturer &&
            !hasRole(DEFAULT_ADMIN_ROLE, msg.sender) &&
            !hasRole(AUDITOR_ROLE, msg.sender)
        ) {
            revert UnauthorizedRecallCaller();
        }
        if (bytes(reason).length == 0) revert EmptyString("reason");

        batch.recalled = true;
        batch.batchStatus = CustodyStatus.Recalled;
        emit BatchRecalled(batchId, msg.sender, reason, uint64(block.timestamp));
    }

    function flagProduct(bytes32 productId, string calldata reason) external nonReentrant {
        Product storage product = _products[productId];
        if (!product.initialized) revert ProductNotInitialized(productId);
        Batch storage batch = _batches[product.batchId];

        if (
            msg.sender != batch.manufacturer &&
            !hasRole(DEFAULT_ADMIN_ROLE, msg.sender) &&
            !hasRole(AUDITOR_ROLE, msg.sender)
        ) {
            revert UnauthorizedRecallCaller();
        }
        if (bytes(reason).length == 0) revert EmptyString("reason");

        product.recalled = true;
        product.status = CustodyStatus.Recalled;
        product.updatedAt = uint64(block.timestamp);
        emit ProductFlagged(productId, msg.sender, reason, uint64(block.timestamp));
    }

    function flagProductWithProof(
        bytes32 batchId,
        bytes32 productId,
        string calldata serialNumber,
        bytes32 metadataHash,
        bytes32 claimSecretHash,
        bytes32[] calldata merkleProof,
        string calldata reason
    ) external nonReentrant {
        Batch storage batch = _batches[batchId];
        if (!batch.exists) revert BatchNotFound(batchId);
        if (
            msg.sender != batch.manufacturer &&
            !hasRole(DEFAULT_ADMIN_ROLE, msg.sender) &&
            !hasRole(AUDITOR_ROLE, msg.sender)
        ) {
            revert UnauthorizedRecallCaller();
        }
        if (bytes(reason).length == 0) revert EmptyString("reason");

        (Product storage product, ) = _ensureMaterialized(
            batchId,
            productId,
            serialNumber,
            metadataHash,
            claimSecretHash,
            merkleProof,
            true
        );

        product.recalled = true;
        product.status = CustodyStatus.Recalled;
        product.updatedAt = uint64(block.timestamp);
        emit ProductFlagged(productId, msg.sender, reason, uint64(block.timestamp));
    }

    // -------------------------------------------------------------------------
    // Trustless Read / Independent Verification Views
    // -------------------------------------------------------------------------

    function getBatch(bytes32 batchId) external view returns (Batch memory) {
        if (!_batches[batchId].exists) revert BatchNotFound(batchId);
        return _batches[batchId];
    }

    function getProduct(bytes32 productId) external view returns (Product memory) {
        return _products[productId];
    }

    function verifyProductAuthenticity(
        bytes32 batchId,
        bytes32 productId,
        string calldata serialNumber,
        bytes32 metadataHash,
        bytes32 claimSecretHash,
        bytes32[] calldata merkleProof
    ) external view returns (AuthenticityResult memory result) {
        Batch storage batch = _batches[batchId];
        if (!batch.exists) {
            return result;
        }

        bytes32 leaf = computeLeaf(batchId, productId, serialNumber, metadataHash, claimSecretHash);
        bool merkleOk = MerkleProof.verify(merkleProof, batch.merkleRoot, leaf);

        Product storage product = _products[productId];
        if (!product.initialized) {
            return AuthenticityResult({
                isMerkleValid: merkleOk,
                isInitialized: false,
                isRecalled: batch.recalled,
                isClaimed: false,
                currentCustodian: batch.batchCustodian,
                pendingCustodian: batch.pendingBatchCustodian,
                currentStatus: batch.recalled ? CustodyStatus.Recalled : batch.batchStatus,
                currentNonce: 0,
                manufacturer: batch.manufacturer,
                ipfsCid: batch.ipfsCid
            });
        }

        bool recalled = batch.recalled || product.recalled;
        return AuthenticityResult({
            isMerkleValid: merkleOk && product.batchId == batchId,
            isInitialized: true,
            isRecalled: recalled,
            isClaimed: product.claimed,
            currentCustodian: product.custodian,
            pendingCustodian: product.pendingCustodian,
            currentStatus: recalled ? CustodyStatus.Recalled : product.status,
            currentNonce: product.nonce,
            manufacturer: batch.manufacturer,
            ipfsCid: batch.ipfsCid
        });
    }
}
