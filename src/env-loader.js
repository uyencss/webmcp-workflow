function readEnv() {
  return {
    gatewayUrl: process.env.WEBMCP_GATEWAY_URL || undefined,
    profileId: process.env.WEBMCP_PROFILE_ID || undefined,
    // Site store root for a pipeline's store-relative stage paths, for when the
    // pipeline lives outside the store tree — an automation repo consuming the
    // store as a dependency. See
    // docs/20260715_store_root_and_config_decoupling_plan.md.
    storeRoot: process.env.WEBMCP_STORE_ROOT || undefined,
    // Config path override. `gateways.<name>.profiles` is a per-machine alias
    // map, so it needs a home that is not the (read-only, shared) store.
    configPath: process.env.WEBMCP_CONFIG || undefined,
  };
}

module.exports = {
  readEnv,
};
