# ColabHub user guide (Banglish)

## Normal user-er jonno ki korte hobe

ColabHub use korte user-ke kono Client ID, Client Secret, Cloudflare URL, ba developer setup dite hobe na.

1. Chrome-e extension install/load korun.
2. Google Colab-e Drive-backed notebook open korun.
3. ColabHub icon click korun.
4. `Connect GitHub` click kore GitHub-er one-time code diye authorize korun.
5. Prothom sync-er somoy Google Drive permission-e `Allow` din.
6. `Create New Repository` ba `Connect Existing Repo` select korun.
7. `Auto-Push` on rekhe `Connect & Sync` click korun.
8. Erpor cell run korle notebook GitHub-e push hobe.

## Developer-ke user-er Gmail kokhon dite hobe

### Google app jodi Testing mode-e thake

Testing mode-e Google sudhu `Test users` list-e thaka account-ke permission dey. Tai prottek friend/tester-er Gmail developer-ke pathate hobe, ebong developer Google Cloud Console-e:

`Google Auth Platform -> Audience -> Test users -> Add users`

theke email add korbe.

Eta sudhu testing phase-er limitation. User nijer Gmail diye Google login korbe; developer user-er password ba token chaibe na.

### Google app jodi Production / In production mode-e thake

Production mode-e normal public user-der Gmail manually collect kore Test users-e add korte hoy na. User nijer account diye consent screen-e `Allow` korlei hobe.

Public release-er age developer-ke:

- Google OAuth consent screen complete korte hobe
- Privacy Policy URL ebong app information dite hobe
- Google verification lagle submit korte hobe
- Sudhu proyojoniyo `drive.readonly` scope rakhte hobe

## Ki konodin share kora jabe na

User ba developer kono password, GitHub token, Client Secret, Cloudflare secret, ba Drive access token chat/email-e share korbe na. Public Client ID code-e thakte pare, kintu secret shudhu backend/secure storage-e thakbe.

## Troubleshooting

- `Access blocked`: Google app Testing mode-e ache; user-ke Test users-e add korte hobe.
- `Google Drive access is not configured`: publisher build-e Google Client ID configure hoyni.
- `Only one web auth flow is allowed`: purono Google login tab bondho kore extension reload kore sudhu ekbar Sync Now click korun.
- `GitHub not connected`: Connect GitHub flow abar complete korun.
- `Not linked`: notebook-er jonno repository select kore `Connect & Sync` korun.
