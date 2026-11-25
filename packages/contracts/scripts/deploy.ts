import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const [admin, manufacturer, distributor, warehouse, retailer, auditor] =
    await ethers.getSigners();

  const Registry = await ethers.getContractFactory('ChainTraceRegistry');
  const registry = await Registry.deploy(admin.address);
  await registry.waitForDeployment();
  const address = await registry.getAddress();

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  // On local dev chain (31337), pre-provision demo organization roles across distinct Hardhat accounts
  if (chainId === 31337) {
    const MANUFACTURER_ROLE = await registry.MANUFACTURER_ROLE();
    const DISTRIBUTOR_ROLE = await registry.DISTRIBUTOR_ROLE();
    const WAREHOUSE_ROLE = await registry.WAREHOUSE_ROLE();
    const RETAILER_ROLE = await registry.RETAILER_ROLE();
    const AUDITOR_ROLE = await registry.AUDITOR_ROLE();

    if (manufacturer) await (await registry.grantRole(MANUFACTURER_ROLE, manufacturer.address)).wait();
    if (distributor) await (await registry.grantRole(DISTRIBUTOR_ROLE, distributor.address)).wait();
    if (warehouse) await (await registry.grantRole(WAREHOUSE_ROLE, warehouse.address)).wait();
    if (retailer) await (await registry.grantRole(RETAILER_ROLE, retailer.address)).wait();
    if (auditor) await (await registry.grantRole(AUDITOR_ROLE, auditor.address)).wait();
  }

  const deploymentInfo = {
    chainId,
    contractAddress: address,
    deployedAt: new Date().toISOString(),
    roles:
      chainId === 31337
        ? {
            admin: admin.address,
            manufacturer: manufacturer?.address,
            distributor: distributor?.address,
            warehouse: warehouse?.address,
            retailer: retailer?.address,
            auditor: auditor?.address,
          }
        : { admin: admin.address },
  };

  const outPath = path.resolve(__dirname, '../deployments.json');
  fs.writeFileSync(outPath, JSON.stringify(deploymentInfo, null, 2));

  console.log('ChainTraceRegistry deployed:', JSON.stringify(deploymentInfo, null, 2));
}

main()
  .then(async () => {
    await ethers.provider.destroy?.();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await ethers.provider.destroy?.();
    process.exit(1);
  });
