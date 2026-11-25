'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Factory, QrCode, ShieldAlert, CheckCircle2, Loader2, Download } from 'lucide-react';
import { CUSTODY_STATUS_LABELS, QrPayload } from '@chaintrace/shared';
import { useWeb3 } from '../../lib/web3';

interface BatchRow {
  batch_id: string;
  batch_code: string | null;
  product_name: string | null;
  sku: string | null;
  unit_count: string;
  split_count: string;
  merkle_root: string;
  ipfs_cid: string;
  batch_status: number;
  recalled: boolean;
  onchain_confirmed: boolean;
  tx_hash: string | null;
}

interface ProductRow {
  product_id: string;
  serial_number: string;
  leaf_index: number;
  is_materialized: boolean;
  current_custodian: string;
  custody_status: number;
  claimed: boolean;
}

interface PreparedBatchResponse {
  batchId: string;
  batchCode: string;
  merkleRoot: string;
  ipfsCid: string;
  metadataHash: string;
  unitCount: number;
  contractCall: {
    method: string;
    args: [string, string, string, number];
  };
}

export default function ManufacturerPage() {
  const {
    walletAddress,
    isAuthenticated,
    roles,
    connectWallet,
    signInWithEthereum,
    getWriteContract,
    apiFetch,
  } = useWeb3();

  const [batchCode, setBatchCode] = useState(`BATCH-${new Date().getFullYear()}-001`);
  const [productName, setProductName] = useState('ChainTrace Smart Sensor Pro X1');
  const [sku, setSku] = useState('CT-SNS-X1');
  const [category, setCategory] = useState('Consumer Electronics');
  const [manufacturerName, setManufacturerName] = useState('Helios Precision Mfg');
  const [description, setDescription] = useState(
    'Industrial IoT telemetry module with tamper-evident hardware secure enclave.',
  );
  const [serialPrefix, setSerialPrefix] = useState('SN-X1');
  const [unitCount, setUnitCount] = useState(10);
  const [includeClaimSecrets, setIncludeClaimSecrets] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<BatchRow | null>(null);
  const [batchProducts, setBatchProducts] = useState<ProductRow[]>([]);
  const [qrBundle, setQrBundle] = useState<{ payload: QrPayload; qrDataUrl: string } | null>(null);

  const loadBatches = useCallback(async () => {
    try {
      const qs = walletAddress ? `?manufacturer=${walletAddress}` : '';
      const data = await apiFetch<{ items: BatchRow[] }>(`/api/batches${qs}`);
      setBatches(data.items);
    } catch {
      // ignore initial error when API offline
    }
  }, [apiFetch, walletAddress]);

  useEffect(() => {
    loadBatches();
  }, [loadBatches]);

  const handleCreateAndRegisterBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);
    setSubmitting(true);

    try {
      if (!walletAddress) await connectWallet();
      if (!isAuthenticated) await signInWithEthereum();

      setStatusMessage('Step 1/2: Generating Merkle tree, sealed secrets & pinning metadata to IPFS…');
      const prepared = await apiFetch<PreparedBatchResponse>('/api/batches/prepare', {
        method: 'POST',
        body: JSON.stringify({
          batchCode,
          productName,
          sku,
          category,
          manufacturerName,
          description,
          serialPrefix,
          unitCount: Number(unitCount),
          specifications: { voltage: '5V DC', warrantyYears: 2, compliance: 'CE/FCC' },
          includeClaimSecrets,
        }),
      });

      setStatusMessage(
        `IPFS CID pinned (${prepared.ipfsCid.slice(0, 14)}…). Step 2/2: Confirm registerBatch in MetaMask…`,
      );
      const contract = await getWriteContract();
      const tx = await contract.registerBatch(...prepared.contractCall.args);
      setStatusMessage(`Transaction broadcast (${tx.hash.slice(0, 12)}…). Waiting for confirmation…`);
      await tx.wait();

      setStatusMessage(
        `Batch ${prepared.batchCode} (${prepared.unitCount} units) anchored on-chain in tx ${tx.hash}`,
      );
      await loadBatches();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Batch registration failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleInspectBatch = async (batch: BatchRow) => {
    setSelectedBatch(batch);
    setQrBundle(null);
    try {
      const res = await apiFetch<{ batch: BatchRow; products: ProductRow[] }>(
        `/api/batches/${batch.batch_id}?limit=50`,
      );
      setBatchProducts(res.products);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load batch products');
    }
  };

  const handleGenerateQr = async (batchId: string, productId: string) => {
    setErrorMessage(null);
    try {
      const bundle = await apiFetch<{ payload: QrPayload; qrDataUrl: string }>(
        `/api/batches/${batchId}/products/${productId}/qr`,
      );
      setQrBundle(bundle);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'SIWE Manufacturer auth required to export sealed QR',
      );
    }
  };

  const handleRecallBatch = async (batchId: string) => {
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const reason = window.prompt('Enter recall reason (recorded permanently on-chain):');
      if (!reason) return;
      const contract = await getWriteContract();
      const tx = await contract.recallBatch(batchId, reason);
      await tx.wait();
      setStatusMessage(`Batch ${batchId.slice(0, 12)}… recalled on-chain (${tx.hash})`);
      await loadBatches();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Recall transaction failed');
    }
  };

  const isManufacturer = roles.includes('MANUFACTURER') || roles.includes('ADMIN');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
            <Factory className="h-6 w-6 text-emerald-600" aria-hidden="true" />
            Manufacturer Dashboard
          </h1>
          <p className="text-sm text-slate-600">
            Register product batches via IPFS + Merkle Root (O(1) gas up to 100k+ units) and issue
            tamper-evident QR labels.
          </p>
        </div>
        {!isManufacturer && walletAddress && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Connected wallet lacks <code className="font-mono">MANUFACTURER_ROLE</code> on-chain.
          </div>
        )}
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <form
          onSubmit={handleCreateAndRegisterBatch}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 lg:col-span-5"
        >
          <h2 className="text-lg font-semibold text-slate-900">Create & Anchor Product Batch</h2>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="batchCode" className="block text-xs font-medium text-slate-700">
                Batch Code
              </label>
              <input
                id="batchCode"
                required
                value={batchCode}
                onChange={(e) => setBatchCode(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="sku" className="block text-xs font-medium text-slate-700">
                Product SKU
              </label>
              <input
                id="sku"
                required
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label htmlFor="productName" className="block text-xs font-medium text-slate-700">
              Product Name
            </label>
            <input
              id="productName"
              required
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="category" className="block text-xs font-medium text-slate-700">
                Category
              </label>
              <input
                id="category"
                required
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="manufacturerName" className="block text-xs font-medium text-slate-700">
                Manufacturer Name
              </label>
              <input
                id="manufacturerName"
                required
                value={manufacturerName}
                onChange={(e) => setManufacturerName(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="serialPrefix" className="block text-xs font-medium text-slate-700">
                Serial Prefix
              </label>
              <input
                id="serialPrefix"
                required
                value={serialPrefix}
                onChange={(e) => setSerialPrefix(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="unitCount" className="block text-xs font-medium text-slate-700">
                Units in Batch (1 – 100,000)
              </label>
              <input
                id="unitCount"
                type="number"
                min={1}
                max={100000}
                required
                value={unitCount}
                onChange={(e) => setUnitCount(Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label htmlFor="description" className="block text-xs font-medium text-slate-700">
              Technical Description
            </label>
            <textarea
              id="description"
              rows={2}
              required
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={includeClaimSecrets}
              onChange={(e) => setIncludeClaimSecrets(e.target.checked)}
            />
            Generate sealed one-time claim secrets (anti-QR-cloning protection)
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            <span>{submitting ? 'Anchoring Batch…' : 'Pin to IPFS & Register On-Chain'}</span>
          </button>
        </form>

        <div className="space-y-4 lg:col-span-7">
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">Registered Batches</h2>
              <button
                type="button"
                onClick={() => loadBatches()}
                className="text-xs font-medium text-emerald-700 hover:underline"
              >
                Refresh
              </button>
            </div>

            {batches.length === 0 ? (
              <p className="mt-4 text-sm text-slate-500">
                No batches registered yet. Create your first batch on the left.
              </p>
            ) : (
              <div className="mt-4 space-y-3">
                {batches.map((b) => (
                  <div
                    key={b.batch_id}
                    className="rounded-lg border border-slate-200 p-4 hover:border-slate-300"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-semibold text-slate-900">
                          {b.product_name || b.batch_code || b.batch_id.slice(0, 14)}
                        </div>
                        <div className="mt-0.5 font-mono text-xs text-slate-500">
                          Batch: {b.batch_code || b.batch_id.slice(0, 18)} · Units:{' '}
                          {Number(b.unit_count).toLocaleString()} · Split: {b.split_count}
                        </div>
                        <div className="mt-0.5 font-mono text-xs text-slate-500">
                          IPFS: {b.ipfs_cid.slice(0, 22)}…
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                            b.recalled
                              ? 'bg-rose-100 text-rose-800'
                              : b.onchain_confirmed
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {b.recalled
                            ? 'RECALLED'
                            : b.onchain_confirmed
                              ? CUSTODY_STATUS_LABELS[b.batch_status] || 'Confirmed'
                              : 'Pending Tx'}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleInspectBatch(b)}
                          className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Inspect Units & QR
                        </button>
                        {!b.recalled && b.onchain_confirmed && (
                          <button
                            type="button"
                            onClick={() => handleRecallBatch(b.batch_id)}
                            className="rounded-md border border-rose-300 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50"
                          >
                            Recall Batch
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {selectedBatch && (
            <div className="rounded-xl border border-slate-200 bg-white p-6">
              <h3 className="text-base font-semibold text-slate-900">
                Units in {selectedBatch.batch_code || selectedBatch.batch_id.slice(0, 12)} (showing
                up to 50)
              </h3>
              <div className="mt-3 max-h-64 overflow-y-auto divide-y divide-slate-100">
                {batchProducts.map((p) => (
                  <div key={p.product_id} className="flex items-center justify-between py-2 text-xs">
                    <div>
                      <span className="font-mono font-semibold text-slate-900">
                        {p.serial_number}
                      </span>{' '}
                      <span className="text-slate-500">
                        ({CUSTODY_STATUS_LABELS[p.custody_status] || p.custody_status})
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleGenerateQr(selectedBatch.batch_id, p.product_id)}
                      className="flex items-center gap-1 rounded bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-700"
                    >
                      <QrCode className="h-3.5 w-3.5" aria-hidden="true" />
                      Generate QR
                    </button>
                  </div>
                ))}
              </div>

              {qrBundle && (
                <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50/50 p-4">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                    <img
                      src={qrBundle.qrDataUrl}
                      alt={`QR Code for ${qrBundle.payload.serialNumber}`}
                      className="h-40 w-40 rounded-lg border border-slate-200 bg-white p-1"
                    />
                    <div className="min-w-0 flex-1 space-y-2 text-xs">
                      <div className="font-semibold text-slate-900">
                        Label Ready: {qrBundle.payload.serialNumber}
                      </div>
                      <div className="text-slate-600">
                        Sealed Claim Secret:{' '}
                        <code className="rounded bg-white px-1.5 py-0.5 font-mono text-emerald-800 border border-emerald-200">
                          {qrBundle.payload.claimSecret || 'Disabled'}
                        </code>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <a
                          href={qrBundle.qrDataUrl}
                          download={`${qrBundle.payload.serialNumber}-qr.png`}
                          className="inline-flex items-center gap-1 rounded bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-700"
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden="true" />
                          Download QR PNG
                        </a>
                        <button
                          type="button"
                          onClick={() =>
                            navigator.clipboard.writeText(JSON.stringify(qrBundle.payload))
                          }
                          className="rounded border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Copy QR JSON Payload
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
