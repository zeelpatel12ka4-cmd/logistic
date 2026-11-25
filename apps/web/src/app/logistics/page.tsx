'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Truck, CheckCircle2, ShieldAlert, PackageCheck, Send } from 'lucide-react';
import { CUSTODY_STATUS_LABELS, CustodyStatus } from '@chaintrace/shared';
import { useWeb3 } from '../../lib/web3';

interface ProductItem {
  product_id: string;
  batch_id: string;
  serial_number: string;
  metadata_hash: string;
  claim_secret_hash: string;
  is_materialized: boolean;
  current_custodian: string;
  pending_custodian: string | null;
  custody_status: number;
  nonce: string;
  claimed: boolean;
  recalled: boolean;
  product_name: string;
  batch_code: string;
}

interface BatchItem {
  batch_id: string;
  batch_code: string | null;
  product_name: string | null;
  unit_count: string;
  batch_custodian: string;
  pending_batch_custodian: string | null;
  batch_status: number;
  batch_nonce: string;
  recalled: boolean;
}

export default function LogisticsPage() {
  const {
    walletAddress,
    isAuthenticated,
    roles,
    connectWallet,
    signInWithEthereum,
    getWriteContract,
    apiFetch,
  } = useWeb3();

  const [incomingProducts, setIncomingProducts] = useState<ProductItem[]>([]);
  const [heldProducts, setHeldProducts] = useState<ProductItem[]>([]);
  const [incomingBatches, setIncomingBatches] = useState<BatchItem[]>([]);
  const [heldBatches, setHeldBatches] = useState<BatchItem[]>([]);
  const [search, setSearch] = useState('');

  // Transfer form state
  const [recipientAddr, setRecipientAddr] = useState('');
  const [shipmentRef, setShipmentRef] = useState('BOL-2026-881');
  const [carrierName, setCarrierName] = useState('DHL Global Forwarding');
  const [trackingNumber, setTrackingNumber] = useState('AWB-9940213');
  const [originLocation, setOriginLocation] = useState('Shenzhen Hub');
  const [destinationLocation, setDestinationLocation] = useState('Mumbai Port Warehouse');

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadWorkspace = useCallback(async () => {
    try {
      const qParam = search ? `&q=${encodeURIComponent(search)}` : '';
      const custodianParam = walletAddress ? `&custodian=${walletAddress}` : '';
      const pendingParam = walletAddress ? `?pendingFor=${walletAddress}` : '?limit=20';

      const [heldProdRes, pendingProdRes, heldBatchRes, pendingBatchRes] = await Promise.all([
        apiFetch<{ items: ProductItem[] }>(`/api/products?limit=25${custodianParam}${qParam}`),
        walletAddress
          ? apiFetch<{ items: ProductItem[] }>(`/api/products?pendingFor=${walletAddress}&limit=25`)
          : Promise.resolve({ items: [] }),
        walletAddress
          ? apiFetch<{ items: BatchItem[] }>(`/api/batches?custodian=${walletAddress}&limit=20`)
          : apiFetch<{ items: BatchItem[] }>(`/api/batches?limit=20`),
        walletAddress
          ? apiFetch<{ items: BatchItem[] }>(`/api/batches${pendingParam}&limit=20`)
          : Promise.resolve({ items: [] }),
      ]);

      setHeldProducts(heldProdRes.items);
      setIncomingProducts(pendingProdRes.items);
      setHeldBatches(heldBatchRes.items);
      setIncomingBatches(pendingBatchRes.items);
    } catch {
      // ignore if API down
    }
  }, [apiFetch, search, walletAddress]);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  const ensureAuth = async () => {
    if (!walletAddress) await connectWallet();
    if (!isAuthenticated) await signInWithEthereum();
  };

  const handleAcceptProduct = async (item: ProductItem) => {
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const locationNote =
        window.prompt('Checkpoint / Facility Location Note:', destinationLocation) ||
        destinationLocation;
      const contract = await getWriteContract();
      const tx = await contract.acceptCustody(item.product_id, Number(item.nonce), locationNote);
      setStatusMessage(`Accepting custody (${tx.hash.slice(0, 12)}…)…`);
      await tx.wait();
      setStatusMessage(`Custody accepted for ${item.serial_number} (${tx.hash})`);
      await loadWorkspace();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to accept custody');
    }
  };

  const handleTransferProduct = async (item: ProductItem) => {
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      if (!recipientAddr) throw new Error('Enter recipient partner wallet address first');
      await ensureAuth();
      const contract = await getWriteContract();

      let tx;
      if (!item.is_materialized) {
        const detail = await apiFetch<{ product: { merkle_proof: string[] } }>(
          `/api/products/${item.product_id}`,
        );
        tx = await contract.materializeAndInitiateTransfer(
          item.batch_id,
          item.product_id,
          item.serial_number,
          item.metadata_hash,
          item.claim_secret_hash,
          detail.product.merkle_proof,
          recipientAddr,
          0,
          shipmentRef,
        );
      } else {
        tx = await contract.initiateTransfer(
          item.product_id,
          recipientAddr,
          Number(item.nonce),
          shipmentRef,
        );
      }

      setStatusMessage(`Transfer initiated (${tx.hash.slice(0, 12)}…). Waiting for block…`);
      await tx.wait();

      // Attach off-chain shipment manifest keyed by txHash
      await apiFetch('/api/products/shipments', {
        method: 'POST',
        body: JSON.stringify({
          txHash: tx.hash,
          productId: item.product_id,
          batchId: item.batch_id,
          carrierName,
          trackingNumber,
          originLocation,
          destinationLocation,
        }),
      });

      setStatusMessage(`Transfer + shipment metadata recorded (${tx.hash})`);
      await loadWorkspace();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Transfer failed');
    }
  };

  const handleUpdateDeliveryStatus = async (item: ProductItem, nextStatus: CustodyStatus) => {
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const note = window.prompt('Delivery milestone note:', 'Cleared customs inspection') || 'Updated';
      const contract = await getWriteContract();
      const tx = await contract.updateDeliveryStatus(item.product_id, nextStatus, note);
      await tx.wait();
      setStatusMessage(`Delivery status updated for ${item.serial_number} (${tx.hash})`);
      await loadWorkspace();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Status update failed');
    }
  };

  const handleAcceptBatch = async (batch: BatchItem) => {
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const contract = await getWriteContract();
      const tx = await contract.acceptBatchCustody(batch.batch_id, Number(batch.batch_nonce));
      await tx.wait();
      setStatusMessage(`Whole batch custody accepted (${tx.hash})`);
      await loadWorkspace();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Batch accept failed');
    }
  };

  const handleTransferBatch = async (batch: BatchItem) => {
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      if (!recipientAddr) throw new Error('Enter recipient partner wallet address first');
      await ensureAuth();
      const contract = await getWriteContract();
      const tx = await contract.initiateBatchTransfer(
        batch.batch_id,
        recipientAddr,
        Number(batch.batch_nonce),
        shipmentRef,
      );
      await tx.wait();

      await apiFetch('/api/products/shipments', {
        method: 'POST',
        body: JSON.stringify({
          txHash: tx.hash,
          batchId: batch.batch_id,
          carrierName,
          trackingNumber,
          originLocation,
          destinationLocation,
        }),
      });

      setStatusMessage(`Whole batch transfer initiated (${tx.hash})`);
      await loadWorkspace();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Batch transfer failed');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
          <Truck className="h-6 w-6 text-emerald-600" aria-hidden="true" />
          Distributor, Warehouse & Retailer Logistics
        </h1>
        <p className="text-sm text-slate-600">
          Accept pending custody handoffs, split individual units or move entire pallets, update
          delivery status, and record carrier shipment details. Active role:{' '}
          <span className="font-semibold text-emerald-700">
            {roles.length > 0 ? roles.join(', ') : 'Connect partner wallet'}
          </span>
        </p>
      </div>

      {statusMessage && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="break-all">{statusMessage}</span>
        </div>
      )}

      {errorMessage && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900"
        >
          <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="break-all">{errorMessage}</span>
        </div>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">
          Outbound Transfer & Carrier Shipment Parameters
        </h2>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label htmlFor="recipientAddr" className="block text-xs font-medium text-slate-700">
              Recipient Partner Wallet (0x…)
            </label>
            <input
              id="recipientAddr"
              placeholder="0x…"
              value={recipientAddr}
              onChange={(e) => setRecipientAddr(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 font-mono text-xs"
            />
          </div>
          <div>
            <label htmlFor="shipmentRef" className="block text-xs font-medium text-slate-700">
              On-Chain Shipment Ref
            </label>
            <input
              id="shipmentRef"
              value={shipmentRef}
              onChange={(e) => setShipmentRef(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-xs"
            />
          </div>
          <div>
            <label htmlFor="carrierName" className="block text-xs font-medium text-slate-700">
              Carrier / Logistics Provider
            </label>
            <input
              id="carrierName"
              value={carrierName}
              onChange={(e) => setCarrierName(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-xs"
            />
          </div>
          <div>
            <label htmlFor="trackingNumber" className="block text-xs font-medium text-slate-700">
              Tracking / Waybill #
            </label>
            <input
              id="trackingNumber"
              value={trackingNumber}
              onChange={(e) => setTrackingNumber(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-xs"
            />
          </div>
          <div>
            <label htmlFor="originLocation" className="block text-xs font-medium text-slate-700">
              Origin Hub
            </label>
            <input
              id="originLocation"
              value={originLocation}
              onChange={(e) => setOriginLocation(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-xs"
            />
          </div>
          <div>
            <label htmlFor="destinationLocation" className="block text-xs font-medium text-slate-700">
              Destination Facility
            </label>
            <input
              id="destinationLocation"
              value={destinationLocation}
              onChange={(e) => setDestinationLocation(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-xs"
            />
          </div>
        </div>
      </section>

      {(incomingBatches.length > 0 || incomingProducts.length > 0) && (
        <section className="rounded-xl border border-amber-300 bg-amber-50/50 p-5 space-y-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-amber-950">
            <PackageCheck className="h-5 w-5 text-amber-700" aria-hidden="true" />
            Pending Incoming Custody Approvals
          </h2>
          {incomingBatches.map((b) => (
            <div
              key={b.batch_id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white p-3 border border-amber-200"
            >
              <div className="text-xs">
                <span className="font-semibold">WHOLE BATCH: {b.batch_code}</span> ·{' '}
                {Number(b.unit_count).toLocaleString()} units
              </div>
              <button
                type="button"
                onClick={() => handleAcceptBatch(b)}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                Accept Batch Custody
              </button>
            </div>
          ))}
          {incomingProducts.map((p) => (
            <div
              key={p.product_id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white p-3 border border-amber-200"
            >
              <div className="text-xs">
                <span className="font-mono font-semibold">{p.serial_number}</span> ·{' '}
                {p.product_name} (from {p.current_custodian.slice(0, 8)}…)
              </div>
              <button
                type="button"
                onClick={() => handleAcceptProduct(p)}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                Accept Product Custody
              </button>
            </div>
          ))}
        </section>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-900">Active Batches in Custody</h2>
          <button
            type="button"
            onClick={() => loadWorkspace()}
            className="text-xs font-medium text-emerald-700 hover:underline"
          >
            Refresh
          </button>
        </div>

        <div className="space-y-2">
          {heldBatches.map((b) => (
            <div
              key={b.batch_id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-xs"
            >
              <div>
                <div className="font-semibold text-slate-900">
                  {b.product_name || b.batch_code} ({Number(b.unit_count).toLocaleString()} units)
                </div>
                <div className="font-mono text-slate-500">
                  Status: {CUSTODY_STATUS_LABELS[b.batch_status]} · Nonce: {b.batch_nonce} ·
                  Custodian: {b.batch_custodian.slice(0, 10)}…
                </div>
              </div>
              <button
                type="button"
                disabled={Boolean(b.pending_batch_custodian) || b.recalled}
                onClick={() => handleTransferBatch(b)}
                className="flex items-center gap-1 rounded-md bg-slate-900 px-3 py-1.5 font-medium text-white hover:bg-slate-700 disabled:opacity-40"
              >
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
                {b.pending_batch_custodian ? 'Pending Recipient Accept' : 'Transfer Whole Batch'}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-900">Individual Products Inventory</h2>
          <input
            aria-label="Search products by serial or ID"
            placeholder="Filter by serial or 0x ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
        </div>

        {heldProducts.length === 0 ? (
          <p className="text-sm text-slate-500">No products held by current wallet filter.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {heldProducts.map((p) => (
              <div
                key={p.product_id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 text-xs"
              >
                <div>
                  <div className="font-mono font-semibold text-slate-900">
                    {p.serial_number}{' '}
                    <span className="font-sans font-normal text-slate-600">
                      — {p.product_name}
                    </span>
                  </div>
                  <div className="mt-0.5 text-slate-500">
                    Status:{' '}
                    <span className="font-semibold text-slate-800">
                      {CUSTODY_STATUS_LABELS[p.custody_status]}
                    </span>{' '}
                    · Materialized: {p.is_materialized ? 'Yes' : 'Lazy'} · Nonce: {p.nonce}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {p.is_materialized && !p.pending_custodian && !p.claimed && !p.recalled && (
                    <button
                      type="button"
                      onClick={() => handleUpdateDeliveryStatus(p, CustodyStatus.InTransit)}
                      className="rounded border border-slate-300 px-2.5 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Mark In Transit
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={Boolean(p.pending_custodian) || p.claimed || p.recalled}
                    onClick={() => handleTransferProduct(p)}
                    className="flex items-center gap-1 rounded bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
                  >
                    <Send className="h-3.5 w-3.5" aria-hidden="true" />
                    {p.pending_custodian
                      ? 'Awaiting Accept'
                      : p.is_materialized
                        ? 'Initiate Transfer'
                        : 'Split & Transfer'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
