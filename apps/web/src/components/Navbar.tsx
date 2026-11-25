'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ShieldCheck, Factory, Truck, Search, QrCode, Wallet, AlertTriangle } from 'lucide-react';
import { TARGET_CHAIN_ID, useWeb3 } from '../lib/web3';

const NAV_ITEMS = [
  { href: '/', label: 'Overview', icon: ShieldCheck },
  { href: '/manufacturer', label: 'Manufacturer', icon: Factory },
  { href: '/logistics', label: 'Logistics', icon: Truck },
  { href: '/explorer', label: 'Explorer', icon: Search },
  { href: '/verify', label: 'Customer Verify', icon: QrCode },
];

export function Navbar() {
  const pathname = usePathname();
  const {
    walletAddress,
    chainId,
    isWrongNetwork,
    roles,
    isAuthenticated,
    isConnecting,
    connectWallet,
    switchNetwork,
    signInWithEthereum,
    signOut,
  } = useWeb3();

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2 font-semibold text-slate-900">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-white">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="tracking-tight">ChainTrace Enterprise</span>
          </Link>

          <nav aria-label="Primary navigation" className="flex flex-wrap items-center gap-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    active
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isWrongNetwork && (
            <button
              type="button"
              onClick={switchNetwork}
              className="flex items-center gap-1.5 rounded-md bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-200"
            >
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              Switch to Chain {TARGET_CHAIN_ID} (Current: {chainId})
            </button>
          )}

          {walletAddress ? (
            <div className="flex items-center gap-2">
              {roles.length > 0 && (
                <span className="rounded-md bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 border border-emerald-200">
                  {roles.join(' · ')}
                </span>
              )}
              <span className="rounded-md bg-slate-100 px-2.5 py-1 font-mono text-xs text-slate-700">
                {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}
              </span>
              {!isAuthenticated ? (
                <button
                  type="button"
                  onClick={() => signInWithEthereum().catch(() => {})}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                >
                  SIWE Sign In
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => signOut()}
                  className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Signed In (Logout)
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              disabled={isConnecting}
              onClick={() => connectWallet()}
              className="flex items-center gap-1.5 rounded-md bg-slate-900 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              <Wallet className="h-4 w-4" aria-hidden="true" />
              <span>{isConnecting ? 'Connecting…' : 'Connect Wallet'}</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
