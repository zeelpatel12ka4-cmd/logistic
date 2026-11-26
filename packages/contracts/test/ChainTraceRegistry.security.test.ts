import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { ChainTraceRegistry } from '../typechain-types';

function hashPair(a: string, b: string): string {
  const [first, second] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
  return ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32'], [first, second]));
}

function buildMerkleTree(leaves: string[]) {
  const layers: string[][] = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next: string[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
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
      if (pairIdx < layer.length) proof.push(layer[pairIdx]);
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
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'string', 'bytes32', 'bytes32'],
      [batchId, productId, serialNumber, metadataHash, claimSecretHash],
    ),
  );
  return ethers.keccak256(inner);
}

describe('ChainTraceRegistry — Security, Edge Branches & Fuzz Invariants', function () {
  async function deployFixture() {
    const [admin, manufacturer, distributor, warehouse, retailer, customer, attacker] =
      await ethers.getSigners();
    const Factory = await ethers.getContractFactory('ChainTraceRegistry');
    const registry = (await Factory.deploy(admin.address)) as ChainTraceRegistry;

    await registry.grantRole(await registry.MANUFACTURER_ROLE(), manufacturer.address);
    await registry.grantRole(await registry.DISTRIBUTOR_ROLE(), distributor.address);
    await registry.grantRole(await registry.WAREHOUSE_ROLE(), warehouse.address);
    await registry.grantRole(await registry.RETAILER_ROLE(), retailer.address);

    const batchId = ethers.keccak256(ethers.toUtf8Bytes('SEC-BATCH-1'));
    const ipfsCid = 'bafybeisecuritytestcid0000000000000000000000000000000000001';

    const items = Array.from({ length: 5 }, (_, idx) => {
      const serial = `SEC-SN-${idx}`;
      const productId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['address', 'bytes32', 'string'],
          [manufacturer.address, batchId, serial],
        ),
      );
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(`{"serial":"${serial}"}`));
      const claimSecret = idx === 4 ? '' : `SEC-KEY-${idx}`;
      const claimSecretHash =
        claimSecret === '' ? ethers.ZeroHash : ethers.keccak256(ethers.toUtf8Bytes(claimSecret));
      const leaf = computeLeaf(batchId, productId, serial, metadataHash, claimSecretHash);
      return { serial, productId, metadataHash, claimSecret, claimSecretHash, leaf };
    });

    const tree = buildMerkleTree(items.map((i) => i.leaf));
    return {
      registry,
      admin,
      manufacturer,
      distributor,
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

  it('rejects zero-address constructor, non-existent batch getBatch, and batch negative guards', async function () {
    const { registry, manufacturer, distributor, attacker, batchId, ipfsCid, tree } =
      await loadFixture(deployFixture);

    const Factory = await ethers.getContractFactory('ChainTraceRegistry');
    await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      registry,
      'InvalidZeroAddress',
    );

    await expect(registry.getBatch(batchId)).to.be.revertedWithCustomError(
      registry,
      'BatchNotFound',
    );
    await expect(
      registry.connect(manufacturer).initiateBatchTransfer(batchId, distributor.address, 0, 'X'),
    ).to.be.revertedWithCustomError(registry, 'BatchNotFound');
    await expect(
      registry.connect(distributor).acceptBatchCustody(batchId, 0),
    ).to.be.revertedWithCustomError(registry, 'BatchNotFound');
    await expect(
      registry.connect(manufacturer).cancelBatchTransfer(batchId, 0),
    ).to.be.revertedWithCustomError(registry, 'BatchNotFound');
    await expect(
      registry.connect(manufacturer).updateBatchDeliveryStatus(batchId, 1, 'X'),
    ).to.be.revertedWithCustomError(registry, 'BatchNotFound');
    await expect(
      registry.connect(manufacturer).recallBatch(batchId, 'Defect'),
    ).to.be.revertedWithCustomError(registry, 'BatchNotFound');

    await registry.connect(manufacturer).registerBatch(batchId, tree.root, ipfsCid, 5);

    // initiateBatchTransfer negative paths
    await expect(
      registry.connect(attacker).initiateBatchTransfer(batchId, distributor.address, 0, 'X'),
    ).to.be.revertedWithCustomError(registry, 'UnauthorizedCustodian');
    await expect(
      registry.connect(manufacturer).initiateBatchTransfer(batchId, ethers.ZeroAddress, 0, 'X'),
    ).to.be.revertedWithCustomError(registry, 'InvalidZeroAddress');
    await expect(
      registry.connect(manufacturer).initiateBatchTransfer(batchId, distributor.address, 99, 'X'),
    ).to.be.revertedWithCustomError(registry, 'StaleNonce');

    // acceptBatchCustody when no pending transfer
    await expect(
      registry.connect(distributor).acceptBatchCustody(batchId, 0),
    ).to.be.revertedWithCustomError(registry, 'NoPendingTransfer');

    // updateBatchDeliveryStatus invalid status
    await expect(
      registry.connect(manufacturer).updateBatchDeliveryStatus(batchId, 6, 'Invalid'),
    ).to.be.revertedWithCustomError(registry, 'InvalidStatusTransition');
    await expect(
      registry.connect(attacker).updateBatchDeliveryStatus(batchId, 1, 'No'),
    ).to.be.revertedWithCustomError(registry, 'UnauthorizedCustodian');

    // Start batch transfer -> block concurrent batch transfer, block status update, block cancel by wrong caller/nonce
    await registry
      .connect(manufacturer)
      .initiateBatchTransfer(batchId, distributor.address, 0, 'PALLET-A');
    await expect(
      registry.connect(manufacturer).initiateBatchTransfer(batchId, distributor.address, 1, 'B'),
    ).to.be.revertedWithCustomError(registry, 'TransferAlreadyPending');
    await expect(
      registry.connect(manufacturer).updateBatchDeliveryStatus(batchId, 1, 'Locked'),
    ).to.be.revertedWithCustomError(registry, 'TransferAlreadyPending');
    await expect(
      registry.connect(attacker).cancelBatchTransfer(batchId, 1),
    ).to.be.revertedWithCustomError(registry, 'UnauthorizedCustodian');
    await expect(
      registry.connect(manufacturer).cancelBatchTransfer(batchId, 99),
    ).to.be.revertedWithCustomError(registry, 'StaleNonce');
    await expect(
      registry.connect(distributor).acceptBatchCustody(batchId, 99),
    ).to.be.revertedWithCustomError(registry, 'StaleNonce');

    // Role revocation mid-transfer blocks acceptBatchCustody
    await registry.revokeRole(await registry.DISTRIBUTOR_ROLE(), distributor.address);
    await expect(
      registry.connect(distributor).acceptBatchCustody(batchId, 1),
    ).to.be.revertedWithCustomError(registry, 'UnauthorizedRecipientRole');

    // Recall clears pendingBatchCustodian and blocks further batch ops
    await expect(
      registry.connect(attacker).recallBatch(batchId, 'Rogue'),
    ).to.be.revertedWithCustomError(registry, 'UnauthorizedRecallCaller');
    await expect(
      registry.connect(manufacturer).recallBatch(batchId, ''),
    ).to.be.revertedWithCustomError(registry, 'EmptyString');

    await registry.connect(manufacturer).recallBatch(batchId, 'Safety recall');
    const recalledBatch = await registry.getBatch(batchId);
    expect(recalledBatch.pendingBatchCustodian).to.equal(ethers.ZeroAddress);

    await expect(
      registry.connect(manufacturer).initiateBatchTransfer(batchId, distributor.address, 1, 'X'),
    ).to.be.revertedWithCustomError(registry, 'ProductOrBatchRecalled');
    await expect(
      registry.connect(distributor).acceptBatchCustody(batchId, 1),
    ).to.be.revertedWithCustomError(registry, 'ProductOrBatchRecalled');
    await expect(
      registry.connect(manufacturer).updateBatchDeliveryStatus(batchId, 1, 'X'),
    ).to.be.revertedWithCustomError(registry, 'ProductOrBatchRecalled');
  });

  it('covers individual product negative branches, role revocation mid-transfer, and zero-secret claims', async function () {
    const {
      registry,
      admin,
      manufacturer,
      distributor,
      retailer,
      customer,
      attacker,
      batchId,
      ipfsCid,
      items,
      tree,
    } = await loadFixture(deployFixture);

    // Uninitialized product guards
    await expect(
      registry.connect(manufacturer).initiateTransfer(items[0].productId, distributor.address, 0, 'X'),
    ).to.be.revertedWithCustomError(registry, 'ProductNotInitialized');
    await expect(
      registry.connect(distributor).acceptCustody(items[0].productId, 0, 'X'),
    ).to.be.revertedWithCustomError(registry, 'ProductNotInitialized');
    await expect(
      registry.connect(manufacturer).cancelTransfer(items[0].productId, 0),
    ).to.be.revertedWithCustomError(registry, 'ProductNotInitialized');
    await expect(
      registry.connect(manufacturer).updateDeliveryStatus(items[0].productId, 1, 'X'),
    ).to.be.revertedWithCustomError(registry, 'ProductNotInitialized');
    await expect(
      registry.connect(admin).flagProduct(items[0].productId, 'X'),
    ).to.be.revertedWithCustomError(registry, 'ProductNotInitialized');

    await registry.connect(manufacturer).registerBatch(batchId, tree.root, ipfsCid, 5);

    // Zero productId rejected
    await expect(
      registry
        .connect(manufacturer)
        .materializeAndInitiateTransfer(
          batchId,
          ethers.ZeroHash,
          items[0].serial,
          items[0].metadataHash,
          items[0].claimSecretHash,
          tree.getProof(0),
          distributor.address,
          0,
          'X',
        ),
    ).to.be.revertedWithCustomError(registry, 'InvalidZeroBytes32');

    // Item 4 has claimSecretHash == ZeroHash: non-custodian cannot claim it!
    await expect(
      registry
        .connect(customer)
        .claimProduct(
          batchId,
          items[4].productId,
          items[4].serial,
          items[4].metadataHash,
          items[4].claimSecretHash,
          tree.getProof(4),
          '',
        ),
    ).to.be.revertedWithCustomError(registry, 'UnauthorizedClaimWithoutSecret');

    // Custodian (manufacturer) CAN claim zero-secret direct item
    await registry
      .connect(manufacturer)
      .claimProduct(
        batchId,
        items[4].productId,
        items[4].serial,
        items[4].metadataHash,
        items[4].claimSecretHash,
        tree.getProof(4),
        '',
      );

    // AlreadyClaimed blocks transfer and status update
    await expect(
      registry.connect(manufacturer).initiateTransfer(items[4].productId, distributor.address, 1, 'X'),
    ).to.be.revertedWithCustomError(registry, 'AlreadyClaimed');
    await expect(
      registry.connect(manufacturer).updateDeliveryStatus(items[4].productId, 1, 'X'),
    ).to.be.revertedWithCustomError(registry, 'AlreadyClaimed');

    // Materialize item 0 -> test self-transfer, empty secret, mid-hop wrong status claim, role revocation, EIP-712 errors
    const u0 = items[0];
    await expect(
      registry
        .connect(manufacturer)
        .materializeAndInitiateTransfer(
          batchId,
          u0.productId,
          u0.serial,
          u0.metadataHash,
          u0.claimSecretHash,
          tree.getProof(0),
          manufacturer.address,
          0,
          'SELF',
        ),
    ).to.be.revertedWithCustomError(registry, 'SelfTransferNotAllowed');

    await registry
      .connect(manufacturer)
      .materializeAndInitiateTransfer(
        batchId,
        u0.productId,
        u0.serial,
        u0.metadataHash,
        u0.claimSecretHash,
        tree.getProof(0),
        distributor.address,
        0,
        'HOP1',
      );

    // Claim blocked while TransferAlreadyPending
    await expect(
      registry
        .connect(customer)
        .claimProduct(
          batchId,
          u0.productId,
          u0.serial,
          u0.metadataHash,
          u0.claimSecretHash,
          tree.getProof(0),
          u0.claimSecret,
        ),
    ).to.be.revertedWithCustomError(registry, 'TransferAlreadyPending');

    // Wrong acceptor, wrong nonce
    await expect(
      registry.connect(retailer).acceptCustody(u0.productId, 1, 'Wrong'),
    ).to.be.revertedWithCustomError(registry, 'InvalidPendingCustodian');
    await expect(
      registry.connect(distributor).acceptCustody(u0.productId, 99, 'Wrong'),
    ).to.be.revertedWithCustomError(registry, 'StaleNonce');

    await registry.connect(distributor).acceptCustody(u0.productId, 1, 'Dist');

    // Claim blocked when status == AtDistributor
    await expect(
      registry
        .connect(customer)
        .claimProduct(
          batchId,
          u0.productId,
          u0.serial,
          u0.metadataHash,
          u0.claimSecretHash,
          tree.getProof(0),
          u0.claimSecret,
        ),
    ).to.be.revertedWithCustomError(registry, 'InvalidStatusTransition');

    // updateDeliveryStatus invalid transitions & unauthorized
    await expect(
      registry.connect(attacker).updateDeliveryStatus(u0.productId, 2, 'No'),
    ).to.be.revertedWithCustomError(registry, 'UnauthorizedCustodian');
    await expect(
      registry.connect(distributor).updateDeliveryStatus(u0.productId, 5, 'CannotJumpToRetailer'),
    ).to.be.revertedWithCustomError(registry, 'InvalidStatusTransition');

    // Empty secret rejected
    await registry
      .connect(distributor)
      .initiateTransfer(u0.productId, retailer.address, 2, 'HOP2');
    await registry.connect(retailer).acceptCustody(u0.productId, 3, 'Ret');
    await expect(
      registry
        .connect(customer)
        .claimProduct(
          batchId,
          u0.productId,
          u0.serial,
          u0.metadataHash,
          u0.claimSecretHash,
          tree.getProof(0),
          '',
        ),
    ).to.be.revertedWithCustomError(registry, 'InvalidClaimSecret');

    // EIP-712 invalid signer & expired deadline
    const nowTs = await time.latest();
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
    const badSig = await attacker.signTypedData(domain, transferTypes, {
      productId: u0.productId,
      from: retailer.address,
      to: distributor.address,
      expectedNonce: 4n,
      deadline: BigInt(nowTs + 600),
    });
    await expect(
      registry
        .connect(admin)
        .executeTransferBySig(
          u0.productId,
          retailer.address,
          distributor.address,
          4n,
          BigInt(nowTs + 600),
          'BAD',
          badSig,
        ),
    ).to.be.revertedWithCustomError(registry, 'InvalidSignature');
    await expect(
      registry
        .connect(admin)
        .executeTransferBySig(
          u0.productId,
          retailer.address,
          distributor.address,
          4n,
          BigInt(nowTs - 1),
          'EXP',
          badSig,
        ),
    ).to.be.revertedWithCustomError(registry, 'SignatureExpired');

    // flagProduct clears pendingCustodian and blocks acceptCustody
    await registry.connect(retailer).initiateTransfer(u0.productId, distributor.address, 4, 'RET');
    await expect(registry.connect(admin).flagProduct(u0.productId, '')).to.be.revertedWithCustomError(
      registry,
      'EmptyString',
    );
    await registry.connect(admin).flagProduct(u0.productId, 'Quarantined');
    const flagged = await registry.getProduct(u0.productId);
    expect(flagged.pendingCustodian).to.equal(ethers.ZeroAddress);
    await expect(
      registry.connect(distributor).acceptCustody(u0.productId, 5, 'Late'),
    ).to.be.revertedWithCustomError(registry, 'ProductOrBatchRecalled');
  });

  it('fuzzes odd/even batch sizes (1, 3, 7, 13) and enforces splitCount <= unitCount invariant', async function () {
    const { registry, manufacturer, distributor, ipfsCid } = await loadFixture(deployFixture);

    for (const size of [1, 3, 7, 13]) {
      const bId = ethers.keccak256(ethers.toUtf8Bytes(`FUZZ-BATCH-${size}`));
      const units = Array.from({ length: size }, (_, i) => {
        const serial = `FZ-${size}-${i}`;
        const productId = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'bytes32', 'string'],
            [manufacturer.address, bId, serial],
          ),
        );
        const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(`meta-${serial}`));
        const claimSecretHash = ethers.keccak256(ethers.toUtf8Bytes(`sec-${serial}`));
        return { serial, productId, metadataHash, claimSecretHash };
      });
      const leaves = units.map((u) =>
        computeLeaf(bId, u.productId, u.serial, u.metadataHash, u.claimSecretHash),
      );
      const tree = buildMerkleTree(leaves);

      await registry.connect(manufacturer).registerBatch(bId, tree.root, ipfsCid, size);

      // Verify Solidity computeLeaf matches TypeScript leaf byte-for-byte
      const onChainLeaf = await registry.computeLeaf(
        bId,
        units[0].productId,
        units[0].serial,
        units[0].metadataHash,
        units[0].claimSecretHash,
      );
      expect(onChainLeaf).to.equal(leaves[0]);

      const splitIdx = size - 1;
      await registry
        .connect(manufacturer)
        .materializeAndInitiateTransfer(
          bId,
          units[splitIdx].productId,
          units[splitIdx].serial,
          units[splitIdx].metadataHash,
          units[splitIdx].claimSecretHash,
          tree.getProof(splitIdx),
          distributor.address,
          0,
          `FZ-SHIP-${size}`,
        );

      const batch = await registry.getBatch(bId);
      expect(batch.splitCount).to.equal(1n);
      expect(batch.splitCount).to.be.lte(batch.unitCount);
    }
  });
});
