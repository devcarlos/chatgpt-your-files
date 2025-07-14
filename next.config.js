/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: true,
  },
  webpack: (config, { isServer }) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      sharp$: false,
      'onnxruntime-node$': false,
    };

    // Fix for @xenova/transformers
    if (isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
      };
    }

    // Exclude transformers from server-side bundling
    config.externals = config.externals || [];
    if (isServer) {
      config.externals.push('@xenova/transformers');
    }

    return config;
  },
};

module.exports = nextConfig;
