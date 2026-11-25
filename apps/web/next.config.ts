import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@chaintrace/shared'],
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
