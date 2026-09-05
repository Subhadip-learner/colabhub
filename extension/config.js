// config.js — build-time configuration, filled in ONCE by whoever publishes the build
// (run `npm run configure -- …`, see README → "Publisher setup"). End users never touch it.
// A developer loading the source unpacked can instead enter the same values on the popup's
// setup screen (lib/appconfig.js stores them in chrome.storage).
//
// GITHUB_CLIENT_ID     Client ID of the publisher's GitHub OAuth App (github.com → Settings →
//                      Developer settings → OAuth Apps). Callback URL:
//                      https://<extension-id>.chromiumapp.org/github
// TOKEN_EXCHANGE_URL   URL of the deployed backend/worker.js, e.g. https://colabhub-auth.<you>.workers.dev
//                      GitHub requires the OAuth App's client secret to turn the authorization code
//                      into a token, and the secret must never ship inside the extension — so this
//                      tiny backend holds it and does that one step. REQUIRED for the standard
//                      "Connect GitHub → Authorize" flow in a published build.
// GITHUB_CLIENT_SECRET Dev/personal builds only: exchange directly with github.com using this secret
//                      instead of the backend. Never put it in a build you distribute.
// GITHUB_AUTH_METHOD   'oauth'  (default) — authorization-code flow (+ PKCE): the user clicks Authorize
//                                 on GitHub's page, no codes to type.
//                      'device' — RFC 8628 device flow (user types a code on github.com). Needs no
//                                 backend or secret; use if the popup-based flow is blocked.
// GOOGLE_CLIENT_ID     Google OAuth "Web application" client ID used to read the notebook from Drive.
//                      Authorised redirect URI: https://<extension-id>.chromiumapp.org/google
// GOOGLE_AUTH_METHOD   'webflow' (default; any Chromium browser, account chooser) or 'chrome'
//                      (chrome.identity.getAuthToken; needs the `oauth2` manifest block).

export const CONFIG = Object.freeze({
  GITHUB_CLIENT_ID: '',
  TOKEN_EXCHANGE_URL: '',
  GITHUB_CLIENT_SECRET: '',
  GITHUB_AUTH_METHOD: 'oauth',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_AUTH_METHOD: 'webflow',

  GITHUB_SCOPES: 'repo read:org',
  DRIVE_SCOPE: 'https://www.googleapis.com/auth/drive.readonly',
});
