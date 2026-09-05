# ColabHub Project Documentation

## 1. Project overview

ColabHub holo ekta Chrome Manifest V3 extension ja Google Colab-er Drive-backed notebook-ke GitHub repository-te sync kore. Main idea chilo LeetHub-er moto simple experience: user Colab-e normal vabe kaj korbe, ar cell run/save hole notebook automatically GitHub-e commit hobe.

Repository: https://github.com/Subhadip-learner/colabhub

## 2. User problem

Manual notebook backup kora repetitive. User-ke protibar `.ipynb` download kore GitHub-e upload korte hoy. ColabHub ei process automate kore:

- GitHub account connect kore
- New ba existing repository select kore
- Current notebook-er real Drive filename use kore
- Cell run-er por Auto-Push kore
- Save/change hole Auto-Sync kore
- Conflict ba secret detect hole user-ke warn kore

## 3. Final user experience

Normal user-ke kono Client ID, Client Secret, Cloudflare URL, ba developer setup dite hoy na.

1. Chrome-e extension install/load.
2. Colab-e Drive-backed notebook open.
3. `Connect GitHub` click.
4. GitHub Device Flow-er one-time code diye authorize.
5. First sync-e Google Drive permission-e `Allow`.
6. `Create New Repository` ba `Connect Existing Repo`.
7. `Auto-Push` on rekhe `Connect & Sync`.
8. Colab-e cell run korlei GitHub commit.

## 4. Authentication architecture

### GitHub

GitHub Device Flow default kora hoyeche. Extension short code request kore, user GitHub device page-e code dey, ar background service worker polling kore authorization complete hole token secure Chrome storage-e rakhe.

Client ID public application identifier; eta publisher build-e embed kora thake. Client Secret Device Flow-te lage na. Standard OAuth backend flow-er jonno client secret Cloudflare Worker-e thake, extension-e thake na.

### Google Drive

Colab notebook-er actual bytes Google Drive API diye read kora hoy. Google OAuth Client ID publisher build-e thake. Drive token session storage-e thake, browser close hole clear hoy.

## 5. Gmail Test User rule

Google OAuth app `Testing` mode-e thakle Google sudhu Audience/Test users list-er account-ke access dey. Tai friend/tester-er Gmail developer-ke dite hobe ebong:

`Google Auth Platform -> Audience -> Test users -> Add users`

theke add korte hobe.

Eta temporary testing limitation. App `In production` mode-e niye Google verification complete korle public user-der Gmail manually collect kore Test users-e add korte hoy na. User nijer account diye consent screen-e Allow korbe.

Public release-er age branding, privacy policy, developer contact, domain verification, required scopes, ebong Google verification complete korte hobe.

## 6. Folder responsibilities

- `extension/`: Chrome extension runtime.
- `extension/manifest.json`: permissions, content scripts, popup, service worker.
- `extension/background.js`: auth orchestration, Drive sync, GitHub commit, alarms, badge, status.
- `extension/content/colab.js`: Colab cell-run/save detection and in-page toast.
- `extension/popup/`: simple UI for connection, repository linking, sync controls.
- `extension/lib/auth.js`: GitHub Device Flow, OAuth fallback, Google Drive auth.
- `extension/lib/drive.js`: Drive metadata and notebook download.
- `extension/lib/github.js`: GitHub REST API client.
- `extension/lib/notebook.js`: notebook parsing, filename/path rules, secret scanning.
- `extension/lib/syncEngine.js`: normalization, hashing, conflict-safe sync plan, GitHub write.
- `extension/lib/storage.js`: Chrome storage settings and notebook state.
- `backend/worker.js`: optional secure OAuth token exchange and revoke endpoint.
- `tests/`: background, sync engine, Worker, auth, conflict, and Auto-Push tests.
- `scripts/`: configure, demo, packaging, and extension ID utilities.
- `docs/`: architecture and user documentation.

## 7. Cell run to GitHub commit

1. Content script detects cell execution.
2. Background service worker debounces events for about 8 seconds.
3. Drive metadata confirms Colab saved the notebook.
4. Notebook is parsed and normalized.
5. SHA-256 and Git blob SHA are calculated.
6. Secret scanner checks for API keys, tokens, private keys, and passwords.
7. Remote SHA is compared with the last synced SHA.
8. Conflict is reported instead of silently overwriting someone else's work.
9. GitHub Contents API creates or updates `notebooks/<real-notebook-name>.ipynb`.
10. Popup, badge, and Colab toast show the result.

## 8. Push options

- Whole notebook: exact `.ipynb`, source, metadata, and outputs.
- Python script: code cells exported as `.py` with percent-style cell markers.
- Outputs log: outputs and execution log without source code.
- Strip outputs: optional code-only notebook commit.

Default path example:

`notebooks/ridge_regression.ipynb`

The name comes from Google Drive metadata, not the generic browser tab title `Google Colab`.

## 9. Safety and security

- Client Secret is never packaged inside the extension.
- Cloudflare Worker keeps the standard OAuth secret server-side.
- Access tokens are stored in Chrome storage, not in the repository.
- `.gitignore` excludes `.wrangler`, `.dev.vars`, key files, logs, archives, release output, and duplicate working folders.
- Secret scanning blocks automatic commits containing high-signal credentials.
- GitHub remote changes produce a conflict state rather than silent overwrite.
- Release packaging minifies JavaScript and includes a proprietary license notice.

Complete source protection is impossible for a browser extension because the browser must execute the code. Minification, backend secrets, and licensing reduce casual copying and protect sensitive credentials.

## 10. Validation

The project has 50 automated tests covering:

- GitHub authentication and Device Flow
- Cloudflare Worker exchange, CORS, and origin allow-list
- Google Drive access behavior
- Repository creation and existing repository linking
- Notebook serialization and hashing
- Secret scanning
- Conflict detection
- Auto-Sync and Auto-Push after cell execution
- Granularity conversion

Commands:

```text
npm test
npm run package
```

## 11. Recruiter-facing contribution summary

This project demonstrates:

- Chrome extension architecture with Manifest V3
- OAuth and device authentication flows
- Google Drive and GitHub REST API integration
- Cloudflare serverless backend deployment
- Event-driven background synchronization
- Debouncing and alarm-based retry handling
- Hash-based change detection
- Conflict-safe writes
- Secret scanning and secure credential handling
- Automated testing with Node test runner
- Production packaging and documentation
- User-focused UX iteration from complex setup flow to simple LeetHub-style connection

## 12. Important limitations

- Only Chrome/Chromium-based browsers are supported.
- Notebook must be saved in Google Drive and opened from a Drive URL.
- GitHub Contents API has file-size limits; large outputs should be stripped.
- Public Google release requires OAuth consent configuration and possibly verification.
- Auto-Push waits for Colab to save the notebook to Drive before committing.
