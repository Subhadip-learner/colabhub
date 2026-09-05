# ColabHub architecture (Banglish)

## Project ta ki kore

ColabHub Google Colab-er Drive-backed notebook ke GitHub repository-te sync kore. User cell run korle content script event detect kore, background service worker Drive theke latest `.ipynb` pore, tarpor GitHub Contents API diye commit kore.

## Folder guide

- `extension/`: Chrome extension-er actual runtime code. `manifest.json` permission, popup, background worker, ebong Colab content script connect kore.
- `extension/content/`: Colab page-er vitore thake. Cell run, save, ebong sync status toast handle kore. Notebook content DOM theke scrape kore na.
- `extension/popup/`: User interface. GitHub connect, repository select/create, Auto-Push, Auto-Sync, path, ebong granularity control ekhane.
- `extension/lib/`: Reusable logic. `auth.js` OAuth, `drive.js` Google Drive read, `github.js` GitHub API, `notebook.js` notebook parsing/secret scan, `syncEngine.js` conflict-safe commit plan handle kore.
- `backend/`: Cloudflare Worker. Standard OAuth flow use korle GitHub client secret ekhane thake; extension-er vitore kono secret thake na.
- `tests/`: Core sync, auth, Worker, conflict, secret-scan, ebong Auto-Push behavior-er automated tests.
- `scripts/`: configuration, demo build, extension packaging, ebong extension ID helper.

## Cell run theke GitHub commit porjonto

1. Colab content script cell run-er signal pay.
2. Background worker event-ta 8 second debounce kore, jate consecutive cell run-e unnecessary commit na hoy.
3. Google Drive metadata check kore notebook save hoyeche kina dekhe.
4. Notebook normalize kore hash calculate kore ebong high-signal secret scan kore.
5. Remote SHA last pushed SHA-r sathe compare kore conflict detect kore.
6. Change thakle GitHub Contents API expected SHA shoho update commit kore.
7. Status popup, toolbar badge, ebong Colab toast-e dekhay.

## Recruiter-facing design decisions

- Secret backend-e thake; extension-e GitHub client secret nei.
- GitHub Device Flow user-er jonno simple one-time code login dey.
- Google Drive token session storage-e thake; browser close hole clear hoy.
- Remote change silently overwrite hoy na; conflict user-ke dekhano hoy.
- Notebook-e API key/token detect hole automatic push block hoy.
- Release package JavaScript minify kore, kintu browser extension-er executable code completely hide kora jay na.

## Local validation

```text
npm test
npm run package
```

`npm test` core, background, ebong Worker behavior validate kore. `npm run package` release archive banay ebong client secret package-e dhukte dey na.
