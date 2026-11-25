'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Search,
  AlertTriangle,
  Activity,
  GitBranch,
  ShieldAlert,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { API_URL } from '../../lib/web3';

interface EventRow {
  id: number;
  block_number: string;
  block_hash: string;
  tx_hash: string;
  log_index: number;
  event_name: string;
  batch_id: string | null;
  product_id: string | null;
  from_address: string | null;
  to_address: string | null;
  is_reorged: boolean;
  is_finalized: boolean;
  block_timestamp: string;
  payload: Record<string, unknown>;
}

interface AnomaliesResponse {
  failedTransactions: Array<{
    tx_hash: string;
    block_number: string;
    from_address: string;
    method_name: string | null;
    decoded_error: string | null;
    product_id: string | null;
    batch_id: string | null;
  }>;
  reorgEvents: Array<{
    id: number;
    detected_at_block: string;
    common_ancestor_block: string;
    rolled_back_event_count: number;
    detected_at: string;
  }>;
  suspiciousScans: Array<{
    id: number;
    product_id: string;
    scanner_region: string;
    anomaly_reason: string | null;
    scanned_at: string;
  }>;
  integrityMismatches: Array<{
    entityType: string;
    id: string;
    field: string;
    dbValue: unknown;
    chainValue: unknown;
  }>;
}

export default function ExplorerPage() {
  const [overview, setOverview] = useState<{
    chainTip: number | null;
    indexerLagBlocks: number | null;
    stats: Record<string, number>;
    rpcHealth: Array<{ url: string; circuitState: string; totalRequests: number; totalFailures: number }>;
  } | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [anomalies, setAnomalies] = useState<AnomaliesResponse | null>(null);
  const [includeReorged, setIncludeReorged] = useState(true);
  const [eventFilter, setEventFilter] = useState('');

  const [txLookupHash, setTxLookupHash] = useState('');
  const [txResult, setTxResult] = useState<Record<string, unknown> | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  const loadExplorer = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (includeReorged) qs.set('includeReorged', 'true');
      if (eventFilter) qs.set('eventName', eventFilter);

      const [ov, ev, an] = await Promise.all([
        fetch(`${API_URL}/api/explorer/overview`).then((r) => r.json()),
        fetch(`${API_URL}/api/explorer/events?${qs.toString()}`).then((r) => r.json()),
        fetch(`${API_URL}/api/explorer/anomalies`).then((r) => r.json()),
      ]);
      setOverview(ov);
      setEvents(ev.items || []);
      setAnomalies(an);
    } catch {
      // ignore if offline
    }
  }, [eventFilter, includeReorged]);

  useEffect(() => {
    loadExplorer();
  }, [loadExplorer]);

  const handleLookupTx = async (e: React.FormEvent) => {
    e.preventDefault();
    setTxError(null);
    setTxResult(null);
    try {
      const res = await fetch(`${API_URL}/api/explorer/tx/${txLookupHash.trim()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || 'Lookup failed');
      setTxResult(data);
    } catch (err) {
      setTxError(err instanceof Error ? err.message : 'Invalid transaction hash');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
            <Activity className="h-6 w-6 text-emerald-600" aria-hidden="true" />
            Blockchain Explorer & Integrity Monitor
          </h1>
          <p className="text-sm text-slate-600">
            Verify transaction hashes, inspect finality & block numbers, audit reverted
            unauthorized calls, and detect DB tampering or chain reorgs.
          </p>
        </div>
        <button
          type="button"
          onClick={() => loadExplorer()}
          className="rounded-md bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800"
        >
          Refresh Telemetry
        </button>
      </div>

      {overview && (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">Chain Tip / Lag</div>
            <div className="mt-1 text-lg font-bold">
              #{overview.chainTip ?? 'Offline'} ({overview.indexerLagBlocks ?? '—'} blk lag)
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">Canonical / Reorged Events</div>
            <div className="mt-1 text-lg font-bold">
              {overview.stats.canonicalEvents} / {overview.stats.reorgedEvents}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">Reverted Unauthorized Txs</div>
            <div className="mt-1 text-lg font-bold text-rose-700">
              {overview.stats.failedTransactions}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">RPC Pool Circuit State</div>
            <div className="mt-1 space-y-0.5 text-xs font-mono">
              {overview.rpcHealth.map((r) => (
                <div key={r.url} className="flex items-center justify-between">
                  <span className="truncate max-w-[140px]">{r.url}</span>
                  <span
                    className={
                      r.circuitState === 'CLOSED' ? 'text-emerald-700 font-bold' : 'text-rose-700 font-bold'
                    }
                  >
                    {r.circuitState}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
        <h2 className="text-base font-semibold text-slate-900">
          Verify Transaction Hash On-Chain & In Index
        </h2>
        <form onSubmit={handleLookupTx} className="flex flex-col gap-2 sm:flex-row">
          <input
            aria-label="Transaction hash"
            placeholder="0x… 64-hex transaction hash"
            value={txLookupHash}
            onChange={(e) => setTxLookupHash(e.target.value)}
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
          />
          <button
            type="submit"
            className="flex items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            Verify Hash
          </button>
        </form>
        {txError && (
          <div role="alert" className="text-xs text-rose-700">
            {txError}
          </div>
        )}
        {txResult && (
          <pre className="max-h-64 overflow-auto rounded-lg bg-slate-950 p-4 text-xs text-emerald-300">
            {JSON.stringify(txResult, null, 2)}
          </pre>
        )}
      </section>

      {anomalies && (
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-rose-200 bg-white p-5 space-y-3">
            <h2 className="flex items-center gap-2 text-base font-semibold text-rose-900">
              <XCircle className="h-5 w-5 text-rose-600" aria-hidden="true" />
              Detected Invalid / Unauthorized Transfer Attempts
            </h2>
            {anomalies.failedTransactions.length === 0 ? (
              <p className="text-xs text-slate-500">No reverted contract calls recorded.</p>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {anomalies.failedTransactions.map((ftx) => (
                  <div key={ftx.tx_hash} className="rounded-md bg-rose-50 p-3 text-xs">
                    <div className="font-semibold text-rose-900">
                      {ftx.decoded_error || 'Reverted Call'} ({ftx.method_name || 'unknown'})
                    </div>
                    <div className="font-mono text-rose-700 mt-0.5">
                      Block #{ftx.block_number} · From {ftx.from_address.slice(0, 10)}… · Tx{' '}
                      {ftx.tx_hash.slice(0, 14)}…
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-amber-200 bg-white p-5 space-y-3">
            <h2 className="flex items-center gap-2 text-base font-semibold text-amber-950">
              <GitBranch className="h-5 w-5 text-amber-700" aria-hidden="true" />
              Reorgs, Duplicate Scans & DB-vs-Chain Tamper Audit
            </h2>
            <div className="space-y-2 text-xs">
              {anomalies.integrityMismatches.length > 0 ? (
                anomalies.integrityMismatches.map((m, idx) => (
                  <div key={idx} className="rounded-md bg-rose-100 p-2.5 text-rose-950 font-semibold">
                    <ShieldAlert className="inline h-4 w-4 mr-1" />
                    DB Tamper Mismatch on {m.entityType} {m.id.slice(0, 12)}… ({m.field})
                  </div>
                ))
              ) : (
                <div className="flex items-center gap-1.5 rounded-md bg-emerald-50 p-2.5 text-emerald-900">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                  Live DB-vs-Chain integrity diff: 0 tampering mismatches
                </div>
              )}

              {anomalies.reorgEvents.map((r) => (
                <div key={r.id} className="rounded-md bg-amber-50 p-2.5 text-amber-950">
                  <AlertTriangle className="inline h-3.5 w-3.5 mr-1" />
                  Reorg rolled back {r.rolled_back_event_count} events from block #
                  {r.detected_at_block} to ancestor #{r.common_ancestor_block}
                </div>
              ))}

              {anomalies.suspiciousScans.map((s) => (
                <div key={s.id} className="rounded-md bg-amber-50 p-2.5 text-amber-950">
                  Suspicious scan on {s.product_id.slice(0, 12)}… ({s.scanner_region}):{' '}
                  {s.anomaly_reason}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-900">On-Chain Lifecycle Events</h2>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <select
              aria-label="Filter by event name"
              value={eventFilter}
              onChange={(e) => setEventFilter(e.target.value)}
              className="rounded-md border border-slate-300 px-2.5 py-1.5"
            >
              <option value="">All Events</option>
              <option value="BatchRegistered">BatchRegistered</option>
              <option value="ProductMaterialized">ProductMaterialized</option>
              <option value="TransferInitiated">TransferInitiated</option>
              <option value="CustodyAccepted">CustodyAccepted</option>
              <option value="ProductClaimed">ProductClaimed</option>
              <option value="BatchRecalled">BatchRecalled</option>
            </select>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={includeReorged}
                onChange={(e) => setIncludeReorged(e.target.checked)}
              />
              Show orphaned/reorged events
            </label>
          </div>
        </div>

        {events.length === 0 ? (
          <p className="text-sm text-slate-500">No indexed blockchain events yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="py-2 pr-4">Block</th>
                  <th className="py-2 pr-4">Event</th>
                  <th className="py-2 pr-4">Tx Hash</th>
                  <th className="py-2 pr-4">From → To</th>
                  <th className="py-2">Finality</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {events.map((ev) => (
                  <tr key={ev.id} className={ev.is_reorged ? 'bg-rose-50/50 line-through' : ''}>
                    <td className="py-2 pr-4 font-mono">#{ev.block_number}</td>
                    <td className="py-2 pr-4 font-semibold text-slate-900">{ev.event_name}</td>
                    <td className="py-2 pr-4 font-mono text-slate-600">
                      <button
                        type="button"
                        onClick={() => setTxLookupHash(ev.tx_hash)}
                        className="hover:text-emerald-700 hover:underline"
                      >
                        {ev.tx_hash.slice(0, 14)}…
                      </button>
                    </td>
                    <td className="py-2 pr-4 font-mono text-slate-600">
                      {ev.from_address ? ev.from_address.slice(0, 8) : '—'} →{' '}
                      {ev.to_address ? ev.to_address.slice(0, 8) : '—'}
                    </td>
                    <td className="py-2">
                      {ev.is_reorged ? (
                        <span className="rounded bg-rose-100 px-2 py-0.5 font-semibold text-rose-800">
                          REORGED
                        </span>
                      ) : ev.is_finalized ? (
                        <span className="rounded bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-800">
                          FINALIZED
                        </span>
                      ) : (
                        <span className="rounded bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">
                          CONFIRMING
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
