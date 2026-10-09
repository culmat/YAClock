# YAClock for Android (and as an installable web app)

`fav.html` ships two ways, both free:

- **Web app (PWA):** iOS, Android and desktop. Open https://culmat.github.io/YAClock/fav.html, then use
  *Add to Home Screen* (iOS: Share menu) or *Install app* (Chrome). It runs fullscreen and offline (`sw.js`), and keeps
  the screen on where the Wake Lock API exists.
- **Android APK:** this folder holds a one-Activity WebView wrapper with no libraries and no permissions. It bundles
  `fav.html`, `clock.js` and `lib/d3.v6.min.js` as assets (copied from the repo root at build time), and runs
  immersive fullscreen with `FLAG_KEEP_SCREEN_ON`.

Icons and store screenshots are rendered from `fav.html` itself:
`npx -y -p playwright@1.58.1 -c "node dev/icons.mjs"` (from the repo root).

## Build locally

Needs JDK 17+ and the Android SDK (`ANDROID_HOME` or `android/local.properties` with `sdk.dir=...`).

```sh
cd android
./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## One-time: release signing key

Keep the keystore and passwords outside the repo, and back them up. Every update must be signed with the same key.

```sh
keytool -genkeypair -v -keystore ~/yaclock-release.jks -alias yaclock \
        -keyalg RSA -keysize 4096 -validity 10000
gh secret set YACLOCK_KEYSTORE_BASE64 < <(base64 -i ~/yaclock-release.jks)
gh secret set YACLOCK_KEYSTORE_PASSWORD
gh secret set YACLOCK_KEY_ALIAS --body yaclock
gh secret set YACLOCK_KEY_PASSWORD
```

## Releasing a version

1. Bump `versionCode` (+1) and `versionName` in `app/build.gradle`, and add
   `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt`.
2. Commit, tag `v<versionName>` (e.g. `v1.0.0`) and push the tag.
3. `.github/workflows/android.yml` checks that the tag matches `versionName`, builds the signed APK and attaches
   `YAClock-v<versionName>.apk` to the GitHub Release.

## Getting it into stores (all free)

| Store | How |
|---|---|
| Komi Store, Obtainium | Nothing to submit: users add `https://github.com/culmat/YAClock` and get the release APK plus updates. |
| IzzyOnDroid | Open an inclusion request at https://github.com/IzzySoft/repo/issues. It pulls the APK from GitHub Releases. |
| F-Droid | Fork https://gitlab.com/fdroid/fdroiddata, copy `fdroid/io.github.culmat.yaclock.yml` to `metadata/`, run `fdroid lint` / `fdroid build`, open a merge request. F-Droid builds from source and signs with its own key. |

Paid only, so not used: Google Play ($25 one-time) and the Apple App Store ($99/year). On iOS, use the web app.
