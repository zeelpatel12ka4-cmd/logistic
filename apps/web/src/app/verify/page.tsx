'use client';

import React, { useRef, useState } from 'react';
import jsQR from 'jsqr';
import {
  QrCode,
  Camera,
  Upload,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  Cpu,
} from 'lucide-react';
import {
  computeLeaf,
  CUSTODY_STATUS_LABELS,
  QrPayload,
  QrPayloadSchema,
} from '@chaintrace/shared';
import { API_URL, DirectRpcResult, useWeb3 } from '../../lib/web3';

interface VerifyApiResponse {
  verdict: string;
  source: string;
  warning: string | null;
  product: {
    productId: string;
    batchId: string;
    batchCode?: string;
    serialNumber: string;
    productName?: string;
    sku?: string;
    manufacturerName?: string;
    manufacturerAddress?: string;
    ipfsCid?: string;
    metadataHash: string;
    claimSecretHash: string;
    merkleProof: string[];
    metadata?: Record<string, unknown>;
    currentCustodian: string;
    currentStatus: number;
    currentStatusLabel: string;
    claimed: boolean;
    recalled: boolean;
  };
  events: Array<{
    event_name: string;
    block_number: string;
    tx_hash: string;
    from_address: string | null;
    to_address: string | null;
    block_timestamp: string;
    is_finalized: boolean;
  }>;
  shipments: Array<{
    carrier_name: string;
    tracking_number: string;
    origin_location: string;
    destination_location: string;
    tx_hash: string;
  }>;
}

export default function VerifyPage() {
  const { verifyDirectlyViaRpc, getWriteContract, connectWallet, walletAddress } = useWeb3();

  const [identifierInput, setIdentifierInput] = useState('');
  const [qrJsonInput, setQrJsonInput] = useState('');
  const [claimSecretInput, setClaimSecretInput] = useState('');
  const [trustlessMode, setTrustlessMode] = useState(false);

  const [scanningCamera, setScanningCamera] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [verifyData, setVerifyData] = useState<VerifyApiResponse | null>(null);
  const [directRpcData, setDirectRpcData] = useState<{
    payload: QrPayload;
    result: DirectRpcResult;
    leafHex: string;
  } | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setScanningCamera(false);
  };

  const processQrText = async (raw: string) => {
    setQrJsonInput(raw);
    const parsedJson = JSON.parse(raw);
    const payload = QrPayloadSchema.parse(parsedJson);
    if (payload.claimSecret) {
      setClaimSecretInput(payload.claimSecret);
    }

    if (trustlessMode) {
      const result = await verifyDirectlyViaRpc(payload);
      const leafHex = computeLeaf(payload);
      setVerifyData(null);
      setDirectRpcData({ payload, result, leafHex });
    } else {
      const res = await fetch(`${API_URL}/api/verify/qr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qrPayload: payload, scannerRegion: 'Customer Web Portal' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || 'Verification failed');

      setDirectRpcData(null);
      setVerifyData({
        verdict: data.verdict,
        source: data.source,
        warning: null,
        product: {
          productId: payload.productId,
          batchId: payload.batchId,
          serialNumber: payload.serialNumber,
          metadataHash: payload.metadataHash,
          claimSecretHash: payload.claimSecretHash,
          merkleProof: payload.merkleProof,
          productName: data.dbProduct?.product_name,
          sku: data.dbProduct?.sku,
          manufacturerName: data.dbProduct?.manufacturer_name,
          ipfsCid: data.onChain?.ipfsCid || data.dbProduct?.ipfs_cid,
          metadata: data.dbProduct?.metadata_json,
          currentCustodian:
            data.onChain?.currentCustodian || data.dbProduct?.current_custodian || '',
          currentStatus: data.onChain?.currentStatus ?? data.dbProduct?.custody_status ?? 0,
          currentStatusLabel:
            data.onChain?.currentStatusLabel ??
            CUSTODY_STATUS_LABELS[data.dbProduct?.custody_status] ??
            'Unknown',
          claimed: Boolean(data.onChain?.isClaimed ?? data.dbProduct?.claimed),
          recalled: Boolean(data.onChain?.isRecalled ?? data.dbProduct?.recalled),
        },
        events: data.events || [],
        shipments: data.shipments || [],
      });
    }
  };

  const handleStartCamera = async () => {
    setErrorMessage(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage('Camera API unavailable (use Upload QR Image or Paste QR JSON instead).');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      setScanningCamera(true);

      setTimeout(() => {
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const tick = () => {
          if (!streamRef.current || !videoRef.current || !ctx) return;
          if (videoRef.current.readyState === videoRef.current.HAVE_ENOUGH_DATA) {
            canvas.width = videoRef.current.videoWidth;
            canvas.height = videoRef.current.videoHeight;
            ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imgData.data, imgData.width, imgData.height);
            if (code?.data) {
              stopCamera();
              processQrText(code.data).catch((err) =>
                setErrorMessage(err instanceof Error ? err.message : 'Invalid QR code'),
              );
              return;
            }
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }, 150);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? `Camera permission denied: ${err.message}` : 'Camera denied',
      );
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setErrorMessage(null);
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable');
      ctx.drawImage(bitmap, 0, 0);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const decoded = jsQR(imgData.data, imgData.width, imgData.height);
      if (!decoded?.data) {
        throw new Error('Could not decode a valid QR code from image');
      }
      await processQrText(decoded.data);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'QR image decode failed');
    }
  };

  const handleIdentifierLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      if (qrJsonInput.trim().startsWith('{')) {
        await processQrText(qrJsonInput.trim());
        return;
      }
      const res = await fetch(
        `${API_URL}/api/verify/${encodeURIComponent(identifierInput.trim())}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || 'Product lookup failed');
      setDirectRpcData(null);
      setVerifyData(data);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Verification failed');
    }
  };

  const handleClaimOwnership = async () => {
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const target = directRpcData?.payload || verifyData?.product;
      if (!target) throw new Error('Verify a product first');
      if (!walletAddress) await connectWallet();
      const contract = await getWriteContract();
      const tx = await contract.claimProduct(
        target.batchId,
        target.productId,
        target.serialNumber,
        target.metadataHash,
        target.claimSecretHash,
        target.merkleProof,
        claimSecretInput.trim(),
      );
      setStatusMessage(`Claim tx broadcast (${tx.hash.slice(0, 12)}…)…`);
      await tx.wait();
      setStatusMessage(`Product claimed! Your wallet is now the permanent owner (${tx.hash})`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Claim transaction reverted');
    }
  };

  const activeVerdict = directRpcData
    ? !directRpcData.result.isMerkleValid
      ? 'INVALID_MERKLE_PROOF'
      : directRpcData.result.isRecalled
        ? 'RECALLED'
        : directRpcData.result.isClaimed
          ? 'CLAIMED_AUTHENTIC'
          : 'VERIFIED_AUTHENTIC'
    : verifyData?.verdict;

  const isPositive =
    activeVerdict === 'VERIFIED_AUTHENTIC' || activeVerdict === 'CLAIMED_AUTHENTIC';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
            <QrCode className="h-6 w-6 text-emerald-600" aria-hidden="true" />
            Customer Product Authentication Portal
          </h1>
          <p className="text-sm text-slate-600">
            Scan a product QR code or enter a serial/product ID to independently verify authenticity
            and full supply chain custody.
          </p>
        </div>

        <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800 cursor-pointer">
          <input
            type="checkbox"
            checked={trustlessMode}
            onChange={(e) => setTrustlessMode(e.target.checked)}
          />
          <Cpu className="h-4 w-4 text-emerald-600" aria-hidden="true" />
          Trustless Direct-RPC Mode (bypass backend completely)
        </label>
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
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 lg:col-span-5">
          <h2 className="text-base font-semibold text-slate-900">Scan or Enter Product</h2>

          <div className="flex flex-wrap gap-2">
            {!scanningCamera ? (
              <button
                type="button"
                onClick={handleStartCamera}
                className="flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                <Camera className="h-4 w-4" aria-hidden="true" />
                Scan Live QR
              </button>
            ) : (
              <button
                type="button"
                onClick={stopCamera}
                className="rounded-md bg-rose-600 px-3 py-2 text-xs font-semibold text-white"
              >
                Stop Camera
              </button>
            )}

            <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
              <Upload className="h-4 w-4" aria-hidden="true" />
              Upload QR Image
              <input type="file" accept="image/*" onChange={handleImageUpload} className="sr-only" />
            </label>
          </div>

          {scanningCamera && (
            <video ref={videoRef} className="w-full rounded-lg border border-slate-300" muted />
          )}

          <form onSubmit={handleIdentifierLookup} className="space-y-3">
            <div>
              <label htmlFor="identifierInput" className="block text-xs font-medium text-slate-700">
                Serial Number or Product ID (0x…)
              </label>
              <input
                id="identifierInput"
                placeholder="e.g. SN-X1-000001 or 0x..."
                value={identifierInput}
                onChange={(e) => setIdentifierInput(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
              />
            </div>

            <div>
              <label htmlFor="qrJsonInput" className="block text-xs font-medium text-slate-700">
                Or Paste QR JSON Payload (required for Direct-RPC Trustless Verify)
              </label>
              <textarea
                id="qrJsonInput"
                rows={4}
                placeholder='{"v":1,"chainId":31337,...}'
                value={qrJsonInput}
                onChange={(e) => setQrJsonInput(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
              />
            </div>

            <button
              type="submit"
              className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
            >
              {trustlessMode ? 'Verify Directly on Blockchain (No Backend)' : 'Verify Authenticity'}
            </button>
          </form>
        </div>

        <div className="space-y-4 lg:col-span-7">
          {(verifyData || directRpcData) && (
            <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-4">
              <div
                className={`flex items-start gap-3 rounded-lg p-4 ${
                  isPositive
                    ? 'bg-emerald-50 border border-emerald-200 text-emerald-950'
                    : 'bg-rose-50 border border-rose-200 text-rose-950'
                }`}
              >
                {isPositive ? (
                  <ShieldCheck className="h-6 w-6 shrink-0 text-emerald-600" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="h-6 w-6 shrink-0 text-rose-600" aria-hidden="true" />
                )}
                <div>
                  <div className="text-base font-bold">Verdict: {activeVerdict}</div>
                  <div className="text-xs mt-0.5">
                    Verification Source:{' '}
                    <span className="font-mono font-semibold">
                      {directRpcData ? `DIRECT_BROWSER_RPC (${directRpcData.result.rpcUrl})` : verifyData?.source}
                    </span>
                  </div>
                  {verifyData?.warning && <div className="text-xs mt-1 font-medium">{verifyData.warning}</div>}
                  <div className="text-xs mt-1 text-slate-700">
                    Note: Digital verification confirms the blockchain commitment only and does not
                    independently establish physical packaging authenticity.
                  </div>
                </div>
              </div>

              {directRpcData && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs space-y-1.5">
                  <div className="font-semibold text-slate-900">
                    Cryptographic On-Chain Proof (Zero Backend Trust)
                  </div>
                  <div className="font-mono">Serial: {directRpcData.payload.serialNumber}</div>
                  <div className="font-mono break-all">Leaf: {directRpcData.leafHex}</div>
                  <div className="font-mono break-all">
                    Manufacturer: {directRpcData.result.manufacturer}
                  </div>
                  <div className="font-mono break-all">
                    Current Custodian: {directRpcData.result.currentCustodian}
                  </div>
                  <div>Status: {directRpcData.result.currentStatusLabel}</div>
                  <div>IPFS CID: {directRpcData.result.ipfsCid}</div>
                </div>
              )}

              {verifyData && (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-xs">
                    <div className="rounded-lg bg-slate-50 p-3">
                      <div className="text-slate-500">Product / Serial</div>
                      <div className="font-semibold text-slate-900 mt-0.5">
                        {verifyData.product.productName || 'Product'} ({verifyData.product.serialNumber})
                      </div>
                      <div className="font-mono text-slate-500 mt-0.5">
                        SKU: {verifyData.product.sku || '—'} · Batch: {verifyData.product.batchCode || '—'}
                      </div>
                    </div>
                    <div className="rounded-lg bg-slate-50 p-3">
                      <div className="text-slate-500">Current On-Chain Custody</div>
                      <div className="font-semibold text-slate-900 mt-0.5">
                        {verifyData.product.currentStatusLabel}
                      </div>
                      <div className="font-mono text-slate-500 mt-0.5 break-all">
                        {verifyData.product.currentCustodian}
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">
                      Supply Chain Provenance Timeline
                    </h3>
                    {verifyData.events.length === 0 ? (
                      <p className="mt-1 text-xs text-slate-500">
                        Verified via batch Merkle root (unit has not yet split individually on-chain).
                      </p>
                    ) : (
                      <ol className="mt-2 space-y-2 border-l-2 border-emerald-200 pl-4 text-xs">
                        {verifyData.events.map((ev, idx) => (
                          <li key={idx}>
                            <div className="font-semibold text-slate-900">
                              {ev.event_name}{' '}
                              <span className="font-mono font-normal text-slate-500">
                                (Block #{ev.block_number})
                              </span>
                            </div>
                            <div className="font-mono text-slate-500">
                              {ev.from_address ? `${ev.from_address.slice(0, 8)}… → ` : ''}
                              {ev.to_address ? `${ev.to_address.slice(0, 8)}…` : ''} · Tx{' '}
                              {ev.tx_hash.slice(0, 12)}…
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </>
              )}

              <div className="border-t border-slate-200 pt-4 space-y-2">
                <h3 className="text-sm font-semibold text-slate-900">
                  Claim Customer Ownership (Anti-Counterfeit Activation)
                </h3>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    aria-label="Sealed Claim Secret"
                    placeholder="Enter sealed claim secret (e.g. CT-...)"
                    value={claimSecretInput}
                    onChange={(e) => setClaimSecretInput(e.target.value)}
                    className="flex-1 rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={handleClaimOwnership}
                    className="rounded-md bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                  >
                    Claim On-Chain via MetaMask
                  </button>
                </div>
              </div>
            </div>
          )}

          {!verifyData && !directRpcData && (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
              Scan a QR label, upload a QR image, or enter a product serial to inspect provenance
              and verify authenticity.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
