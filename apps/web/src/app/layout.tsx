import type { Metadata } from 'next';
import './globals.css';
import { Web3Provider } from '../lib/web3';
import { Navbar } from '../components/Navbar';

export const metadata: Metadata = {
  title: 'ChainTrace Enterprise — Supply Chain Provenance & Anti-Counterfeit Platform',
  description:
    'Decentralized supply chain tracking and product authentication built with Solidity Merkle anchors, reorg-safe indexing, IPFS, and trustless QR verification.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <Web3Provider>
          <Navbar />
          <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
        </Web3Provider>
      </body>
    </html>
  );
}
