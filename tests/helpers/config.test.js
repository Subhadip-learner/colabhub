// Test fixture standing in for extension/config.js (swapped in by config-hook.mjs).
export const CONFIG = Object.freeze({
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_AUTH_METHOD: 'oauth',
  GITHUB_CLIENT_SECRET: '',
  TOKEN_EXCHANGE_URL: '',
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_AUTH_METHOD: 'webflow',
  GITHUB_SCOPES: 'repo read:org',
  DRIVE_SCOPE: 'https://www.googleapis.com/auth/drive.readonly',
});
