# Releasing Dark Matter

Pushing a version tag builds the release packages and attaches them to a **draft** GitHub release:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

The [Release workflow](../.github/workflows/release.yml) builds a macOS DMG and zip (arm64 and x64) and a Linux AppImage and deb (x64) with electron-builder ([`packages/desktop/electron-builder.yml`](../packages/desktop/electron-builder.yml)). The version comes from the tag. Check the draft, then publish it. There is no auto-update channel: users download new versions by hand.

The headless core ships as an extra resource (`Contents/Resources/core/main.mjs`) and the app starts it with its own binary and `ELECTRON_RUN_AS_NODE=1` (ADR-0003).

## Signing and notarisation credentials

Credentials live only in the repository's Actions secrets (**Settings → Secrets and variables → Actions → New repository secret**). Never commit them. Without them, the workflow still builds, but the macOS app is unsigned and Gatekeeper will block it, and the run shows a warning.

| Secret | What it is |
| --- | --- |
| `CSC_LINK` | A **Developer ID Application** certificate and its private key, exported from Keychain Access as a `.p12`, then base64-encoded: `base64 -i cert.p12 \| pbcopy`. |
| `CSC_KEY_PASSWORD` | The password you set when exporting the `.p12`. |
| `APPLE_ID` | The Apple ID email of an account in the Apple Developer team. |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password for that Apple ID, created at [account.apple.com](https://account.apple.com) under **Sign-In and Security**. |
| `APPLE_TEAM_ID` | The 10-character Team ID from [developer.apple.com/account](https://developer.apple.com/account) under **Membership details**. |

With `CSC_LINK` and `CSC_KEY_PASSWORD` set, the app is signed with the hardened runtime and the entitlements in `packages/desktop/build/entitlements.mac.plist`. With the three `APPLE_*` secrets also set, electron-builder notarises and staples it, so the DMG opens without Gatekeeper warnings. Linux packages are not signed.

## Building locally

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm package            # unsigned packages for this OS, in packages/desktop/release/
pnpm --filter @dark-matter/desktop package --mac --dir   # just the .app, after pnpm build
```

To smoke-test a packaged app, point the Playwright test at its executable:

```sh
cd packages/desktop
DARK_MATTER_PACKAGED_APP="$PWD/release/mac-arm64/Dark Matter.app/Contents/MacOS/Dark Matter" \
  pnpm exec playwright test e2e/packaged.test.ts
```

CI builds unsigned packages and runs this test on every pull request.
