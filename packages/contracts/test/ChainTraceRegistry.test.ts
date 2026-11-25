import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { ChainTraceRegistry } from '../typechain-types';

function hashPair(a: string, b: string): string {
  const [first, second] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
  return ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32'], [first, second]));
}

function buildMerkleTree(leaves: string[]) {
  if (leaves.length === 0) throw new Error('Empty leaves');
  const layers: string[][] = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next: string[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      if (i + 1 < prev.length) {
        next.push(hashPair(prev[i], prev[i + 1]));
      } else {
        next.push(prev[i]);
      }
    }
    layers.push(next);
  }
  const root = layers[layers.length - 1][0];
  const getProof = (index: number): string[] => {
    const proof: string[] = [];
    let idx = index;
    for (let level = 0; level < layers.length - 1; level++) {
      const layer = layers[level];
      const pairIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (pairIdx < layer.length) {
        proof.push(layer[pairIdx]);
      }
      idx = Math.floor(idx / 2);
    }
    return proof;
  };
  return { root, getProof };
}

function computeLeaf(
  batchId: string,
  productId: string,
  serialNumber: string,
  metadataHash: string,
  claimSecretHash: string,
): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const inner = ethers.keccak256(
    abiCoder.encode(
      ['bytes32', 'bytes32', 'string', 'bytes32', 'bytes32'],
      [batchId, productId, serialNumber, metadataHash, claimSecretHash],
    ),
  );
  return ethers.keccak256(inner);
}

describe('ChainTraceRegistry', function () {
  async function deployFixture() {
    const [admin, manufacturer, distributor, warehouse, retailer, customer, attacker, distributor2] =
      await ethers.getSigners();

    const Factory = await ethers.getContractFactory('ChainTraceRegistry');
    const registry = (await Factory.deploy(admin.address)) as ChainTraceRegistry;

    await registry.grantRole(await registry.MANUFACTURER_ROLE(), manufacturer.address);
    await registry.grantRole(await registry.DISTRIBUTOR_ROLE(), distributor.address);
    await registry.grantRole(await registry.DISTRIBUTOR_ROLE(), distributor2.address);
    await registry.grantRole(await registry.WAREHOUSE_ROLE(), warehouse.address);
    await registry.grantRole(await registry.RETAILER_ROLE(), retailer.address);

    const batchId = ethers.keccak256(ethers.toUtf8Bytes('BATCH-2026-001'));
    const ipfsCid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

    const items = Array.from({ length: 8 }, (_, idx) => {
      const serial = `SN-ELEC-${1000 + idx}`;
      const productId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['address', 'bytes32', 'string'],
          [manufacturer.address, batchId, serial],
        ),
      );
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(`{"serial":"${serial}"}`));
      const claimSecret = `SECRET-${idx}-XYZ`;
      const claimSecretHash = ethers.keccak256(ethers.toUtf8Bytes(claimSecret));
      const leaf = computeLeaf(batchId, productId, serial, metadataHash, claimSecretHash);
      return { serial, productId, metadataHash, claimSecret, claimSecretHash, leaf };
    });

    const tree = buildMerkleTree(items.map((x) => x.leaf));

    return {
      registry,
      admin,
      manufacturer,
      distributor,
      distributor2,
      warehouse,
      retailer,
      customer,
      attacker,
      batchId,
      ipfsCid,
      items,
      tree,
    };
  }

  describe('Batch Registration & O(1) Gas Scaling', function () {
    it('registers batches in constant O(1) gas regardless of 100 vs 1,000,000 unit count', async function () {
      const { registry, manufacturer, ipfsCid, tree } = await loadFixture(deployFixture);

      const bSmall = ethers.keccak256(ethers.toUtf8Bytes('BATCH-SMALL'));
      const bMega = ethers.keccak256(ethers.toUtf8Bytes('BATCH-1M'));

      const tx1 = await registry
        .connect(manufacturer)
        .registerBatch(bSmall, tree.root, ipfsCid, 100);
      const rc1 = await tx1.wait();

      const tx2 = await registry
        .connect(manufacturer)
        .registerBatch(bMega, tree.root, ipfsCid, 1_000_000);
      const rc2 = await tx2.wait();

      // 100 (0x64) vs 1_000_000 (0x0f4240) differs only by calldata non-zero byte cost (24 gas)
      const gasDiff = rc2!.gasUsed >= rc1!.gasUsed ? rc2!.gasUsed - rc1!.gasUsed : rc1!.gasUsed - rc2!.gasUsed;
      expect(gasDiff).to.be.lessThan(100n);
      expect(rc2!.gasUsed).to.be.lessThan(220_000n);
      const batch = await registry.getBatch(bMega);
      expect(batch.unitCount).to.equal(1_000_000n);
      expect(batch.merkleRoot).to.equal(tree.root);
    });

    it('rejects registration from non-manufacturer, duplicate batch, empty CID, or zero unitCount', async function () {
      const { registry, manufacturer, attacker, batchId, ipfsCid, tree } =
        await loadFixture(deployFixture);

      await expect(
        registry.connect(attacker).registerBatch(batchId, tree.root, ipfsCid, 100),
      ).to.be.revertedWithCustomError(registry, 'AccessControlUnauthorizedAccount');

      await expect(
        registry.connect(manufacturer).registerBatch(batchId, tree.root, '', 100),
      ).to.be.revertedWithCustomError(registry, 'EmptyString');

      await expect(
        registry.connect(manufacturer).registerBatch(batchId, tree.root, ipfsCid, 0),
      ).to.be.revertedWithCustomError(registry, 'InvalidUnitCount');

      await registry.connect(manufacturer).registerBatch(batchId, tree.root, ipfsCid, 8);
      await expect(
        registry.connect(manufacturer).registerBatch(batchId, tree.root, ipfsCid, 8),
      ).to.be.revertedWithCustomError(registry, 'BatchAlreadyExists');
    });
  });

  describe('Full Supply Chain Lifecycle & Independent Verification', function () {
    it('completes Manufacturer -> Distributor -> Warehouse -> Retailer -> Customer Claim', async function () {
      const {
        registry,
        manufacturer,
        distributor,
        warehouse,
        retailer,
        customer,
        batchId,
        ipfsCid,
        items,
        tree,
      } = await loadFixture(deployFixture);

      await registry.connect(manufacturer).registerBatch(batchId, tree.root, ipfsCid, 8);
      const unit = items[3];
      const proof = tree.getProof(3);

      // Before individual split: verifyProductAuthenticity proves authenticity via batch custody
      const preVerify = await registry.verifyProductAuthenticity(
        batchId,
        unit.productId,
        unit.serial,
        unit.metadataHash,
        unit.claimSecretHash,
        proof,
      );
      expect(preVerify.isMerkleValid).to.equal(true);
      expect(preVerify.isInitialized).to.equal(false);
      expect(preVerify.currentCustodian).to.equal(manufacturer.address);
      expect(preVerify.currentStatus).to.equal(1n); // Manufactured

      // 1. Manufacturer materializes & initiates transfer to Distributor
      await registry
        .connect(manufacturer)
        .materializeAndInitiateTransfer(
          batchId,
          unit.productId,
          unit.serial,
          unit.metadataHash,
          unit.claimSecretHash,
          proof,
          distributor.address,
          0,
          'AIRWAY-BILL-101',
        );

      // 2. Distributor accepts custody (nonce = 1)
      await registry.connect(distributor).acceptCustody(unit.productId, 1, 'Hub-Mumbai');
      // 3. Distributor -> Warehouse (nonce = 2 -> 3)
      await registry
        .connect(distributor)
        .initiateTransfer(unit.productId, warehouse.address, 2, 'TRUCK-55');
      await registry.connect(warehouse).acceptCustody(unit.productId, 3, 'WH-North-Bay-4');
      // 4. Warehouse -> Retailer (nonce = 4 -> 5)
      await registry
        .connect(warehouse)
        .initiateTransfer(unit.productId, retailer.address, 4, 'VAN-19');
      await registry.connect(retailer).acceptCustody(unit.productId, 5, 'Store-Flagship');

      // 5. Customer claims ownership using sealed QR secret
      await registry
        .connect(customer)
        .claimProduct(
          batchId,
          unit.productId,
          unit.serial,
          unit.metadataHash,
          unit.claimSecretHash,
          proof,
          unit.claimSecret,
        );

      const postVerify = await registry.verifyProductAuthenticity(
        batchId,
        unit.productId,
        unit.serial,
        unit.metadataHash,
        unit.claimSecretHash,
        proof,
      );
      expect(postVerify.isMerkleValid).to.equal(true);
      expect(postVerify.isInitialized).to.equal(true);
      expect(postVerify.isClaimed).to.equal(true);
      expect(postVerify.currentCustodian).to.equal(customer.address);
      expect(postVerify.currentStatus).to.equal(6n); // Claimed

      // Cloned QR attack: second customer scanning same secret MUST revert
      await expect(
        registry
          .connect(customer)
          .claimProduct(
            batchId,
            unit.productId,
            unit.serial,
            unit.metadataHash,
            unit.claimSecretHash,
            proof,
            unit.claimSecret,
          ),
      ).to.be.revertedWithCustomError(registry, 'AlreadyClaimed');
    });

    it('supports whole-batch transfer and independent unit split afterward', async function () {
      const {
        registry,
        manufacturer,
        distributor,
        distributor2,
        retailer,
        batchId,
        ipfsCid,
        items,
        tree,
      } = await loadFixture(deployFixture);

      await registry.connect(manufacturer).registerBatch(batchId, tree.root, ipfsCid, 8);
      await registry
        .connect(manufacturer)
        .initiateBatchTransfer(batchId, distributor.address, 0, 'PALLET-WHOLE-1');
      await registry.connect(distributor).acceptBatchCustody(batchId, 1);

      // Distributor splits item[0] to Retailer while holding whole batch
      await registry
        .connect(distributor)
        .materializeAndInitiateTransfer(
          batchId,
          items[0].productId,
          items[0].serial,
          items[0].metadataHash,
          items[0].claimSecretHash,
          tree.getProof(0),
          retailer.address,
          0,
          'RETAIL-SPLIT-1',
        );
      await registry.connect(retailer).acceptCustody(items[0].productId, 1, 'Retail-A');

      // Distributor transfers remaining batch to Distributor2
      await registry
        .connect(distributor)
        .initiateBatchTransfer(batchId, distributor2.address, 2, 'PALLET-REMAINDER');
      await registry.connect(distributor2).acceptBatchCustody(batchId, 3);

      // Distributor2 CANNOT hijack already-split item[0]
      await expect(
        registry
          .connect(distributor2)
          .materializeAndInitiateTransfer(
            batchId,
            items[0].productId,
            items[0].serial,
            items[0].metadataHash,
            items[0].claimSecretHash,
            tree.getProof(0),
            retailer.address,
            0,
            'HIJACK',
          ),
      ).to.be.revertedWithCustomError(registry, 'UnauthorizedCustodian');

      // Distributor2 CAN transfer unsplit item[1]
      await expect(
        registry
          .connect(distributor2)
          .materializeAndInitiateTransfer(
            batchId,
            items[1].productId,
            items[1].serial,
            items[1].metadataHash,
            items[1].claimSecretHash,
            tree.getProof(1),
            retailer.address,
            0,
            'LEGIT-SPLIT-2',
          ),
      ).to.emit(registry, 'TransferInitiated');
    });
  });

  describe('Concurrency, Security & Replay Attack Protections', function () {
    it('prevents concurrent conflicting transfer via monotonic nonce and pending lock', async function () {
      const {
        registry,
        manufacturer,
        distributor,
        warehouse,
        retailer,
        batchId,
        ipfsCid,
        items,
        tree,
      } = await loadFixture(deployFixture);

      await registry.connect(manufacturer).registerBatch(batchId, tree.root, ipfsCid, 8);
      const unit = items[0];
      const proof = tree.getProof(0);

      await registry
        .connect(manufacturer)
        .materializeAndInitiateTransfer(
          batchId,
          unit.productId,
          unit.serial,
          unit.metadataHash,
          unit.claimSecretHash,
          proof,
          distributor.address,
          0,
          'SHIP-1',
        );

      // Second concurrent call while first is pending fails with TransferAlreadyPending
      await expect(
        registry.connect(manufacturer).initiateTransfer(unit.productId, warehouse.address, 0, 'SHIP-2'),
      ).to.be.revertedWithCustomError(registry, 'TransferAlreadyPending');

      await registry.connect(distributor).acceptCustody(unit.productId, 1, 'Dock-1');

      // Using stale nonce = 1 fails deterministically with StaleNonce
      await expect(
        registry.connect(distributor).initiateTransfer(unit.productId, retailer.address, 1, 'SHIP-3'),
      )
        .to.be.revertedWithCustomError(registry, 'StaleNonce')
        .withArgs(2n, 1n);
    });

    it('rejects tampered Merkle proof, wrong claim secret, unauthorized custodian, and zero address', async function () {
      const {
        registry,
        manufacturer,
        distributor,
        attacker,
        customer,
        batchId,
        ipfsCid,
        items,
        tree,
      } = await loadFixture(deployFixture);

      await registry.connect(manufacturer).registerBatch(batchId, tree.root, ipfsCid, 8);
      const unit = items[2];
      const proof = tree.getProof(2);

      // Tampered serial fails Merkle verification
      await expect(
        registry
          .connect(manufacturer)
          .materializeAndInitiateTransfer(
            batchId,
            unit.productId,
            'SN-FAKE-9999',
            unit.metadataHash,
            unit.claimSecretHash,
            proof,
            distributor.address,
            0,
            'SHIP',
          ),
      ).to.be.revertedWithCustomError(registry, 'InvalidMerkleProof');

      // Attacker cannot initiate transfer of manufacturer batch unit
      await expect(
        registry
          .connect(attacker)
          .materializeAndInitiateTransfer(
            batchId,
            unit.productId,
            unit.serial,
            unit.metadataHash,
            unit.claimSecretHash,
            proof,
            distributor.address,
            0,
            'STEAL',
          ),
      ).to.be.revertedWithCustomError(registry, 'UnauthorizedCustodian');

      // Wrong claim secret rejected
      await expect(
        registry
          .connect(customer)
          .claimProduct(
            batchId,
            unit.productId,
            unit.serial,
            unit.metadataHash,
            unit.claimSecretHash,
            proof,
            'WRONG-SECRET',
          ),
      ).to.be.revertedWithCustomError(registry, 'InvalidClaimSecret');

      // Transfer to unprivileged wallet or zero address rejected
      await expect(
        registry
          .connect(manufacturer)
          .materializeAndInitiateTransfer(
            batchId,
            unit.productId,
            unit.serial,
            unit.metadataHash,
            unit.claimSecretHash,
            proof,
            ethers.ZeroAddress,
            0,
            'ZERO',
          ),
      ).to.be.revertedWithCustomError(registry, 'InvalidZeroAddress');

      await expect(
        registry
          .connect(manufacturer)
          .materializeAndInitiateTransfer(
            batchId,
            unit.productId,
            unit.serial,
            unit.metadataHash,
            unit.claimSecretHash,
            proof,
            attacker.address,
            0,
            'UNPRIVILEGED',
          ),
      ).to.be.revertedWithCustomError(registry, 'UnauthorizedRecipientRole');
    });

    it('supports EIP-712 signed meta-transactions and rejects signature replay & expiry', async function () {
      const {
        registry,
        manufacturer,
        distributor,
        customer,
        attacker,
        batchId,
        ipfsCid,
        items,
        tree,
      } = await loadFixture(deployFixture);

      await registry.connect(manufacturer).registerBatch(batchId, tree.root, ipfsCid, 8);
      const unit = items[4];
      const proof = tree.getProof(4);

      const latest = await time.latest();
      const deadline = BigInt(latest + 3600);
      const network = await ethers.provider.getNetwork();
      const domain = {
        name: 'ChainTraceRegistry',
        version: '1',
        chainId: network.chainId,
        verifyingContract: await registry.getAddress(),
      };
      const types = {
        ClaimIntent: [
          { name: 'batchId', type: 'bytes32' },
          { name: 'productId', type: 'bytes32' },
          { name: 'claimant', type: 'address' },
          { name: 'claimSecretDigest', type: 'bytes32' },
          { name: 'expectedNonce', type: 'uint64' },
          { name: 'deadline', type: 'uint256' },
        ],
      };
      const claimSecretDigest = ethers.keccak256(ethers.toUtf8Bytes(unit.claimSecret));
      const sig = await customer.signTypedData(domain, types, {
        batchId,
        productId: unit.productId,
        claimant: customer.address,
        claimSecretDigest,
        expectedNonce: 0n,
        deadline,
      });

      // Relayer (distributor account) submits gasless claim on behalf of customer
      await registry
        .connect(distributor)
        .claimProductBySig(
          batchId,
          unit.productId,
          unit.serial,
          unit.metadataHash,
          unit.claimSecretHash,
          proof,
          customer.address,
          unit.claimSecret,
          0n,
          deadline,
          sig,
        );

      // Replay fails due to nonce bump (0 -> 1)
      await expect(
        registry
          .connect(attacker)
          .claimProductBySig(
            batchId,
            unit.productId,
            unit.serial,
            unit.metadataHash,
            unit.claimSecretHash,
            proof,
            customer.address,
            unit.claimSecret,
            0n,
            deadline,
            sig,
          ),
      ).to.be.revertedWithCustomError(registry, 'StaleNonce');

      // Expired signature fails
      const unit2 = items[5];
      const expiredDeadline = BigInt(latest - 10);
      const expiredSig = await customer.signTypedData(domain, types, {
        batchId,
        productId: unit2.productId,
        claimant: customer.address,
        claimSecretDigest: ethers.keccak256(ethers.toUtf8Bytes(unit2.claimSecret)),
        expectedNonce: 0n,
        deadline: expiredDeadline,
      });
      await expect(
        registry
          .connect(distributor)
          .claimProductBySig(
            batchId,
            unit2.productId,
            unit2.serial,
            unit2.metadataHash,
            unit2.claimSecretHash,
            tree.getProof(5),
            customer.address,
            unit2.claimSecret,
            0n,
            expiredDeadline,
            expiredSig,
          ),
      ).to.be.revertedWithCustomError(registry, 'SignatureExpired');
    });

    it('propagates batch recall to both unsplit and already-split units and supports cancelTransfer', async function () {
      const {
        registry,
        manufacturer,
        distributor,
        warehouse,
        batchId,
        ipfsCid,
        items,
        tree,
      } = await loadFixture(deployFixture);

      await registry.connect(manufacturer).registerBatch(batchId, tree.root, ipfsCid, 8);
      const unit = items[6];
      const proof = tree.getProof(6);

      await registry
        .connect(manufacturer)
        .materializeAndInitiateTransfer(
          batchId,
          unit.productId,
          unit.serial,
          unit.metadataHash,
          unit.claimSecretHash,
          proof,
          distributor.address,
          0,
          'SHIP-CANCEL',
        );
      await registry.connect(manufacturer).cancelTransfer(unit.productId, 1);

      // Manufacturer recalls entire batch
      await registry.connect(manufacturer).recallBatch(batchId, 'Battery defect');

      await expect(
        registry.connect(manufacturer).initiateTransfer(unit.productId, warehouse.address, 2, 'X'),
      ).to.be.revertedWithCustomError(registry, 'ProductOrBatchRecalled');

      const auth = await registry.verifyProductAuthenticity(
        batchId,
        items[7].productId,
        items[7].serial,
        items[7].metadataHash,
        items[7].claimSecretHash,
        tree.getProof(7),
      );
      expect(auth.isRecalled).to.equal(true);
      expect(auth.currentStatus).to.equal(7n); // Recalled
    });

    it('covers batch cancel, delivery status updates, executeTransferBySig, flagProduct, and negative edge guards', async function () {
      const {
        registry,
        admin,
        manufacturer,
        distributor,
        warehouse,
        retailer,
        attacker,
        batchId,
        ipfsCid,
        items,
        tree,
      } = await loadFixture(deployFixture);

      // Non-existent batch view returns isMerkleValid=false safely
      const missingAuth = await registry.verifyProductAuthenticity(
        batchId,
        items[0].productId,
        items[0].serial,
        items[0].metadataHash,
        items[0].claimSecretHash,
        tree.getProof(0),
      );
      expect(missingAuth.isMerkleValid).to.equal(false);

      // Zero batchId / merkleRoot rejected
      await expect(
        registry.connect(manufacturer).registerBatch(ethers.ZeroHash, tree.root, ipfsCid, 1),
      ).to.be.revertedWithCustomError(registry, 'InvalidZeroBytes32');

      await registry.connect(manufacturer).registerBatch(batchId, tree.root, ipfsCid, 8);

      // Whole batch transfer, cancel, and status update
      await expect(
        registry.connect(manufacturer).initiateBatchTransfer(batchId, manufacturer.address, 0, 'SELF'),
      ).to.be.revertedWithCustomError(registry, 'SelfTransferNotAllowed');

      await registry
        .connect(manufacturer)
        .initiateBatchTransfer(batchId, distributor.address, 0, 'PALLET-1');
      await expect(
        registry.connect(warehouse).acceptBatchCustody(batchId, 1),
      ).to.be.revertedWithCustomError(registry, 'InvalidPendingCustodian');

      await registry.connect(manufacturer).cancelBatchTransfer(batchId, 1);
      await expect(
        registry.connect(manufacturer).cancelBatchTransfer(batchId, 2),
      ).to.be.revertedWithCustomError(registry, 'NoPendingTransfer');

      await registry
        .connect(manufacturer)
        .updateBatchDeliveryStatus(batchId, 2, 'Staging-Bay-A');
      await registry
        .connect(manufacturer)
        .updateBatchDeliveryStatus(batchId, 1, 'Ready-For-Dispatch');

      // Materialize unit 0 and test executeTransferBySig + updateDeliveryStatus + flagProduct
      const unit0 = items[0];
      await registry
        .connect(manufacturer)
        .materializeAndInitiateTransfer(
          batchId,
          unit0.productId,
          unit0.serial,
          unit0.metadataHash,
          unit0.claimSecretHash,
          tree.getProof(0),
          distributor.address,
          0,
          'HOP-1',
        );
      await registry.connect(distributor).acceptCustody(unit0.productId, 1, 'Dist-Hub');
      await registry
        .connect(distributor)
        .updateDeliveryStatus(unit0.productId, 2, 'Customs-Cleared');
      await registry
        .connect(distributor)
        .updateDeliveryStatus(unit0.productId, 3, 'Dist-Bay-2');

      const latest = await time.latest();
      const deadline = BigInt(latest + 3600);
      const net = await ethers.provider.getNetwork();
      const domain = {
        name: 'ChainTraceRegistry',
        version: '1',
        chainId: net.chainId,
        verifyingContract: await registry.getAddress(),
      };
      const transferTypes = {
        TransferIntent: [
          { name: 'productId', type: 'bytes32' },
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'expectedNonce', type: 'uint64' },
          { name: 'deadline', type: 'uint256' },
        ],
      };
      const sig = await distributor.signTypedData(domain, transferTypes, {
        productId: unit0.productId,
        from: distributor.address,
        to: retailer.address,
        expectedNonce: 2n,
        deadline,
      });

      await registry
        .connect(admin)
        .executeTransferBySig(
          unit0.productId,
          distributor.address,
          retailer.address,
          2n,
          deadline,
          'RELAYED-HOP-2',
          sig,
        );
      await registry.connect(retailer).acceptCustody(unit0.productId, 3, 'Retail-Floor');

      const prodView = await registry.getProduct(unit0.productId);
      expect(prodView.custodian).to.equal(retailer.address);

      // BatchMismatch if claiming with wrong batchId
      const otherBatch = ethers.keccak256(ethers.toUtf8Bytes('OTHER-BATCH'));
      await registry.connect(manufacturer).registerBatch(otherBatch, tree.root, ipfsCid, 8);
      await expect(
        registry
          .connect(manufacturer)
          .claimProduct(
            otherBatch,
            unit0.productId,
            unit0.serial,
            unit0.metadataHash,
            unit0.claimSecretHash,
            tree.getProof(0),
            unit0.claimSecret,
          ),
      ).to.be.revertedWithCustomError(registry, 'BatchMismatch');

      // Unauthorized flagger rejected, auditor flags unit0 and unsplit unit1 via flagProductWithProof
      await expect(
        registry.connect(attacker).flagProduct(unit0.productId, 'Fake'),
      ).to.be.revertedWithCustomError(registry, 'UnauthorizedRecallCaller');

      await registry.connect(admin).flagProduct(unit0.productId, 'Suspected counterfeit clone');
      await registry
        .connect(admin)
        .flagProductWithProof(
          batchId,
          items[1].productId,
          items[1].serial,
          items[1].metadataHash,
          items[1].claimSecretHash,
          tree.getProof(1),
          'Unsplit unit quarantined',
        );

      const flaggedState = await registry.getProduct(items[1].productId);
      expect(flaggedState.recalled).to.equal(true);
    });
  });
});
