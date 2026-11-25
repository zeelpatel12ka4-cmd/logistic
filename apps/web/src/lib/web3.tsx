'use client';

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import {
  CHAIN_TRACE_REGISTRY_ABI,
  CUSTODY_STATUS_LABELS,
  QrPayload,
  ROLE_HASHES,
  SupplyChainRole,
} from '@chaintrace/shared';

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
export const PUBLIC_RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'http://127.0.0.1:8545';
export const TARGET_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || '31337');
export const DEFAULT_CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS || '';

interface EthereumProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

interface Web3ContextValue {
  walletAddress: string | null;
  chainId: number | null;
  isWrongNetwork: boolean;
  roles: SupplyChainRole[];
  token: string | null;
  isAuthenticated: boolean;
  contractAddress: string;
  isConnecting: boolean;
  error: string | null;
  connectWallet: () => Promise<void>;
  switchNetwork: () => Promise<void>;
  signInWithEthereum: () => Promise<void>;
  signOut: () => Promise<void>;
  getWriteContract: () => Promise<ethers.Contract>;
  apiFetch: <T>(path: string, init?: RequestInit) => Promise<T>;
  verifyDirectlyViaRpc: (payload: QrPayload) => Promise<DirectRpcResult>;
}

export interface DirectRpcResult {
  isMerkleValid: boolean;
  isInitialized: boolean;
  isRecalled: boolean;
  isClaimed: boolean;
  currentCustodian: string;
  pendingCustodian: string;
  currentStatus: number;
  currentStatusLabel: string;
  currentNonce: number;
  manufacturer: string;
  ipfsCid: string;
  rpcUrl: string;
}

const Web3Context = createContext<Web3ContextValue | undefined>(undefined);

function buildSiweMessage(params: {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  chainId: number;
  nonce: string;
}): string {
  const issuedAt = new Date().toISOString();
  return `${params.domain} wants you to sign in with your Ethereum account:
${params.address}

${params.statement}

URI: ${params.uri}
Version: 1
Chain ID: ${params.chainId}
Nonce: ${params.nonce}
Issued At: ${issuedAt}`;
}

export function Web3Provider({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [roles, setRoles] = useState<SupplyChainRole[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [contractAddress, setContractAddress] = useState<string>(DEFAULT_CONTRACT_ADDRESS);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    // Discover active contract address from API overview if not compiled into env
    if (!DEFAULT_CONTRACT_ADDRESS) {
      fetch(`${API_URL}/api/explorer/overview`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.contractAddress) {
            setContractAddress(data.contractAddress);
          }
        })
        .catch(() => {});
    }
  }, []);

  const fetchOnChainRoles = useCallback(
    async (address: string, targetContract: string) => {
      if (!targetContract) {
        try {
          const res = await fetch(`${API_URL}/api/auth/roles/${address}`);
          if (res.ok) {
            const data = (await res.json()) as { roles: SupplyChainRole[] };
            setRoles(data.roles);
          }
        } catch {
          setRoles([]);
        }
        return;
      }

      try {
        const provider = new ethers.JsonRpcProvider(PUBLIC_RPC_URL);
        const contract = new ethers.Contract(targetContract, CHAIN_TRACE_REGISTRY_ABI, provider);
        const [isAdmin, isMfg, isDist, isWh, isRet, isAud] = await Promise.all([
          contract.hasRole(ROLE_HASHES.DEFAULT_ADMIN_ROLE, address) as Promise<boolean>,
          contract.hasRole(ROLE_HASHES.MANUFACTURER_ROLE, address) as Promise<boolean>,
          contract.hasRole(ROLE_HASHES.DISTRIBUTOR_ROLE, address) as Promise<boolean>,
          contract.hasRole(ROLE_HASHES.WAREHOUSE_ROLE, address) as Promise<boolean>,
          contract.hasRole(ROLE_HASHES.RETAILER_ROLE, address) as Promise<boolean>,
          contract.hasRole(ROLE_HASHES.AUDITOR_ROLE, address) as Promise<boolean>,
        ]);
        const nextRoles: SupplyChainRole[] = [];
        if (isAdmin) nextRoles.push('ADMIN');
        if (isMfg) nextRoles.push('MANUFACTURER');
        if (isDist) nextRoles.push('DISTRIBUTOR');
        if (isWh) nextRoles.push('WAREHOUSE');
        if (isRet) nextRoles.push('RETAILER');
        if (isAud) nextRoles.push('AUDITOR');
        setRoles(nextRoles);
      } catch {
        setRoles([]);
      }
    },
    [],
  );

  useEffect(() => {
    if (!mounted || typeof window === 'undefined' || !window.ethereum) return;
    const eth = window.ethereum;

    const handleAccountsChanged = (accountsRaw: unknown) => {
      const accounts = Array.isArray(accountsRaw) ? (accountsRaw as string[]) : [];
      const next = accounts[0] ? ethers.getAddress(accounts[0]) : null;
      setWalletAddress(next);
      setToken(null);
      if (next) {
        fetchOnChainRoles(next, contractAddress);
      } else {
        setRoles([]);
      }
    };

    const handleChainChanged = (chainHex: unknown) => {
      const parsed = typeof chainHex === 'string' ? parseInt(chainHex, 16) : Number(chainHex);
      setChainId(Number.isFinite(parsed) ? parsed : null);
      setToken(null);
    };

    eth.on?.('accountsChanged', handleAccountsChanged);
    eth.on?.('chainChanged', handleChainChanged);
    return () => {
      eth.removeListener?.('accountsChanged', handleAccountsChanged);
      eth.removeListener?.('chainChanged', handleChainChanged);
    };
  }, [mounted, contractAddress, fetchOnChainRoles]);

  const connectWallet = useCallback(async () => {
    setError(null);
    if (!window.ethereum) {
      setError('MetaMask or an EIP-1193 wallet extension is required.');
      return;
    }
    setIsConnecting(true);
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = (await provider.send('eth_requestAccounts', [])) as string[];
      const network = await provider.getNetwork();
      const addr = ethers.getAddress(accounts[0]);
      setWalletAddress(addr);
      setChainId(Number(network.chainId));
      await fetchOnChainRoles(addr, contractAddress);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect wallet');
    } finally {
      setIsConnecting(false);
    }
  }, [contractAddress, fetchOnChainRoles]);

  const switchNetwork = useCallback(async () => {
    if (!window.ethereum) return;
    const hexChainId = `0x${TARGET_CHAIN_ID.toString(16)}`;
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: hexChainId }],
      });
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code;
      if (code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: hexChainId,
              chainName: TARGET_CHAIN_ID === 31337 ? 'Hardhat Localhost' : `Chain ${TARGET_CHAIN_ID}`,
              nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
              rpcUrls: [PUBLIC_RPC_URL],
            },
          ],
        });
      } else {
        setError(err instanceof Error ? err.message : 'Network switch failed');
      }
    }
  }, []);

  const signInWithEthereum = useCallback(async () => {
    setError(null);
    if (!window.ethereum) {
      setError('MetaMask is required for SIWE authentication');
      return;
    }
    const provider = new ethers.BrowserProvider(window.ethereum);
    let activeAddr = walletAddress;
    if (!activeAddr) {
      const accounts = (await provider.send('eth_requestAccounts', [])) as string[];
      activeAddr = ethers.getAddress(accounts[0]);
      setWalletAddress(activeAddr);
    }
    const network = await provider.getNetwork();
    const activeChainId = Number(network.chainId);
    setChainId(activeChainId);

    const nonceRes = await fetch(`${API_URL}/api/auth/nonce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: activeAddr }),
    });
    if (!nonceRes.ok) {
      throw new Error('Failed to obtain SIWE nonce from backend');
    }
    const { nonce } = (await nonceRes.json()) as { nonce: string };

    const message = buildSiweMessage({
      domain: window.location.host,
      address: activeAddr,
      statement: 'Sign in to ChainTrace Enterprise Supply Chain Platform',
      uri: window.location.origin,
      chainId: activeChainId,
      nonce,
    });

    const signer = await provider.getSigner();
    const signature = await signer.signMessage(message);

    const verifyRes = await fetch(`${API_URL}/api/auth/verify`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, signature }),
    });
    if (!verifyRes.ok) {
      const errBody = (await verifyRes.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      throw new Error(errBody.error?.message || 'SIWE verification failed');
    }
    const data = (await verifyRes.json()) as {
      token: string;
      user: { roles: SupplyChainRole[] };
    };
    setToken(data.token);
    setRoles(data.user.roles);
  }, [walletAddress]);

  const signOut = useCallback(async () => {
    setToken(null);
    await fetch(`${API_URL}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    }).catch(() => {});
  }, []);

  const getWriteContract = useCallback(async (): Promise<ethers.Contract> => {
    if (!window.ethereum) {
      throw new Error('MetaMask is not installed');
    }
    if (!contractAddress) {
      throw new Error('Contract address is not configured');
    }
    const provider = new ethers.BrowserProvider(window.ethereum);
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== TARGET_CHAIN_ID) {
      throw new Error(`Please switch MetaMask to chainId ${TARGET_CHAIN_ID}`);
    }
    const signer = await provider.getSigner();
    return new ethers.Contract(contractAddress, CHAIN_TRACE_REGISTRY_ABI, signer);
  }, [contractAddress]);

  const apiFetch = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const headers = new Headers(init?.headers || {});
      if (!headers.has('Content-Type') && init?.body) {
        headers.set('Content-Type', 'application/json');
      }
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      const res = await fetch(`${API_URL}${path}`, {
        ...init,
        headers,
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(body.error?.message || `API request failed (${res.status})`);
      }
      return (await res.json()) as T;
    },
    [token],
  );

  const verifyDirectlyViaRpc = useCallback(
    async (payload: QrPayload): Promise<DirectRpcResult> => {
      const targetAddr = payload.contractAddress || contractAddress;
      if (!targetAddr) {
        throw new Error('Smart contract address missing');
      }
      const provider = window.ethereum
        ? new ethers.BrowserProvider(window.ethereum)
        : new ethers.JsonRpcProvider(PUBLIC_RPC_URL);
      const contract = new ethers.Contract(targetAddr, CHAIN_TRACE_REGISTRY_ABI, provider);
      const res = await contract.verifyProductAuthenticity(
        payload.batchId,
        payload.productId,
        payload.serialNumber,
        payload.metadataHash,
        payload.claimSecretHash,
        payload.merkleProof,
      );
      const statusNum = Number(res.currentStatus);
      return {
        isMerkleValid: Boolean(res.isMerkleValid),
        isInitialized: Boolean(res.isInitialized),
        isRecalled: Boolean(res.isRecalled),
        isClaimed: Boolean(res.isClaimed),
        currentCustodian: res.currentCustodian,
        pendingCustodian: res.pendingCustodian,
        currentStatus: statusNum,
        currentStatusLabel: CUSTODY_STATUS_LABELS[statusNum] ?? 'Unknown',
        currentNonce: Number(res.currentNonce),
        manufacturer: res.manufacturer,
        ipfsCid: res.ipfsCid,
        rpcUrl: window.ethereum ? 'MetaMask Browser Provider' : PUBLIC_RPC_URL,
      };
    },
    [contractAddress],
  );

  const isWrongNetwork = chainId !== null && chainId !== TARGET_CHAIN_ID;

  return (
    <Web3Context.Provider
      value={{
        walletAddress,
        chainId,
        isWrongNetwork,
        roles,
        token,
        isAuthenticated: Boolean(token && walletAddress),
        contractAddress,
        isConnecting,
        error,
        connectWallet,
        switchNetwork,
        signInWithEthereum,
        signOut,
        getWriteContract,
        apiFetch,
        verifyDirectlyViaRpc,
      }}
    >
      {children}
    </Web3Context.Provider>
  );
}

export function useWeb3() {
  const ctx = useContext(Web3Context);
  if (!ctx) {
    throw new Error('useWeb3 must be used within Web3Provider');
  }
  return ctx;
}
