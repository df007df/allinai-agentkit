export default {
  reactStrictMode: true,
  async rewrites() {
    // The CLI login flow opens GET ${hub}/_agentkit/login (LOGIN_PATH, the
    // reserved agentkit prefix). Next ignores underscore-prefixed path
    // segments, so the authorize page lives at /login and this rewrite maps
    // the reserved URL onto it.
    return [
      { source: "/_agentkit/login", destination: "/login" },
    ];
  },
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
