function readEnv() {
  return {
    gatewayUrl: process.env.WEBMCP_GATEWAY_URL || undefined,
    profileId: process.env.WEBMCP_PROFILE_ID || undefined,
  };
}

module.exports = {
  readEnv,
};
