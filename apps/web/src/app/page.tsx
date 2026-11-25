'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ShieldCheck,
  Factory,
  Truck,
  Search,
  QrCode,
  ArrowRight,
  Database,
  Cpu,
  AlertOctagon,
} from 'lucide-react';
import { API_URL, useWeb3 } from '../lib/web3';

interface OverviewResponse {
  chainId: number;
  contractAddress: string;
  chainTip: number | null;
  indexerLagBlocks: number | null;
  stats: {
    totalBatches: number;
    totalUnitsAnchored: number;
    materializedProducts: number;
    claimedProducts: number;
    canonicalEvents: number;
    failedTransactions: number;
    reorgEvents: number;
    suspiciousScans: number;
  };
}

export default function HomePage() {
  const { walletAddress, roles, contractAddress } = useWeb3();
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/api/explorer/overview`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setOverview)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'API unreachable'));
  }, []);

  const cards = [
    {
      href: '/manufacturer',
      title: 'Module 1: Manufacturer Portal',
      description:
        'Generate deterministic serials, pin metadata to IPFS, anchor 100k+ product Merkle batches in O(1) gas, and export sealed QR labels.',
      icon: Factory,
      roleHint: 'Requires MANUFACTURER_ROLE',
    },
    {
      href: '/logistics',
      title: 'Module 2: Logistics & Partner Custody',
      description:
        'Role-adaptive Distributor, Warehouse, and Retailer workbench: accept custody, split batch units, update delivery milestones, attach carrier metadata.',
      icon: Truck,
      roleHint: 'Requires DISTRIBUTOR / WAREHOUSE / RETAILER',
    },
    {
      href: '/explorer',
      title: 'Module 4: Blockchain Explorer & Audit',
      description:
        'Inspect canonical blocks, verify tx hashes, inspect reverted unauthorized transactions, track reorgs, and run DB-vs-Chain tamper diffs.',
      icon: Search,
      roleHint: 'Public Audit View',
    },
    {
      href: '/verify',
      title: 'Module 5: Customer Verification Portal',
      description:
        'Scan QR via camera/image/ID, verify full provenance, detect cloned stickers, claim ownership, or verify trustlessly via direct RPC without our backend.',
      icon: QrCode,
      roleHint: 'Public & Zero-Trust RPC Mode',
    },
  ];

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 border border-emerald-200">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Enterprise Supply Chain Provenance (EVM + Merkle + IPFS + Reorg-Safe Postgres)
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              ChainTrace Enterprise Control Center
            </h1>
            <p className="max-w-3xl text-sm text-slate-600">
              Cryptographically verifiable custody tracking from factory floor to end customer.
              PostgreSQL serves as a fast, rebuildable search projection while smart contracts
              and Merkle proofs remain the authoritative source of truth.
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs space-y-1 min-w-[260px]">
            <div className="font-semibold text-slate-800">Active Network Binding</div>
            <div className="text-slate-600">
              Contract:{' '}
              <span className="font-mono text-slate-900">
                {contractAddress || overview?.contractAddress || 'Not deployed'}
              </span>
            </div>
            <div className="text-slate-600">
              Wallet:{' '}
              <span className="font-mono text-slate-900">
                {walletAddress || 'Not connected'}
              </span>
            </div>
            <div className="text-slate-600">
              Roles:{' '}
              <span className="font-semibold text-emerald-700">
                {roles.length > 0 ? roles.join(', ') : 'Public / Customer'}
              </span>
            </div>
          </div>
        </div>
      </section>

      {loadError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <AlertOctagon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Backend API telemetry unavailable ({loadError}). Customer Verification still works in
            Direct-RPC Trustless Mode on{' '}
            <Link href="/verify" className="font-semibold underline">
              /verify
            </Link>
            .
          </span>
        </div>
      )}

      <section aria-label="Platform Telemetry" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">Units Anchored On-Chain</div>
          <div className="mt-1 text-2xl font-bold text-slate-900">
            {overview?.stats.totalUnitsAnchored.toLocaleString() ?? '—'}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Across {overview?.stats.totalBatches ?? 0} batches
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">Canonical Chain Events</div>
          <div className="mt-1 text-2xl font-bold text-slate-900">
            {overview?.stats.canonicalEvents.toLocaleString() ?? '—'}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Chain Tip #{overview?.chainTip ?? '—'} (Lag: {overview?.indexerLagBlocks ?? '—'})
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">Materialized / Claimed</div>
          <div className="mt-1 text-2xl font-bold text-slate-900">
            {overview?.stats.materializedProducts ?? '—'} /{' '}
            {overview?.stats.claimedProducts ?? '—'}
          </div>
          <div className="mt-1 text-xs text-slate-500">Lazy-split & customer claimed</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">Security Anomalies Caught</div>
          <div className="mt-1 text-2xl font-bold text-rose-700">
            {overview
              ? overview.stats.failedTransactions +
                overview.stats.reorgEvents +
                overview.stats.suspiciousScans
              : '—'}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Reverts, reorgs & duplicate QR scans
          </div>
        </div>
      </section>

      <section aria-label="Platform Modules" className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <Link
              key={card.href}
              href={card.href}
              className="group rounded-xl border border-slate-200 bg-white p-6 transition hover:border-emerald-500 hover:shadow-md"
            >
              <div className="flex items-start justify-between">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-800 group-hover:bg-emerald-600 group-hover:text-white transition-colors">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                  {card.roleHint}
                </span>
              </div>
              <h2 className="mt-4 text-lg font-semibold text-slate-900 flex items-center gap-2">
                {card.title}
                <ArrowRight
                  className="h-4 w-4 text-slate-400 group-hover:translate-x-1 group-hover:text-emerald-600 transition-transform"
                  aria-hidden="true"
                />
              </h2>
              <p className="mt-2 text-sm text-slate-600">{card.description}</p>
            </Link>
          );
        })}
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Cpu className="h-4 w-4 text-emerald-600" aria-hidden="true" />
            On-Chain Source of Truth
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
            Solidity <code className="font-mono">ChainTraceRegistry</code> stores batch Merkle
            roots (<code className="font-mono">O(1)</code> gas for 1M+ units), role permissions,
            monotonic custody nonces, 2-step pending transfers, and sealed customer claim states.
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Database className="h-4 w-4 text-emerald-600" aria-hidden="true" />
            Reorg-Safe Indexed Projection
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
            PostgreSQL tracks <code className="font-mono">parentHash</code> continuity, rolls back
            orphaned blocks atomically on chain reorganizations, and never overrides on-chain
            ownership when verifying product authenticity.
          </p>
        </div>
      </section>
    </div>
  );
}
