export default {
  reactStrictMode: true,
  webpack: (config) => {
    // @allin-ai/agentkit is consumed as TS source in this workspace; its
    // internal "./x.js" specifiers must resolve to the sibling .ts files.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return config;
  },
};
