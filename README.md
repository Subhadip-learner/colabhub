<img src="extension/icons/icon128.png" width="64" align="left" alt="ColabHub" />

# ColabHub — Write • Sync • Track: Google Colab ↔ GitHub

A Chrome (Manifest V3) extension that keeps your Google Colab notebooks committed to GitHub — LeetHub for Colab.

## User setup (Banglish)

Normal user-ke Client ID, Client Secret, Cloudflare URL, ba developer setup dite hoy na. User sudhu GitHub Device Flow diye connect korbe, first sync-e Google Drive permission debe, repository select korbe, ebong Auto-Push on rekhe Colab-e cell run korbe. Full Banglish guide: [`docs/USER_GUIDE_BN.md`](docs/USER_GUIDE_BN.md).

**Testing vs public release:** Google OAuth app `Testing` mode-e thakle prottek tester-er Gmail developer-ke dite hoy, jate `Google Auth Platform -> Audience -> Test users`-e add kora jay. App `In production` ebong Google verification complete hole public user-der Gmail collect kore Test users-e add korte hoy na.

```
Connect GitHub (OAuth) → Create / pick a repository → Choose Private / Public → Work normally in Colab
                                                                          ↓
              ColabHub commits after every save or every cell run — as .ipynb, .py or cell outputs
                                                                          ↓
                                  toast on the Colab page: "Pushed notebook to main after cell run"
```

## What's in the box

| Path | What it is |
|---|---|
| `extension/` | The unpacked Chrome extension (load this folder in `chrome://extensions`) |
| `extension/background.js` | MV3 service worker: auth, GitHub, Drive, sync orchestration, auto-sync alarms, badge |
| `extension/lib/github.js` | GitHub REST client (create repo, list repos/branches/orgs, get/put/delete file) |
| `extension/lib/drive.js` | Reads the notebook bytes out of Google Drive |
| `extension/lib/syncEngine.js` | `prepareNotebook` → `planSync` → `executeSync`; conflict detection |
| `extension/lib/notebook.js` | `.ipynb` helpers: strip outputs, secret scanner, filename/path/repo-name rules |
| `extension/lib/granularity.js` | Push granularity: `.ipynb` as-is, `.py` script export (`# %%` cells), outputs + execution log; repo search filter |
| `extension/lib/hash.js` | SHA-256 + git blob SHA-1 (Web Crypto) |
| `extension/popup/` | The UI: Connect GitHub → Home (two paths) → Create / Existing → Dashboard → Settings |
| `extension/content/colab.js` | Content script: notices Ctrl/Cmd+S and **cell executions**, shows the in-page status toast |
| `backend/worker.js` | ~100-line Cloudflare Worker that holds the OAuth App's client secret and turns the authorization code into a token (`/exchange`, `/revoke`, `/health`). Deployed once by the publisher |
| `backend/dev-server.mjs` | Runs the same worker locally with plain Node |
| `tests/` | Unit + integration tests (`npm test`, no dependencies) and a Playwright end-to-end run of the demo (`npm run test:e2e`, needs `playwright-core` + a Chromium) |
| `scripts/` | `configure`, `extension-id`, `generate-key`, `package`, `demo` (build), `demo:serve` |
| `demo/colabhub-demo.html` | **Interactive demo** — the real popup + service-worker code running against a simulated Chrome/GitHub/Drive in one HTML file (`npm run demo` rebuilds it) |

## How it works

### Getting the notebook out of Colab
Every Drive-backed Colab notebook has its file ID in the URL (`colab.research.google.com/drive/<fileId>`).
ColabHub asks Google for **read-only Drive access** and downloads the file with
`GET https://www.googleapis.com/drive/v3/files/<id>?alt=media` — byte-for-byte what *File → Download .ipynb* gives you.
Nothing is scraped from the Colab DOM, so Colab UI changes can't break it.

### Deciding whether (and how) to commit
```
prepareNotebook  raw JSON → (optionally strip outputs) → canonical bytes
                 → sha256 (local "did it change?") + git blob sha (== GitHub's content sha)
                 → secret scan

planSync         remote missing                      → create
                 remote.sha == local blob sha        → nothing to do
                 remote.sha == what we last pushed   → update (fast-forward)
                 remote.sha != what we last pushed   → CONFLICT (someone else changed it)
                 conflict + user chose "Overwrite"   → update (forced)

executeSync      PUT /repos/{owner}/{repo}/contents/{path}  (with the expected sha)
                 GitHub 409 → conflict (raced) — never silently overwrites
```

### Colab integration: Auto Sync, Auto-Push, granularity
* **Auto Sync** — a `chrome.alarms` timer (default every 5 min) checks Drive's `modifiedTime` for each connected notebook and syncs the ones that changed; the content script also reports **Ctrl/Cmd+S** and the background debounces a sync 30 s later.
* **Auto-Push (after cell run)** — the content script watches for cell executions (Shift/Ctrl/Alt+Enter in a cell, the ▶ button, *Runtime → Run …*, and the cell's running→done transition) and sends `cellExecuted`; the background debounces 8 s (people run several cells in a row) and pushes at the notebook's granularity. Off by default; per-notebook toggle on the dashboard, default for new notebooks in Settings.
* **Push granularity** (per notebook):

  | Mode | File committed | What's in it |
  |---|---|---|
  | Whole notebook | `notebooks/Name.ipynb` | exact `.ipynb` (optionally with outputs stripped) |
  | Python script | `notebooks/Name.py` | code cells as a runnable script in the `# %%` percent format (VS Code / Spyder / jupytext compatible); markdown as comments; `!pip` / `%magic` lines kept as `# [colab]` comments |
  | Cell outputs + log | `notebooks/Name.outputs.json` | per-cell outputs (stdout, results, errors with ANSI stripped, images), execution times, and a one-line-per-cell execution log — no source |

  Changing the granularity swaps the path's extension automatically; the next sync re-plans against the new remote file.
* Auto Sync / Auto-Push **never** resolve conflicts or commit detected secrets — those wait for you in the popup (the toolbar badge turns red `!`).

### Status feedback
After every sync the background writes a status line — `Pushed notebook to main after cell run`, `Added .py to dev (manual)`, `Cell ran — nothing new to push (script unchanged)`, … — and shows it in three places: the **toolbar badge** (✓ / … / • / !) with the line as its tooltip, the **popup dashboard** (with a *view commit* link), and a **toast on the Colab page** (shadow-DOM, bottom-right, auto-hides; warnings for conflict / secrets / errors).

### Security defaults
* **Private** is the default visibility; choosing Public shows a warning and a confirm.
* Standard GitHub **OAuth 2.0 authorization-code flow (+ PKCE)**. The OAuth App's client secret lives **only in the publisher's Worker** — never in the extension, never shown to users. (For a personal build it can sit in the browser profile instead; Device Flow is a no-secret alternative; a PAT is only a fallback for local development.)
* GitHub token lives in `chrome.storage.local`; the Drive token only in `chrome.storage.session` (cleared when the browser closes).
* Before every commit the notebook is scanned for high-signal secret patterns (GitHub/OpenAI/Anthropic/AWS/Google/Slack/HF/Stripe tokens, private keys, JWTs, `password = "…"`). Findings **block the commit** until you remove them or click *Commit anyway*.
* Optional **Strip outputs** mode commits code only — outputs are where printed secrets and 20 MB base64 images live.

## Who does what: publisher vs. user

The OAuth App and the token-exchange backend identify the *app*, not the user. They are set up **once by whoever
publishes the build** (the developer). End users never see a Client ID, a secret, a Worker URL or any setup screen.

| | Publisher (once) | End user (every install) |
|---|---|---|
| GitHub | registers **one** OAuth App, deploys the Worker with its secret | clicks **Connect GitHub** → GitHub's *Authorize* page → **Connected as @username** |
| Google | creates one OAuth client for Drive read-only | clicks *Allow* on Google's consent screen at first sync |
| Files | runs `npm run configure -- …` once, packages `extension/` | installs; nothing to edit |

```
click icon  →  one dark dashboard:  ● GitHub connection  [Connect GitHub]      ← GitHub's "Authorize ColabHub" page → Authorize (once)
                                    Current notebook  <title>  notebooks/<Name>.ipynb   [Not linked]
                                    📁 Create New Repository    🔗 Connect Existing Repo
            →  📁 name · description · Private/Public · README · .gitignore   |  🔗 search → pick repo → branch
               (path · granularity · Auto-Push under "Notebook options")      |     path · granularity · Auto-Push
            →  (Google Drive read-only consent — once)  →  Repository created ✓ · Sync Now
            →  run cells in Colab → "✅ Pushed notebook to main after cell run"
```
The GitHub card shows *Backend OAuth proxy ready* before sign-in and *@username · Disconnect* after; the notebook
card shows *Not Colab* on other tabs; the two action rows are disabled until both are green.
Afterwards, clicking the icon on that notebook goes straight to the dashboard.

If someone loads the *source* unpacked (no values in `config.js`), the popup shows a **Publisher setup** screen
instead of a dead button: callback URLs with Copy buttons, a box for the Client ID, the Worker URL with a **Test**
button, the Google client ID. Saved in `chrome.storage`, done once per profile.

## Try the demo first (no setup)

Open `demo/colabhub-demo.html` in a browser (or `npm run demo:serve` and visit http://localhost:8080/). It embeds the actual extension code and fakes only the outside world
(Chrome APIs, the GitHub REST API, Google Drive, the OAuth popups), so every screen — Connect → Create/Existing →
Dashboard → secrets blocked → conflict → auto-sync — is the real UI. Buttons on the right let you edit the notebook,
paste an API key, simulate a teammate editing on GitHub, **run a cell**, press Ctrl+S, or fire the auto-sync timer.

## Publisher setup (once, ~15 minutes)

You need three things: a GitHub OAuth App, the deployed token-exchange Worker (free), and a Google OAuth client.

> **Why a backend at all?** GitHub's token endpoint requires the OAuth App's `client_secret` — even with PKCE
> ("GitHub does not distinguish between public and confidential clients"). A secret-less exchange is answered with
> `incorrect_client_credentials` — *"The client_id and/or client_secret passed are incorrect"*. A secret can't ship
> inside an extension (anyone can unzip it), so the extension does the whole user-facing flow itself and asks a
> ~100-line Worker to do the one step that needs the secret. The Worker stores nothing.

### 0. Prerequisites
```bash
git clone <this repo> && cd colabhub
npm test                 # 51 tests should pass; no dependencies to install
npm run extension-id     # prints the extension ID + the redirect URLs used below
```
The ID is pinned by the `key` in `manifest.json`, so it's the same on every machine:

```
Extension ID:           opghjahdadhgakfklikfgmibfpajbggj
GitHub OAuth callback:  https://opghjahdadhgakfklikfgmibfpajbggj.chromiumapp.org/github
Google redirect URI:    https://opghjahdadhgakfklikfgmibfpajbggj.chromiumapp.org/google
```
(If you fork this project, run `npm run generate-key -- --force` once to get your own ID, and put it in `backend/wrangler.toml → ALLOWED_EXTENSION_IDS`.)

### 1. GitHub OAuth App
GitHub → Settings → Developer settings → **OAuth Apps → New OAuth App**
* Application name: `ColabHub`; Homepage URL: anything (your repo URL)
* **Authorization callback URL:** `https://<extension-id>.chromiumapp.org/github`
* **Register application** → copy the **Client ID** (`Ov23li…`)
* **Generate a new client secret** → copy it (shown once). It goes into the Worker in the next step, nowhere else.

### 2. Token-exchange backend — Cloudflare Worker, free tier
```bash
cd backend
npx wrangler login                            # opens the Cloudflare sign-up/login page (free account is enough)
npx wrangler secret put GITHUB_CLIENT_ID      # paste the Client ID
npx wrangler secret put GITHUB_CLIENT_SECRET  # paste the client secret
npx wrangler deploy                           # → https://colabhub-auth.<your-subdomain>.workers.dev
cd ..
```
Copy the URL it prints. `wrangler.toml` already restricts callers to the extension's origin via `ALLOWED_EXTENSION_IDS`.
Check it: `curl https://colabhub-auth.<you>.workers.dev/health` → `{"ok":true,"service":"colabhub-auth",…,"client_id_set":true,"secret_set":true}`.

For local hacking without Cloudflare:
```bash
GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… npm run backend:dev    # http://localhost:8787
```

### 3. Google OAuth client (Drive read-only)
[Google Cloud Console](https://console.cloud.google.com/) → new project → **APIs & Services**
1. **Enable** the *Google Drive API*.
2. **OAuth consent screen**: External, add scope `…/auth/drive.readonly`, add yourself as a test user (fine while in "Testing").
3. **Credentials → Create → OAuth client ID → Web application**
   * Authorised redirect URI: `https://<extension-id>.chromiumapp.org/google`
   * Copy the **Client ID**.

> Alternative: create a *Chrome Extension* type client with your extension ID and use `--google-auth-method chrome`.
> That uses `chrome.identity.getAuthToken` (no account chooser, Chrome-only, requires the user to be signed into Chrome).

### 4. Bake the values into the build and load it
```bash
npm run configure -- \
  --github-client-id     Ov23lixxxxxxxx \
  --token-exchange-url   https://colabhub-auth.<you>.workers.dev \
  --google-client-id     1234567890-abc.apps.googleusercontent.com
```
Then `chrome://extensions` → **Developer mode** → **Load unpacked** → pick the `extension/` folder (or `npm run package`
and ship the zip). Every install of this build opens straight on **Connect GitHub**.

Alternatives (not for distribution):
```bash
# personal build, no Worker: the secret sits in config.js / the browser profile and the extension talks to github.com directly
npm run configure -- --github-client-id Ov23li… --github-client-secret <40-hex> --google-client-id …
# device flow: no secret and no backend, but the user types a code on github.com ("Enable Device Flow" on the OAuth App)
npm run configure -- --github-auth-method device --github-client-id Ov23li… --google-client-id …
```
(Or leave `config.js` empty, load unpacked, and enter the same values on the popup's Publisher setup screen.)

Open any notebook at `colab.research.google.com/drive/…`, click the ColabHub icon:

```
Connect GitHub  →  📁 Create New Repository   or   🔗 Connect Existing Repository  →  Sync Now / Auto-Push
```

### Try it without any OAuth setup
Leave `config.js` empty, load the extension, and connect with a **personal access token** (the popup offers this when OAuth isn't configured). You'll still need the Google client ID to read notebooks — that one can't be skipped.

### Troubleshooting sign-in
| Message | Cause → fix |
|---|---|
| *GitHub: The client_id and/or client_secret passed are incorrect … no token-exchange backend configured* | The build has a Client ID but no Worker URL (or secret). Deploy the Worker and set `TOKEN_EXCHANGE_URL`. |
| *could not reach the token-exchange backend at …* | Worker not deployed / wrong URL / offline. `npm run backend:deploy`, check the URL, `curl …/health`. |
| *the backend … rejected this extension* / `forbidden_origin` | Extension ID not in `ALLOWED_EXTENSION_IDS` (`backend/wrangler.toml`) → add it, redeploy. |
| *the backend … has the wrong GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET* | Secrets don't match this OAuth App → `npx wrangler secret put` both again, redeploy. |
| *redirect_uri is not associated with this application* (on GitHub's page) | Callback URL on the OAuth App ≠ `https://<extension-id>.chromiumapp.org/github`. |

## The MVP checklist from the design, mapped to code

| Feature | Where |
|---|---|
| Connect GitHub — standard OAuth (authorization code + PKCE), token exchange in the publisher's Worker; Device Flow / PAT as fallbacks | `lib/auth.js#githubOAuth`, `backend/worker.js`, popup *connect* view |
| Create repository (name, description, public/private, README, .gitignore template, owner = user/org) | `lib/github.js#createRepo`, `background.js#createRepoAndConnect`, popup *create* view |
| Use existing repository: **search** → select repo → branch | `listRepos`/`listBranches`, `granularity.js#filterRepos`, popup *existing* view |
| Auto-Push after cell execution | `content/colab.js` (detection) → `background.js` `cellExecuted` / `pushAfterCell` |
| Push granularity: `.ipynb` / `.py` script / outputs + log | `lib/granularity.js`, `syncEngine.js#prepareNotebook` |
| Status feedback: toast on Colab page + toolbar badge/tooltip + dashboard | `background.js#notifyTabs`/`refreshBadge`, `content/colab.js` toast |
| Detect current notebook, get `.ipynb` | `notebook.js#driveIdFromColabUrl`, `lib/drive.js` |
| Detect changes / SHA-256 | `syncEngine.js#prepareNotebook` (+ Drive `modifiedTime` pre-check in `runAutoSync`) |
| Manual sync, custom commit message | dashboard *Sync Now* / ✎ |
| Auto sync | `chrome.alarms` + content-script save hook |
| Create/update file, commit | `github.js#putFile` |
| Conflict detection | `syncEngine.js#planSync` + 409 handling |
| Sync status | dashboard status card + toolbar badge |
| Private by default, public warning | popup *create* view |
| Never commit obvious secrets | `notebook.js#scanForSecrets`, enforced in `background.js#doSync` |

## Known limitations (deliberate MVP cuts)
* One notebook ↔ one file. No pulling changes *from* GitHub back into Colab (Colab has its own "Open from GitHub" for that).
* Files > ~50 MB can't go through the Contents API (GitHub limit). Enable *Strip outputs* for notebooks with huge outputs.
* Notebooks opened from GitHub or the Colab tutorials aren't Drive files — save a copy to Drive first.
* Chrome/Chromium-based browsers only (uses `chrome.identity`).

## Publishing
`npm run package` produces `release/colabhub-<version>.zip` with the `key` stripped (the Web Store forbids it).
To keep the same extension ID in the store — and therefore the same OAuth redirect URLs and the Worker's `ALLOWED_EXTENSION_IDS` — upload the **private key** (`keys/dev-key.pem`) during the first store submission, or re-register the callback URLs (and update `wrangler.toml`) with the store-assigned ID.
Make sure the packaged `config.js` contains the Client ID and the Worker URL and **no** `GITHUB_CLIENT_SECRET` (`npm run configure` prints a warning if it does).
