# macOS Optimization Plan

**Verdict** — The app runs on macOS today, but it cannot be *distributed* on macOS today. Launched from source (`npm start`) it boots, plays, scores and serves phone remotes; the mic works because Electron's stock `Info.plist` happens to carry `NSMicrophoneUsageDescription`, and Chromium raises the TCC prompt itself. But `forge.config.js` produces a bare `.zip` of an ad-hoc-signed, un-notarized `.app` with the Electron atom icon, bundle id `com.electron.encore-karaoke` and category `public.app-category.developer-tools` — Gatekeeper on macOS 15+ hard-blocks it and the right-click→Open bypass is gone. Beyond packaging, two data-layer bugs will make the app look empty or duplicated on real libraries: uppercase `.MP3`/`.CDG` pairs are dropped entirely (`FsSvc.js:499`), and macOS AppleDouble `._*` files are ingested as playable songs and written into `songdb.json` inside the library folder, corrupting state that syncs back to Windows. Everything else in this dossier is polish, latency, or power — real, but not what stops a release.

Scope note: several findings below (case-sensitivity, `.webm` recordings, the unauthenticated LAN routes) are cross-platform bugs whose worst symptom happens to be macOS-shaped. They're kept here because they ship with the Mac build; they're flagged inline.

---

## Ship blockers

Must land before any macOS artifact is published.

### B1 — The .app is ad-hoc-signed, un-notarized, and delivered as a zip

`forge.config.js:7-42` has no `osxSign`/`osxNotarize`; `forge.config.js:53-56` is the only darwin maker (`maker-zip`). Because `osxSign` is absent, `@electron-forge/plugin-fuses` takes the `resetAdHocDarwinSignature: !hasOSXSignConfig && arch === 'arm64'` branch and re-signs the binary ad-hoc (`codesign -dvvv` on the Electron 43 template: `Signature=adhoc`, `TeamIdentifier=not set`, `Sealed Resources=none`).

Consequences, all compounding:
- Quarantined zip + ad-hoc signature = Gatekeeper refusal. On macOS 15+ the user must dig into System Settings → Privacy & Security → "Open Anyway".
- `Sealed Resources=none` means nothing seals `Contents/Resources/static` — the 158 MB of extraResource that contains 100% of the renderer code the app actually executes. The `OnlyLoadAppFromAsar` + asar-integrity fuses (`forge.config.js:80-81`) protect only `dist/main.js` + `dist/preload.js`.
- The ad-hoc cdhash changes every build, so macOS Application Firewall re-prompts "accept incoming connections?" on every launch (`serverHttp.listen()`, `main.js:1877`) and TCC grants are revoked on each update.
- Squirrel.Mac auto-update is impossible without a team-matching signature; `Squirrel.framework` ships unused today.

Fix: full block in **Ready-to-paste configs**. Key points — `continueOnError: false` (packager defaults it to `true`, so a signing failure silently degrades to a WARNING and you ship unsigned), hardened runtime plus an entitlements plist, and a DMG maker alongside the zip (Squirrel.Mac consumes the zip).

### B2 — Bundle identity is Electron's, not yours

`forge.config.js:7-42` sets no `appBundleId`, so `@electron/packager` derives `com.electron.encore-karaoke` (`mac.js` `defaultBundleName` → `filterCFBundleIdentifier`). `LSApplicationCategoryType` is inherited as `public.app-category.developer-tools`, the TCC usage strings are Electron's placeholders ("This app needs access to the microphone"), and `executableName: "encore-karaoke"` (`forge.config.js:41`) leaks into `CFBundleDisplayName` via `platform.js:55` → `mac.js:183` — so the mic prompt reads *"encore-karaoke" would like to access the microphone* next to the "Encore Karaoke.app" the user double-clicked.

CFBundleIdentifier is the key TCC, Launch Services, notarization tickets and Login Items all hang off. It must be final **in the same release as B1** — grants keyed to `com.electron.*` do not migrate.

### B3 — Uppercase CDG/MID libraries render zero songs

`FsSvc.js:496-502` lowercases the audio extension but tests `.mid`/`.kar` with raw `endsWith`; `FsSvc.js:538-561` does byte-exact sibling lookup against a `Set` of raw readdir names:

```js
const hasLrc = allFilenames.has(`${basename}.lrc`);
const hasCdg = allFilenames.has(`${basename}.cdg`);
```

Commercial CD+G packs (Sound Choice, Chartbuster, Zoom) ship `SC1234-01.MP3` + `SC1234-01.CDG`. `hasCdg` is false, `songData` stays null, the song is silently dropped. `Classic.MID` never even enters `processableFiles`. Verified: `TUNE-1234.MP3` with `TUNE-1234.CDG` present → `EMITTED: null`. An entire commercial library shows as an empty song list with no error.

Not macOS-specific (the Set is in-memory JS; volume case-sensitivity is irrelevant) — but it is a total-failure bug shipping in the Mac build.

### B4 — AppleDouble `._*` files become phantom songs and are persisted into the library

`main.js:317-336` (`/list`, the app's only directory walk) does zero name filtering. Reproduced on a real exFAT image: `ditto` of a folder with xattrs produced `['._Song A.lrc','._Song A.mp3','Song A.lrc','Song A.mp3']` from `readdir` — AppleDouble files are **not** hidden on exFAT/FAT32/SMB. Because they come in matched pairs, `._Song.mp3` finds `._Song.lrc` and passes the `hasLrc || hasCdg` gate at `FsSvc.js:563`; every `._X.mid`/`._X.kar` is emitted unconditionally at `FsSvc.js:604-608`.

Result: the library doubles with unplayable 4 KB entries titled `._Song A`, each consuming a real 5-digit code users dial on the phone remote. Worse, `FsSvc.js:773-782` → `main.js:1715-1738` writes them into `songdb.json` **inside the library folder**, so the corruption propagates to every Windows machine that syncs that drive. Same hole at `main.js:292-294` (`/user-bgv-list`) and `main.js:1607-1609` (`libmgr-get-library-contents`) — `path.extname("._Song.mp3") === ".mp3"`.

Fix (trivial, one line per site):

```js
// main.js:317 — before the stat loop
const visible = files.filter((n) => !n.startsWith("."));
```

Plus a defensive `!file.name.startsWith(".")` at `FsSvc.js:496` and a `songdb.json` cache-version bump, because caches already on disk contain phantoms.

### B5 — Unauthenticated filesystem enumeration exposed to the whole LAN

`main.js:1877` `serverHttp.listen(tryPort)` with no host binds all interfaces. `main.js:263` `/drives` returns every mount point on the Mac; `main.js:303` `POST /list` will `fs.readdir` any absolute path in `req.body.dir` — `{"dir":"/Users/jonathan"}` — with no token; `main.js:242` `server.use(cors())` is wildcard, so any page a guest's phone visits can script it. Only `/getFile` (`main.js:341`) is token-gated. `/yt-search` (`main.js:367`) is an open outbound search proxy.

Every renderer consumer already uses loopback (`FsSvc.js:232`, `:247`, `:834`), so LAN exposure buys nothing. Do **not** bind 127.0.0.1 — that kills the phone remote. Per-route middleware:

```js
const loopbackOnly = (req, res, next) => {
  const bare = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (bare === "127.0.0.1" || bare === "::1") return next();
  return res.status(403).json({ error: "local only" });
};
```

Apply to `/drives` (263), `/user-bgv-list` (275), `/list` (303), `/yt-search` (367), `/auth/create-hash` (374), `/auth/verify-hash` (385). Leave `/remote`, `/socket.io`, `/qr`, `/local_ip`, `/cloud_info`, `/getFile` and `express.static` public. Replace wildcard `cors()` with an allowlist built lazily inside the `listening` callback (PORT is 0 until then).

---

## Phase 1 — Make it work (~2-3 days + Apple Developer enrolment lead time)

Ordered by dependency. Tasks 1.1→1.5 are one commit's worth of `forge.config.js` work but must land in this order because entitlements are inert without signing, and the DMG maker throws on a missing `.icns`.

- [ ] **1.1 Generate `icon.icns` and make one `icon:` key serve all three platforms.**
  `sips`/`iconutil` an `.iconset` from `src/icons/icon.png` (675 KB) → `src/icons/icon.icns`. `build.js:112` filter is `if (file.endsWith(".ico") || file.endsWith(".png")) {` — add `|| file.endsWith(".icns")`. Then `forge.config.js:10` → `icon: "dist/resources/icon"` (extensionless). Verified mechanism: `platform.js:142-160` `normalizeIconExtension` appends `.icns` on darwin, `win32.js:46` appends `.ico`. Today `copyIcon()` silently no-ops and the bundle keeps `electron.icns`.
  Also fix `main.js:1468` `icon: "resources/icon.png"` → `path.join(__dirname, "resources/icon.png")` (cwd-relative; broken on every platform when launched from Finder), and gate `main.js:433`'s `.ico` behind `process.platform === "win32"`.

- [ ] **1.2 Bundle identity + Info.plist (`forge.config.js:7`).** `appBundleId`, `appCategoryType`, `appCopyright`, `usageDescription` (Microphone/Camera/AudioCapture/BluetoothAlways), `extendInfo` (`NSLocalNetworkUsageDescription`, `NSBonjourServices`, `NSRemovableVolumesUsageDescription`, `NSNetworkVolumesUsageDescription`). Do **not** put `CFBundleIdentifier` or `LSApplicationCategoryType` in `extendInfo` — packager writes those from `appBundleId`/`appCategoryType` and duplicates can conflict. See B2.
  Caveat recorded honestly: on macOS the local-network consent alert text is generated by NetworkExtension, **not** from `NSLocalNetworkUsageDescription`. Adding it is Apple-recommended hygiene (TN3179) and iOS future-proofing, not a repair for the bare prompt.

- [ ] **1.3 `CFBundleDisplayName` repair via `postPackage` hook.** `extendInfo` cannot fix it — `mac.js:174` applies extendInfo *before* `updatePlist` at `:183` overwrites `CFBundleDisplayName` with `executableName`. Must run before signing; `postPackage` does. Do not rename `Contents/MacOS/encore-karaoke` — `CFBundleExecutable` must keep matching it.

- [ ] **1.4 `osxSign` + `osxNotarize` + `build/entitlements.mac.plist`.** Gated on env vars so local unsigned `npm run package` still works. `continueOnError: false`. See B1 and the full config below.

- [ ] **1.5 `@electron-forge/maker-dmg`.** `npm i -D @electron-forge/maker-dmg`. Depends on 1.1 (throws on missing icon path). Keep `maker-zip` for darwin — Squirrel.Mac feeds on zips. Requires a macOS host (`isSupportedOnCurrentPlatform` is darwin-only).

- [ ] **1.6 `.github/workflows/macos-build.yml`.** No macOS CI exists (`find .github -type f` → only `linux-build.yml`, which is `ubuntu-latest` in an `archlinux:latest` container). `codesign`, `notarytool`, `iconutil` and `hdiutil` all need a real macOS host. Two matrix legs (`arm64`, `x64`) rather than `--arch=universal`: zero native modules means universal works, but it doubles the 276 MB Electron payload on top of 158 MB of resources and doubles notarization time.

- [ ] **1.7 B3 — case-insensitive extension + sibling matching (`FsSvc.js:494-561`).**
  ```js
  const ext = file.name.split(".").pop().toLowerCase();
  return file.type === "file" && (audioExtensions.has(ext) || ext === "mid" || ext === "kar");
  ```
  Add beside `allFilenames` at `FsSvc.js:494`: `const byLower = new Map(files.map((f) => [f.name.toLowerCase(), f.name]));` and route `:539-545`, `:547-554`, `:560-561` through it, storing the returned **on-disk** name in `lrcPath`/`cdgPath`/`videoPath`/`chorusPath`. Skip the proposed `LibraryManager.js:87` change — line 85 already tests `song.type === "mid"` and `type` comes from the lowercased extension (`FsSvc.js:531`), so it's a dead fallback.

- [ ] **1.8 B4 — dotfile filter (`main.js:317`, `:291-293`, `:1607-1609`, `FsSvc.js:496`).** Bump the songdb cache version in the same commit.

- [ ] **1.9 NFC-normalize the cache signature and code map (`FsSvc.js:370-397`, `:486`, `:720`).** Nothing in the app calls `String.prototype.normalize` (grep: zero hits). Verified empirically: an HFS+ image returns NFD for names written as NFC (`"Café - Señor.mp3"` len 18 vs 16); exFAT does the same; APFS round-trips what you wrote. Within one machine both sides of every comparison come from the same `readdir`, so this is **not** the cause of per-launch rebuilds — the real failure is cross-OS: `songdb.json` lives inside the library (`main.js:1722`), so a Windows-authored (NFC) cache opened on a Mac (NFD) mismatches the whole signature, one accented filename invalidates the entire library, and codes churn in both directions.
  ```js
  const nfc = (s) => (typeof s === "string" ? s.normalize("NFC") : s);
  ```
  Normalize the signature at `:377`, wrap `toRelative`'s return at `:394-397`, and build the sibling index (1.7) as `nfc(name).toLowerCase()`. Keep raw readdir bytes for actual I/O — APFS/HFS+/exFAT resolve either form.

- [ ] **1.10 B5 — loopback middleware + CORS allowlist (`main.js:242, 263, 275, 303, 367, 374, 385`).**

- [ ] **1.11 Fix LAN IP derivation (`main.js:244-252`).** `udpSocket.connect(80, "8.8.8.8")` returns whatever interface owns the **default route** — a `100.64.x.x` utun address under Tailscale, the Ethernet address on a Mac mini whose guests are on Wi-Fi, `bridge100` under Internet Sharing. The QR then encodes an unreachable URL and the phone just hangs. There is no `os.networkInterfaces()` call anywhere in the repo. Replace with explicit enumeration + a macOS pseudo-interface blacklist (`awdl|llw|utun|ipsec|gif|stf|bridge|ap\d|vmnet|XHC|anpi`), drop `169.254.*`, prefer `en*`, and return `{ primary, candidates }` from `/local_ip` so the UI can offer "wrong address? try this one".
  Coupled: `UIManager.js:907-927` duplicates the QR logic **without** the `if (!ip)` guard that `NetworkManager.js:100` has, so an empty `/local_ip` body renders a crisp QR for `http://:9864/remote`. Delete the duplicate, call `this.ctx.root.network.refreshQRCode()`, and harden the single guard to `if (!ip || ip === "0.0.0.0")`.

- [ ] **1.12 Surface microphone failures (`Microphone.js:113-115`).** Currently `catch (e) { console.error(...) }` — and `stopMicInput()` (`:153`) has already set `state.scoring.enabled = false`, so a denial leaves scoring silently dead forever with a mic icon still showing. Branch on `e.name`: `NotAllowedError` → `infoBar.showTemp("MIC", …)` + `shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")`; `OverconstrainedError`/`NotFoundError` → fall back to `deviceId: { ideal: deviceId }` or plain `audio: true` and re-enumerate. The `{ exact: deviceId }` at `Microphone.js:73` is the trap: Chromium salts deviceIds per-origin and this app's origin is `http://127.0.0.1:<PORT>` where PORT walks on EADDRINUSE (`main.js:1841-1852`) — a port shift alone invalidates every saved deviceId with no device unplugged. Note `src/remote/script.js:453-490` already does exactly this error branching for the phone camera; the pattern is known to the codebase and just absent from the desktop mic path.
  Add `navigator.mediaDevices.ondevicechange` (zero hits repo-wide) to repopulate the picker and re-arm capture, plus `track.onended`. Persist the mic selection by **label** as well as deviceId so the salt-rotation case can re-match.

- [ ] **1.13 Stop opening the mic at boot (`Forte.js:78`).** `await pkg.data.initializeScoringEngine()` is unconditional inside `start()`, and `BootManager.js:242` awaits the whole service — so first launch blocks the splash behind the TCC prompt, and the macOS menu-bar mic indicator stays lit for the entire session on a machine nobody is singing into. Move the call to first song start / explicit scoring toggle. (The AirPods A2DP→HFP claim is overstated on current macOS — output was decoupled from SCO — so sell this as boot-blocking + indicator + not-opening-hardware-you-don't-need.)
  Optional companion: after `getUserMedia` resolves, check `const s = stream.getAudioTracks()[0].getSettings(); if ((s.sampleRate && s.sampleRate <= 16000) || s.channelCount === 1) { warn }` — `getSettings().sampleRate` is not guaranteed populated, so test defensively.

- [ ] **1.14 `backgroundThrottling: false` on the right WebContents (`main.js:441` → `main.js:445`).** It's currently on the `BrowserWindow` that renders only the 55px `titlebar.html`; the `WebContentsView` at `:445-449` that hosts every rAF loop in the app (`Playback.js:156` master clock, `LyricsEngine.js:1240`, `PlaybackManager.js:310/351`, `Recorder.js:861`) has no throttling key. Move it. Electron 43's own typings note a window-level opt-out does influence child views, so this is not a from-zero fix — but the correct WebContents is the correct WebContents. Optional belt-and-braces before `app.whenReady()` near `main.js:583`: `app.commandLine.appendSwitch("disable-backgrounding-occluded-windows")` (verified present in the Electron 43 macOS binary). Do **not** add `disable-renderer-backgrounding` expecting it to fix rAF — it only affects process priority.
  Verify by occluding the window for 20s during a MIDI song and confirming `state.scoring.totalFramesSinging` kept climbing. Do not use lyric sync as the test — the >0.5s drift snap at `Playback.js:107` masks it.

- [ ] **1.15 `powerSaveBlocker` (`main.js:5`, `main.js:694`, `main.js:1880`).** Zero hits for `powerSaveBlocker|wakeLock|caffeinate` repo-wide. Chromium *does* hold a "Video Wake Lock" for muted BGV video under an overlay (verified with the repo's own `src/assets/video/bgv/3d/1.mp4` + `pmset -g assertions`), so the "TV goes dark mid-song" headline is wrong for the default config. The real gap is canvas-only mode: `UIManager.js:1574` calls `bgv.setCanvasOnlyMode(true)` for the lounge/standby screen (`BGVPlayer.js:696-723` removes the video `src` entirely), image backgrounds (`BGVPlayer.js:347-408`) and BGV category "Off" hold no assertion — and that's exactly where a phone-driven rig sits keyboard-idle for hours.
  Take the session-wide variant: `powerSaveBlocker.start("prevent-display-sleep")` in `app.whenReady()`, `stop(id)` in `before-quit`. Verify with `pmset -g assertions | grep PreventUserIdleDisplaySleep`.

- [ ] **1.16 Network stack teardown + lifecycle handlers (`main.js:1880`).** `grep 'app.on('` returns exactly one match. Add:
  ```js
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  ```
  ⚠️ **Conflict to resolve empirically first.** One finding claims Cmd+W leaves a zombie HTTP/socket.io/mDNS process; the adversarial pass on the Menu finding states Cmd+W "quits the whole app instantly." Both cannot be true. Test `Cmd+W` on a running build and check `pgrep -f "Encore Karaoke"` before writing the handler — you may want the appliance behaviour (quit) rather than the Mac default (stay resident).
  Independently required: mDNS goodbye on quit. `main.js:1856` publishes with a fresh `crypto.randomUUID()` name every launch (`main.js:73`) and nothing calls `unpublishAll()`, so `registry.js:124`'s `record.ttl = 0` teardown never runs and the PTR lingers at its 28800s TTL. (SRV/A records use `ttl: 120`, so the "stale SRV points at a reused port" argument is wrong — drop it.)
  ```js
  let goodbyeSent = false;
  app.on("before-quit", (event) => {
    /* existing win32 explorer.exe restart */
    if (goodbyeSent) return;
    goodbyeSent = true;
    event.preventDefault();
    const done = () => app.exit(0);
    const bail = setTimeout(done, 1500);
    instance.unpublishAll(() => { clearTimeout(bail); instance.destroy(done); });
  });
  ```
  Persist the Bonjour id via `Config.getItem("linkId")` at `main.js:73` so re-announcements replace rather than stack.

- [ ] **1.17 Defer + repair Bonjour (`main.js:72, 108, 145, 1856, 1865`).** Two browsers for the same `_encore-server` type are constructed at **module load**, before `app.whenReady()` and before any window exists — so the local-network prompt lands on a blank screen. `bonjour-service`'s `Browser.start()` calls `update()` exactly once (`mdns.query(name, 'PTR')`) and never re-queries; `multicast-dns`'s only recurring timer re-adds group memberships, it does not re-send queries. And `registry.js` `announce()` multiplies its delay by `REANNOUNCE_FACTOR=3` up to a 1-hour cap, so a peer that's been up an hour never re-announces either. A dropped or mistimed browse is permanent for the session.
  Collapse `:108` and `:145` into one browser constructed inside `app.whenReady()`, add `const t = setInterval(() => serverBrowser.update(), 30_000); t.unref();`, re-`update()` on `powerMonitor.on("resume")`, and wire diagnostics that are currently swallowed: `instance.server.mdns.on("warning", e => logger.warn("MDNS", e.message))`.
  Hoist the service-type strings so the plist array and the code can't drift: `const SVC_LINK = "enmoku"; const SVC_UPDATE = "encore-server";`

- [ ] **1.18 Sleep/wake + relay resilience (`main.js:604-606`).** `reconnectionAttempts: 5` (~17s at default backoff) with no `powerMonitor` handling anywhere. socket.io resets the counter on each successful connect, so this only kills the relay when the network stays down ~17s after wake — plausible on Wi-Fi reassociation. Set `reconnectionAttempts: Infinity, reconnectionDelayMax: 30000`. Add the `powerMonitor` suspend/resume block **inside** the `app.whenReady()` callback (Electron docs: not usable before ready; `cloudSocket` is block-scoped there anyway) to re-derive `local_ip` (1.11), re-`update()` the browser (1.17) and emit `network-changed` so `NetworkManager.refreshQRCode()` (`NetworkManager.js:81`) reruns. `UIManager.js:407-421`'s `updateNetwork` currently only swaps an icon — have it call `refreshQRCode()` too.

- [ ] **1.19 Filter the mount sweep (`main.js:266-267` and `main.js:1532`).** `si.fsSize()` on a real Mac returns 30-31 mounts: `/System/Volumes/{VM,Preboot,Update,xarts,iSCPreboot,Hardware,Data}`, a cryptexd mount, a MetalToolchain mount, 14 `/Volumes/.timemachine/*` NFS mounts, SMB shares. `findEncoreLibraries` (`FsSvc.js:266-284`) POSTs `/list` — readdir + serial stat of every entry — against **all** of them, and `EncoreLoader.js:130-138` repeats that every 3 seconds while no library is configured (measured: 186 ms `si.fsSize()` + 231 ms sweep ≈ 0.4 s of main-process fs work every 3 s, unbounded if the NAS is asleep).
  ```js
  if (process.platform === "darwin") {
    mountPoints = mountPoints.filter(
      (m) => m === "/" ||
        (m.startsWith("/Volumes/") &&
         !m.startsWith("/Volumes/.timemachine/") &&
         !m.startsWith("/Volumes/com.apple.TimeMachine.localsnapshots/")),
    );
  }
  ```
  Share the filter between both sites — filtering `/drives` is what actually fixes `findEncoreLibraries`. Do **not** filter on `d.rw === false` (`/` reports `rw:false`). De-dup by `d.fs` device node to collapse `/` and `/System/Volumes/Data`. Make `main.js:1542`'s synchronous `fs.existsSync` an `await fs.promises.access(...)` behind a `Promise.race` timeout so a stalled SMB mount can't freeze the main process, the Express server and every phone remote. Prune `knownLibraries` on load (`main.js:1545,1550` only ever append). Back off the 3-second `EncoreLoader` poll.
  Note: the "duplicate libraries via Time Machine snapshots" scenario did **not** reproduce — those mounts contain `backup_manifest.plist`, not a Data mirror, and `/` is a sealed read-only volume. Sell this as main-thread latency + correctness, not de-duplication.

- [ ] **1.20 Parallelize the `/list` stat loop (`main.js:321-336`).** One awaited `fs.promises.stat` per iteration, and it runs before the cache-signature comparison (`FsSvc.js:348` precedes `:370`), so the full serial walk is paid on every launch even on a cache hit. 0.11 ms/file local; 1-3 ms/file over SMB/USB 2.0 = 5-15 s for a 5,000-song library. Chunk at 64 with `Promise.all`. Keep `withFileTypes` for **names only** and keep `s.isFile()` from the stat — `d.isFile()` is false for symlinks whereas `fs.stat` follows them, and a symlinked song would flip to "folder" and vanish from `processableFiles` (`FsSvc.js:497`). Drop the `created` field entirely (produced at `main.js:329`, consumed nowhere).

- [ ] **1.21 Errno plumbing for TCC denials (`main.js:311-319`, `:332-334`; `FsSvc.js:255-259`, `:348-352`; `SetupManager.js:1187`).** Every failure collapses to "Invalid directory" / "Read error" / a single `FAILED TO BUILD SONG LIST` toast, and per-entry `stat` failures are silently swallowed — so a partially-denied volume yields a library quietly missing songs with zero indication. Return `403 + err.code`, count skipped entries (`{skipped, skippedReason}`), return `{error, code}` instead of `null`, and render a distinct EPERM/EACCES message with `shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")` (note: `Privacy_Files` is not a real anchor).

**Phase 1 exit test:** build on a clean Mac, download the DMG through Safari (so it carries `com.apple.quarantine`), drag to /Applications, launch. No Gatekeeper dialog, no firewall prompt on second launch, correct icon in Dock, mic prompt says "Encore Karaoke", an all-caps CDG library on a USB stick loads with the right song count and no `._` entries.

---

## Phase 2 — Make it feel native (~2-3 days)

- [ ] **2.1 Build an application `Menu` (`main.js:5`).** `Menu` isn't even imported; `grep -n Menu main.js` yields only `autoHideMenuBar` (a no-op on darwin) and the string `"Main Menu"`. macOS therefore gets Electron's default menu, whose NSMenu key equivalents are dispatched **before** `before-input-event` — defeating every guard in the app. Verified against the Electron 43 default macOS menu:
  - `Cmd+Alt+I` opens DevTools even when `isDev` is false (`main.js:557-564` only tests `input.control && input.shift`). Verified: the role targets the focused webContents, which is the **appView** — full app DevTools in production.
  - `Shift+Cmd+R` force-reloads the karaoke app mid-song, bypassing the kiosk guard at `main.js:504-506` (the `globalShortcut` block at `:510-515` only grabs plain Cmd+R).
  - `Ctrl+Cmd+F` bypasses the `!kioskEnabled` fullscreen guard at `main.js:570-575`.
  - `Cmd+M` makes the karaoke display vanish mid-song.
  Build the menu inside `app.whenReady()` before `createWindow()`. Wire View items to the existing `addZoom`/`reduceZoom`/`resetZoom` helpers (they already target `appView`); if you keep a DevTools item use `appViewWebContents.toggleDevTools()` rather than `role: "toggleDevTools"`. Omitting `role: "close"` kills Cmd+W. Delete the `globalShortcut` block at `main.js:510-524` — it grabs Cmd+R system-wide while focused.

- [ ] **2.2 `app.setAboutPanelOptions` (`main.js:58`).** Depends on 2.1 (the `appMenu` role's About item). `versionInformation = { number: "1.10.0", channel: "RELEASE", codename: "Virgo" }` is only surfaced over IPC (`main.js:694`) and in the window title (`:430`). Correction to the original finding: packaged builds already report the right name/version (packager rewrites the plist from `packagerConfig.name` + `package.json` version) — the "shows Electron's version" symptom is `npm start` only. This adds channel + codename + copyright.

- [ ] **2.3 Dock integration (`main.js:593`).** `grep 'app.dock'` → nothing. Depends on 2.1 (`setMenu` takes a `Menu`). Badge the queue depth, `bounce("informational")` when a phone queues a song (hook `main.js:1822-1825`'s `execute-command` fan-out; note no `queue-changed` IPC exists yet, so this needs new emit sites in `SessionManager`), and a Dock menu mirroring `titlebar.html:248-252` (LIB/BGV/SEARCH/MIXER/REC). Guard on `process.platform === "darwin" && app.dock`.

- [ ] **2.4 MediaSession action handlers (`PlaybackManager.js:169-174`, `SessionManager.js:194-199`).** The app publishes `MediaMetadata`, which opts it into Chromium's media session and therefore MPRemoteCommandCenter — but `grep 'setActionHandler|playbackState'` returns nothing. So a keyboard play/pause key, AirPods, a BT speaker or a TV remote pauses `this.audioElement` directly, behind `pauseTrack()`'s back. `state.playback.status` stays `"playing"`: Meyda + pitch scoring keep sampling a silent room, `timingLoop()` keeps spinning, and because the end-of-song check is `engineTime >= duration` and `engineTime` is frozen, `stopTrack()` is **never** reached — the session hangs on that song until someone hits play.
  ```js
  navigator.mediaSession.setActionHandler("play",  () => root.playback.togglePause());
  navigator.mediaSession.setActionHandler("pause", () => root.playback.togglePause());
  navigator.mediaSession.setActionHandler("stop",  () => Forte.stopTrack());
  navigator.mediaSession.setActionHandler("nexttrack", () => SessionsSvc.skipCurrentSong());
  navigator.mediaSession.setActionHandler("seekto", null);
  ```
  `togglePause()` is `PlaybackManager.js:385` (preferred over raw `Forte` calls — it also syncs `mvPlayer` and the info bar); skip is `Sessions.js:379`. `Forte.resumeTrack()` and `root.playback.skipSong()` do **not** exist. Set `navigator.mediaSession.playbackState` in `pauseTrack()`/`stopTrack()`. Highest-value piece: a belt-and-braces `audioElement.addEventListener("pause", …)` reconciler near `Playback.js:1095` — it's the only thing that catches the frozen-forever case.

- [ ] **2.5 Persist window bounds + target display (`main.js:429-443`).** Fullscreen **is** persisted and replayed (`Config.setItem("fullscreenEnabled")` at `:481/:487`, `win.setFullScreen(true)` at `:494-496`) but position is not, and `screen` is never imported. On a Mac + TV rig the window opens centered on the primary display and immediately goes fullscreen there, every launch. Require `screen` at top level but only call `getAllDisplays()` inside `createWindow()` (it runs from the `serverHttp` listening callback, after ready). Apply saved bounds **before** the `setFullScreen(true)` at `:494`, then re-run `updateBounds()` — otherwise the WebContentsView geometry is computed pre-move. Store a `targetDisplayId` in SetupManager's Video Settings, matched against `display.id`, falling back to primary.

- [ ] **2.6 Platform-aware key hints (`UIManager.js:51`, `main.js:549-576`).** The toast literally says "Press F11 to exit fullscreen." On a Mac F11 is Volume Down by default and Show Desktop with standard function keys enabled — so the instruction actively drops system volume mid-song. `grep 'metaKey|ctrlKey' src/` → zero; the only platform plumbing is the `?platform=` query param at `titlebar.html:347`. Plumb platform through the preload bridge; hint text should be **"Press ⌃⌘F to exit fullscreen."** (not Esc — Esc does not exit native macOS fullscreen). Fix the DevTools chord check to `input.meta && input.alt && "i"` on darwin. Skip the `isMac && input.meta && "q"` branch — the menu's quit role consumes Cmd+Q first. Implement Ctrl+Cmd+F as a menu accelerator (2.1), not in `before-input-event`.

- [ ] **2.7 Kiosk window level and Spaces (`main.js:527-529`).** `setAlwaysOnTop(true)` with no level defaults to `"floating"` (NSFloatingWindowLevel), **below** notification banners, the screensaver and Control Center. On darwin, before `win.setKiosk(true)`:
  ```js
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  ```
  Do **not** swap `setKiosk` for `setSimpleFullScreen` — Electron's macOS `SetKiosk` installs `NSApplicationPresentationHideDock | HideMenuBar | DisableProcessSwitching`; simple fullscreen only auto-hides dock+menubar and would silently re-enable Cmd+Tab. Kiosk is gated on `--kiosk` in argv (`main.js:64`), which a Finder-launched Mac user effectively can't set, so this is a niche path.

- [ ] **2.8 Record to MP4 (`Recorder.js:318-330`, `:401-409`; `main.js:790`, `:843`).** Verified in *this* repo's Electron (43.0.0 / Chromium 150): `MediaRecorder.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')` → `true`. The app already encodes H.264 (`video/webm; codecs=h264,opus` is supported and selected first) — it's the WebM/Matroska container alone that AVFoundation can't demux, so `~/Movies/Encore Recordings/…/Mix-Video.webm` won't open in QuickTime, Quick Look, Photos, or AirDrop-to-iPhone. Put the MP4 mime first in `videoMimes` (`isTypeSupported` guards the fallthrough), add `videoMime: this.mediaRecorder.mimeType` to the `save-recording` payload (currently only `{videoBuffer, micBuffer, musicBuffer, songTitle}`), derive the extension in `main.js:829-845`, and make `main.js:790` glob `Mix-Video.*` so existing `.webm` sessions keep resolving. Chrome's MediaRecorder MP4 is fragmented MP4 — verify a sample actually opens in QuickTime/Photos before shipping. Drop the VP8-hardware-encoder argument; it doesn't apply.

- [ ] **2.9 Unicode-safe recording folder names (`main.js:834`).** `(songTitle || "Session").replace(/[^a-z0-9]/gi, "_")` turns `だんご大家族` into `______` and `Café Señor` into `Caf__Se_or` — and that string is the **user-visible title** (`main.js:794-798` → `RecordingsManager.js:299-300`). APFS/HFS+ only need `/` and NUL handled. Use `NFC` + `[\/:\x00-\x1f]` + a leading-dot guard, gate the stricter Windows scrub on `process.platform === "win32"`, and truncate with `Array.from(s).slice(0, 120).join("")` so emoji surrogate pairs don't split. Better long-term: write a `session.json` with the real title — `main.js:790-798` currently has no source of truth other than the directory name.

- [ ] **2.10 System volume via `loudness` (`main.js:729`, `:777`; `PlaybackManager.js:181-186`, `:462`; `InputManager.js:1016`).** `loudness` shells out to `osascript`; measured on this Mac: **getVolume 284 ms, setVolume 260 ms** — 2-5x worse than the finding claimed, fired per volume keypress with no debounce, so key-repeat queues hundreds of ms of process spawns and the readback races. It also no-ops on HDMI/DisplayPort output (no software volume on macOS), so the on-screen percentage lies on exactly the stated deployment. Order: (a) debounce to ~150 ms and coalesce to the last value; (b) restore the user's system volume in the existing `before-quit` at `main.js:1880`; (c) for the YouTube path specifically — the only branch that touches system volume — use the iframe/YT player volume instead. Everything else already routes through `audioCore.setTrackVolume()`. No `NSAppleEventsUsageDescription` needed: `set volume` is a Standard Additions command executed in-process against CoreAudio, not an Apple Event to another app.

- [ ] **2.11 Library manifest title (`main.js:1566-1577`).** `path.basename(path.dirname(folderPath))` climbs one level too far because a trailing `/` was appended at `:1567`, so a library at `/Volumes/KARAOKE/` is titled **"Volumes (Custom Library)"** — every USB drive gets the same name, and it's written to `manifest.json` on disk so it travels with the drive. Derive the name from `result.filePaths[0]` *before* appending the slash. (User-recoverable via `library-manager.html:553`'s editable title field, hence low.)

- [ ] **2.12 Watch `/Volumes` (`FsSvc.js:322`).** No `fs.watch|watchFile|chokidar` anywhere. `state.songList` holds absolute `/Volumes/KARAOKE/...` paths (`FsSvc.js:398`, `:762`); eject mid-session turns every play into a bare `400 "Invalid file"` (`main.js:352-354`) with no explanation, and replugging does nothing until the user manually rescans. Verified on this machine: `fs.watch("/Volumes")` fires `rename:HFSTEST` on detach (FSEvents reports `rename` in both directions, so re-check existence). Subscribe in `FsSvc` `start()` (`FsSvc.js:134`), `persistent: true` with an explicit `w.close()` in `before-quit`, and use `fs.promises.access` behind a ~2 s `Promise.race` inside the debounce — **not** `existsSync`, which would block the main process if the volume is the SMB mount that just stalled.

- [ ] **2.13 Squirrel.Mac auto-update.** Depends on 1.4 — Squirrel.Mac requires a real, team-matching signature. `Updates.js:1` is a plain JSON poll (`versioning.encorekaraoke.org/versionInfo`) whose only consumer is a toast at `EncoreHome.js:293-301`; `grep autoUpdater` → nothing, while `Squirrel.framework` ships unused. `MakerZIP` already writes the `RELEASES.json` manifest when given `macUpdateManifestBaseUrl`:
  ```js
  { name: "@electron-forge/maker-zip", platforms: ["darwin"],
    config: { macUpdateManifestBaseUrl: `https://versioning.encorekaraoke.org/updates/darwin/${process.env.BUILD_ARCH}` } }
  ```
  Use a template literal (the original snippet used single quotes — a literal `${process.arch}` string) and an explicit env var per matrix leg, since `process.arch` is the **build host's** arch and wrong under cross-arch CI. Runtime: `autoUpdater.setFeedURL({ url, serverType: "json" })` + `checkForUpdates()`. Drop the "Squirrel.Mac refuses http" claim — the template plist sets `NSAllowsArbitraryLoads: true`; use HTTPS because you should.

---

## Phase 3 — Make it fast (~1-2 days)

- [ ] **3.1 Delete `sampleRate: 44100` (`AudioCore.js:26`).** `system_profiler SPAudioDataType` on this Mac: **every** device — including all three HDMI outputs and the USB input — reports Current SampleRate 48000. Pinning 44100 forces a Chromium resampler on both ends of the graph, adds output latency (which then has to be dialled out in the calibration wizard at `SetupManager.js:1638+`), and defeats `latencyHint: "interactive"` because the graph can't take the hardware buffer size when rates disagree. Verified safe: `AudioCore.js:26` is the **only** rate constant in app code — `Scoring.js:143` reads `context.sampleRate`, `Recorder.js:11` reads `audioBuffer.sampleRate`, both worklets contain no rate constant, and `Mixer.js:485` / `Recorder.js:79` / `SetupManager.js:1408` already create contexts with no override. If you want a Windows-only pin, gate it. Log the achieved rate next to the existing `baseLatency` logging at `AudioCore.js:121-127`, and read `outputLatency` only after the first `resume()` (it's 0 before rendering starts).

- [ ] **3.2 Fix the lounge idle loop (`UIManager.js:1590-1641`).** `const w = canvas.width, h = canvas.height` reads **physical** pixels, but `BGVPlayer.js:154-159` has already applied `scale(dpr, dpr)` to that context — and `BGVPlayer.js:353-355`'s own `_renderImageFrame` divides by dpr, proving the intended pattern. On any Retina Mac the gradient stretches over 2x the height, the sine polyline runs 2x the segments, and ~75% of the 50 particles are positioned off-screen. Fix: `const dpr = window.devicePixelRatio || 1; const w = canvas.width / dpr, h = canvas.height / dpr;`. Convert the per-frame constants to per-second (`time += 0.02` → 1.2/s, `p.y -= p.speedY * 0.005` → 0.3/s) so it doesn't run double-speed on ProMotion and 5/6 speed on a 50 Hz TV. Hoist the per-frame `createLinearGradient` into a local rebuilt on `h` change. And make the `selectedCategory === "Off"` branch at `:1598-1602` **stop** the loop instead of re-arming rAF — this is the idle screen, and it currently holds a core plus GPU at full rAF rate indefinitely.

- [ ] **3.3 Cap the recorder composite at 30 fps (`Recorder.js:628`).** `captureStream(30)` (`:306`, and a second path at `:514`) samples 30, but the ~8-blit 1280x720 pipeline (`:627-861`) runs at display refresh — 75% waste on a 120 Hz panel. Gate on `performance.now()` with a `1000/30` threshold right after the `isRecording` guard. **Paired, non-optional:** replace the `* 0.15` lerps at `:666` and `:716` with `const k = 1 - Math.pow(1 - 0.15, dt * 60)`, or the BGV/lyric crossfades drop to 1/4 speed once the loop is capped. Confirm both capture paths feed the same `drawFrame`. (Drop the "wasted frames cost GPU readback" claim — with an explicit `frameRate` argument Blink only requests a frame when the rate timer fires.)

- [ ] **3.4 Cap the lyrics loop at 60 fps (`LyricsEngine.js:1108`).** 15.5 ms threshold at the top of `drawLyricsFrame`. Skip the "pre-merge the dim layers" half: `globalAlpha` differs per line while `fadeProgress < 1.0` (`:1166`), so flattening is only valid in the steady state. Bounded target (the lyrics strip, not a full 1080p surface), so this is a cheap win, not a rescue.

- [ ] **3.5 Replace the CDG `ImageBitmap` churn with a scratch canvas (`PlaybackManager.js:308-351`).** Keep one 300x216 canvas, `putImageData(frame.imageData, 0, 0)`, `drawImage` that — removes the async round-trip, the ordering hazard and the `close()` bookkeeping in one move. Also cap the loop at 30 Hz (it currently re-arms rAF uncapped at `:310`, up to 120 Hz for a surface that meaningfully changes ~30x/sec). If you keep the bitmap path, add `if (this.currentCdgBitmap) this.currentCdgBitmap.close();` at `:447`. Justification is wasted work + GC churn — `createImageBitmap` from an `ImageData` source produces a CPU-backed `StaticBitmapImage`, ~260 KB, GC-reclaimed; it is not a GPU/WindowServer leak.

- [ ] **3.6 Lazy-init kuroshiro (`main.js:31-32`, `:168-169`).** `kuroshiro.init(new KuromojiAnalyzer())` runs at require time, before `app.whenReady()`, on every launch regardless of library content — inflating 17 MB of gzipped dict (`du -sh node_modules/kuromoji/dict`) and building the double-array trie on the main-process event loop, competing with express startup and window creation. Memoize behind a `getKuroshiro()` promise used by the `romanize` handler at `main.js:736`, and move the two `require`s inside it so the module graph isn't even walked. Optionally warm it after the library scan finds a title matching the existing `kanaRegex`/`hanIdeographsRegex` (`main.js:41-43`).

- [ ] **3.7 Close the mixer's second AudioContext (`Mixer.js:484-508`, `:552-554`).** `_stopMeters()` is only `cancelAnimationFrame` — `meterCtx` is never suspended or closed (grep: hits only at `:484-487`, `:497`, `:502`), so after the user opens the mixer once, CoreAudio keeps an IOProc alive for a graph producing no sound for the rest of the process. Minimal fix: `suspend()` in `_stopMeters` (called from `Mixer.js:95`) and `close()` + `this.meterCtx = null` on teardown; the `if (!this.meterCtx)` guard at `:484` handles re-creation. Do **not** reuse `state.scoring.musicAnalyser` — `AudioCore.js:113-118` feeds it exclusively from `state.playback.midiGain`, so the music meter would go dead for every MP3/CDG song. `Recorder.js:79-83` is the correct pattern already present in the codebase.

- [ ] **3.8 Gate the `--low-latency` switches (`main.js:583-591`).** Verified by `strings` on the Electron 43 macOS framework: `audio-buffer-size` **present**, `enable-exclusive-audio` **absent**, `alsa-output-buffer-size` **absent**. Keep `audio-buffer-size` on all platforms — Chromium's `AudioManagerMac` does honour it — and gate the other two on `win32`/`linux`. Correct the warning text: on macOS 256 frames may be below the device IO buffer and can cause dropouts on E-cores; it is not a no-op. Do not add `ignore-gpu-blocklist`/`disable-gpu`.

- [ ] **3.9 Pitch-shifter LUT (`pitch-shifter-processor.js:38-65`).** Two `Math.cos` per sample (~96k/s) on the audio render thread for a Hann window that's a pure function of a linearly-advancing phase. Build a 2048-entry table in the constructor (`:8-18`); `phase` is normalized to [0,1) by the modulo at `:64` so `(this.phase * this.WIN) | 0` is safe. Hoist the two `Math.floor(offset*)` calls above the `for (let c)` loop at `:50` — they're channel-independent. This node is in the live graph (`AudioCore.js:86-95`) and the module is actually loaded (`AudioCore.js:34`). Realistically ~0.3% of a core — do it because it's free, not because it fixes crackle.

- [ ] **3.10 Static backdrop under the mixer modal (`style.css:4035-4039`).** A full-viewport `backdrop-filter: blur(15px)` over a live compositor video layer (`BGVPlayer.js:29` sets `translateZ(0)`) can't be cached and re-runs a two-pass blur every frame — and the mixer is the one modal users open *during* a song. Call `this.ctx.modules.bgv.setCanvasOnlyMode(true)` on open (`Mixer.js:82-96`) and restore on close; the method exists at `BGVPlayer.js:696` and already pauses the video engine, making the backdrop static and cacheable. Leave `.modal-container` (`style.css:901`) alone — it's used only by `EncoreLoader.js:51`, the startup library picker, with no video behind it. `.recordings-modal` (`:2202`) and `.mixer-modal` are `opacity: 0` when hidden and Blink skips painting them, so there's no steady-state cost. `@media (prefers-reduced-transparency)` is a cheap accessibility win — keep it, but it's polish.

- [ ] **3.11 Build hygiene: clean `dist/` and stop shipping fonts twice.**
  - `build.js` has no clean step (grep for `rmSync|rimraf` → nothing). Right now `find dist -name "*.map" | wc -l` → **68**, 15 MB, including a 9.8 MB `dist/main.js.map` from an *earlier dev build* whose 841 `sourcesContent` entries reconstruct the full unminified main process. Also 56 `chunk-*.js` vs 28 `chunk-*.js.map` — ~28 orphaned esbuild chunks. Add an unconditional `fs.rmSync("dist", { recursive: true, force: true })` at the top of `build.js`; add `if (normalizedPath.endsWith(".map")) return true;` to the forge ignore as belt-and-braces.
  - `forge.config.js:23-29` keeps all 22 MB of `assets/fonts` inside `app.asar` **and** the same tree ships via `extraResource` (`platform.js:215-224` is an unfiltered `fs.copy`). Do **not** delete the special case — `main.js:498-500` and `main.js:1480` load `titlebar.html`/`library-manager.html` from `file://${__dirname}` (i.e. inside the asar) and both contain four `@font-face` rules with relative `url("static/assets/fonts/rajdhani-v17-latin-*.woff2")`. Narrow it instead:
    ```js
    if (normalizedPath.startsWith("/dist/resources/static/assets/fonts"))
      return !normalizedPath.endsWith(".woff2");
    ```
    Keep the two parent-directory `return false` lines (packager stops descending into an ignored directory). That leaves 62 KB in the asar instead of 22 MB — the NotoSansSC/KR/JP TTFs (23 MB) are read only by the pdfkit songbook path via `process.resourcesPath`. Verify with `npx asar list …/app.asar | grep fonts`, then **launch the packaged app and look at the titlebar**.

- [ ] **3.12 Drop `.avi` from the BGV whitelist (`main.js:280`).** Verified against the Electron 43 macOS framework: no `avi` demuxer string, no "AVI (Audio Video Interleaved)" long name — Chromium cannot demux it, so those files silently hit `BGVPlayer.js:513-517`'s `onerror` and get skipped. This is a Chromium ffmpeg config, i.e. cross-platform dead weight, not a macOS trait. `.mkv` *is* supported (`matroska`/`video/x-matroska` strings present) and depends on the contained codec. The genuine macOS item is VP9: no Apple Silicon generation has a VP9 hardware decoder, and AV1 hardware decode starts at M3 — so a user-supplied 1080p60 VP9 `.webm` background is sustained software decode. Don't add a `mediaCapabilities.decodingInfo` probe (it needs a concrete codec string you don't have from a directory listing); instead sample `v.getVideoPlaybackQuality().droppedVideoFrames` in the `onCanPlay` handler (`BGVPlayer.js:519`), or just document H.264/HEVC in MP4/MOV as the supported user-BGV format.

- [ ] **3.13 Normalize backslashes in manifest asset paths.** `UIManager.js:1471-1473` and `PlaybackManager.js:724-725` each carry an identical `joinPath` closure that concatenates without converting separators, while `FsSvc.js:394-397` and `main.js:1646` both do convert. `\` is a legal macOS filename character, so a hand-authored or Windows-era manifest silently yields a blank attract screen. Do the ingest half first (`main.js:1660-1677` and the manifest parse at `FsSvc.js:296-298`), then factor the two closures into one shared helper. Speculative input only — the app's own writers normalize.

---

## Concrete file changes

| File | Change | Why | Effort |
|---|---|---|---|
| `forge.config.js:7-42` | `appBundleId`, `appCategoryType`, `appCopyright`, `usageDescription`, `extendInfo`, `osxSign`, `osxNotarize`, `icon` → extensionless | B1, B2, TCC strings, local-network + volume declarations | M |
| `forge.config.js:23-29` | Narrow the fonts allowance to `.woff2` | 22 MB duplicated into `app.asar`; titlebar `@font-face` still needs the woff2 | Trivial |
| `forge.config.js:43` | `hooks.postPackage` → repair `CFBundleDisplayName` | `executableName` leaks into TCC dialogs | S |
| `forge.config.js:53-56` | Add `maker-dmg`; keep `maker-zip` (Squirrel.Mac feed) | Bare zip is the wrong delivery format | S |
| `build/entitlements.mac.plist` | **New.** audio-input, allow-jit, allow-unsigned-executable-memory, allow-dyld-env-vars | Hardened runtime is mandatory for notarization | Trivial |
| `src/icons/icon.icns` | **New**, from `icon.png` via `iconutil` | macOS can't consume the 4.3 KB `.ico` | S |
| `build.js:112` | Add `.icns` to the copy filter; `rmSync("dist")` at top | Ship the icns; stop leaking 15 MB of stale maps + orphan chunks | Trivial |
| `.github/workflows/macos-build.yml` | **New.** `macos-15`, matrix arm64/x64, keychain import, notarize | Only a macOS host can codesign/notarize/iconutil/hdiutil | M |
| `main.js:5` | Import `Menu`, `screen`, `powerSaveBlocker`, `powerMonitor`, `systemPreferences` | Prereqs for 2.1, 2.5, 1.15, 1.18 | Trivial |
| `main.js:31-32, 168-169, 736` | Lazy memoized kuroshiro | 17 MB dict inflated at require time on every launch | S |
| `main.js:242, 263-303, 367-385` | `loopbackOnly` middleware + CORS allowlist | B5 | S |
| `main.js:244-252` | `getLanAddress()` via `os.networkInterfaces()`; return `{primary, candidates}` | Default route ≠ LAN under Tailscale/multi-NIC | S |
| `main.js:266-273, 1530-1553` | Shared darwin mount filter; async `access` with timeout; prune `knownLibraries` | 30-mount sweep every 3 s on the main thread | S |
| `main.js:280` | Remove `.avi` | Chromium cannot demux it | Trivial |
| `main.js:291-336, 1607-1609` | Dotfile filter; chunked `Promise.all` stat; drop `created`; errno passthrough | B4 + serial stat latency + TCC diagnosis | S |
| `main.js:429-443, 481-496` | Persist/restore bounds + `targetDisplayId` before `setFullScreen` | Fullscreens on the wrong display every launch | M |
| `main.js:433, 1468` | Gate `.ico` on win32; `path.join(__dirname, …)` | cwd-relative path breaks everywhere | Trivial |
| `main.js:441 → 445` | Move `backgroundThrottling: false` to the appView | Flag is on the 55px titlebar, not the app | Trivial |
| `main.js:504-524, 549-576` | Delete `globalShortcut` block; darwin devtools chord | Menu accelerators pre-empt `before-input-event` | S |
| `main.js:527-529` | `setAlwaysOnTop(true,"screen-saver")` + `setVisibleOnAllWorkspaces` before `setKiosk` | Floating level sits under banners/screensaver | Trivial |
| `main.js:583-591` | Gate `enable-exclusive-audio`/`alsa-*` per platform | Absent from the macOS binary; misleading warning | Trivial |
| `main.js:593` | Menu, Dock, `powerSaveBlocker`, `powerMonitor`, Bonjour construction | All must be after `whenReady` | M |
| `main.js:604-606` | `reconnectionAttempts: Infinity`, `reconnectionDelayMax: 30000` | Relay dies permanently after a wake-time network gap | Trivial |
| `main.js:72-73, 108, 145, 1856-1869` | One browser, deferred, 30 s re-query, mdns warning hook, stable `linkId` | One-shot PTR query + prompt on a blank screen | S |
| `main.js:729, 777` | Debounce `setVolume`; restore on quit | 260-284 ms osascript spawn per keypress | S |
| `main.js:790, 843` | Glob `Mix-Video.*`; derive extension from mime | MP4 container swap | S |
| `main.js:834-837` | NFC + `[\/:\x00-\x1f]` scrub, surrogate-safe truncate | CJK titles become `______` | Trivial |
| `main.js:1566-1577` | Derive folder name before appending `/` | Every USB library titled "Volumes (Custom Library)" | Trivial |
| `main.js:1880` | mDNS goodbye, blocker release, volume restore, watcher close, re-entrancy guard | Only teardown hook in the file | S |
| `src/pkgs/services/FsSvc.js:494-561` | Lowercase ext + `byLower` Map + NFC + dotfile guard | B3, B4, cross-OS cache churn | S |
| `src/pkgs/services/FsSvc.js:134, 255-259, 322` | `/Volumes` watcher; return `{error, code}` not `null` | Eject/replug invisible; TCC denial looks like empty | M |
| `src/pkgs/services/Forte.js:78` | Move `initializeScoringEngine()` out of `start()` | Boot blocks on the TCC prompt; mic indicator always lit | S |
| `src/pkgs/services/modules/Microphone.js:73, 113-115` | `e.name` branch + Settings deep link; `ondevicechange`; label-based persistence | Every mic failure is currently a console line | S |
| `src/pkgs/services/modules/Playback.js:1095, 1318-1358` | `"pause"` reconciler; set `playbackState` | Media keys freeze the state machine forever | S |
| `src/pkgs/services/core/AudioCore.js:26` | Delete `sampleRate: 44100` | Every Mac device is 48 kHz; permanent resampler | Trivial |
| `src/pkgs/system/managers/PlaybackManager.js:169-174, 308-351, 724` | MediaSession handlers; CDG scratch canvas + 30 Hz; shared path join | Native transport + wasted frames | S |
| `src/pkgs/system/managers/SetupManager.js:169, 1187` | Re-enumerate after grant; distinct EPERM message | "Default"-only picker; opaque failure toast | S |
| `src/pkgs/system/managers/UIManager.js:51, 407-421, 907-927, 1471, 1590-1641` | ⌃⌘F hint; `refreshQRCode` on network change; delete duplicate QR; dpr/dt lounge fix | Wrong key hint, blank QR, Retina misdraw, idle burn | S |
| `src/pkgs/system/managers/LyricsEngine.js:1108` | 60 fps cap | Uncapped full-Retina blits at 120 Hz | Trivial |
| `src/pkgs/system/managers/NetworkManager.js:100` | `if (!ip \|\| ip === "0.0.0.0") throw` | Wildcard slips past the existing guard | Trivial |
| `src/modules/Recorder.js:318-330, 401-409, 628, 666, 716` | MP4 first; mime in payload; 30 fps gate; dt-based lerps | Unplayable output + 75% wasted composites | S |
| `src/modules/Mixer.js:82-96, 552-554` | `setCanvasOnlyMode` around the modal; `suspend()`/`close()` `meterCtx` | Uncacheable blur over live video; leaked CoreAudio client | S |
| `src/libs/pitch-shifter-processor.js:8-18, 38-65` | Hann LUT; hoist `Math.floor` | Transcendentals on the audio render thread | Trivial |
| `src/style.css:4035-4039` | `prefers-reduced-transparency` fallback | Accessibility + cheap | Trivial |
| `src/libs/worklet_processor.js` | **Delete** (dead: no importers; imports a nonexistent `./worklet_url.js`) | Removes a decoy hot path | Trivial |

---

## Ready-to-paste configs

### `forge.config.js` — macOS additions

Only the changed/added keys are shown; splice into the existing object. Verified against `@electron/packager` 18.4.4 (`mac.js` getters) and Forge 7.11.

```js
const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const path = require("path");
const fs = require("fs");

// Sign only when the environment supplies an identity, so `npm run package`
// still works unsigned on a dev machine.
const signing = process.env.APPLE_SIGNING_IDENTITY
  ? {
      osxSign: {
        identity: process.env.APPLE_SIGNING_IDENTITY,
        // packager defaults this to true; leaving it true means a signing
        // failure degrades to a WARNING and you ship an unsigned app.
        continueOnError: false,
        optionsForFile: () => ({
          entitlements: "build/entitlements.mac.plist",
          hardenedRuntime: true, // @electron/osx-sign v1 defaults this true; explicit for clarity
        }),
      },
      ...(process.env.APPLE_ID && {
        osxNotarize: {
          appleId: process.env.APPLE_ID,
          appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
          teamId: process.env.APPLE_TEAM_ID,
        },
      }),
    }
  : {};

module.exports = {
  packagerConfig: {
    asar: true,
    name: "Encore Karaoke",

    // --- macOS identity ---------------------------------------------------
    appBundleId: "org.encorekaraoke.desktop",
    appCategoryType: "public.app-category.music",
    appCopyright: "Copyright © 2026 Encore Karaoke Labs", // check LICENSE.txt before committing
    // Extensionless: packager appends .icns on darwin, .ico on win32, .png on linux.
    icon: "dist/resources/icon",

    // --- TCC prompt copy (packager writes NS<Type>UsageDescription into the
    //     app plist AND every helper plist) ---------------------------------
    usageDescription: {
      Microphone:
        "Encore Karaoke uses your microphone to score your singing and record your performances.",
      Camera:
        "Encore Karaoke shows a camera feed from paired phones during a session.",
      AudioCapture:
        "Encore Karaoke captures audio so it can mix and record your performance.",
      BluetoothAlways:
        "Encore Karaoke connects to Bluetooth microphones and speakers.",
    },

    // --- Extra Info.plist keys. Do NOT put CFBundleIdentifier or
    //     LSApplicationCategoryType here; packager writes those from
    //     appBundleId / appCategoryType and duplicates can conflict. --------
    extendInfo: {
      NSLocalNetworkUsageDescription:
        "Encore Karaoke uses your local network so phones on the same Wi-Fi can act as remote controls and to find Encore song-update servers.",
      // Declaration hygiene per Apple TN3179. bonjour-service does raw 5353
      // multicast rather than dns-sd, so this is very likely inert on macOS —
      // it does not unblock discovery. Keep it in sync with SVC_LINK/SVC_UPDATE.
      NSBonjourServices: ["_enmoku._tcp", "_encore-server._tcp"],
      NSRemovableVolumesUsageDescription:
        "Encore Karaoke reads your karaoke library from external drives.",
      NSNetworkVolumesUsageDescription:
        "Encore Karaoke reads your karaoke library from network shares.",
    },

    ...signing,

    extraResource: ["dist/resources/static", "dist/resources/icon.png"],
    linux: { target: "deb" },
    ignore: (file) => {
      /* unchanged, except: narrow the fonts clause */
      // if (normalizedPath.startsWith("/dist/resources/static/assets/fonts"))
      //   return !normalizedPath.endsWith(".woff2");
      // and add: if (normalizedPath.endsWith(".map")) return true;
    },
    executableName: "encore-karaoke", // win32/linux binary name; see postPackage below
  },

  hooks: {
    // packager writes CFBundleDisplayName from executableName (platform.js:55
    // -> mac.js:183), and updatePlist runs AFTER extendInfo — so this must be
    // repaired post-package. postPackage runs before the makers and before
    // signing, which is what we need.
    postPackage: async (_forgeConfig, options) => {
      if (options.platform !== "darwin") return;
      const plist = require("plist"); // transitive via @electron/packager; add to devDependencies to be safe
      for (const out of options.outputPaths) {
        const p = path.join(out, "Encore Karaoke.app", "Contents", "Info.plist");
        const info = plist.parse(fs.readFileSync(p, "utf8"));
        info.CFBundleDisplayName = "Encore Karaoke";
        fs.writeFileSync(p, plist.build(info));
      }
      // Do NOT rename Contents/MacOS/encore-karaoke — CFBundleExecutable must match it.
    },
  },

  rebuildConfig: {},

  makers: [
    { name: "@electron-forge/maker-squirrel", config: { authors: "Encore Karaoke Labs", description: "Encore Karaoke app" } },
    {
      // Keep the zip: Squirrel.Mac feeds on it. macUpdateManifestBaseUrl makes
      // MakerZIP emit RELEASES.json. BUILD_ARCH must be set per CI matrix leg —
      // process.arch here is the BUILD HOST's arch, wrong under cross-arch CI.
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
      config: process.env.BUILD_ARCH
        ? { macUpdateManifestBaseUrl: `https://versioning.encorekaraoke.org/updates/darwin/${process.env.BUILD_ARCH}` }
        : {},
    },
    {
      // npm i -D @electron-forge/maker-dmg  (darwin hosts only)
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {
        name: "Encore Karaoke",
        icon: "dist/resources/icon.icns", // must exist — the maker throws otherwise
        format: "ULFO",
      },
    },
    { name: "@electron-forge/maker-deb", config: { authors: "Encore Karaoke Labs", description: "Encore Karaoke for Linux", name: "Encore", category: "Games" } },
  ],

  plugins: [ /* unchanged — keep the fuses exactly as they are */ ],
};
```

**Arch:** there is no `arch` key in `packagerConfig` today and you should not add one — Forge overrides packager's `arch`/`platform`/`dir`/`out`. Select it on the CLI: `npm run make -- --arch=arm64` (npm appends the flag to the `electron-forge make` at the end of the script chain). `--arch=universal` also works (zero native modules → byte-identical asars, no `mergeASARs`/`x64ArchFiles` needed, and `universal.js:32` still packages each slice with its real arch so the fuse plugin behaves) — but it doubles a 276 MB Electron payload on top of 158 MB of resources and doubles notarization time. Two artifacts is the better call.

**Fuses operational rule:** with `EnableEmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar` on, **never** mutate `Contents/Resources/app.asar` after packaging — no post-build patch step, no `asar pack` in CI, no manual edits before notarization. The header hash lives in Info.plist and a mismatch is an opaque boot failure. The `postPackage` hook above only touches Info.plist, which is fine.

### `build/entitlements.mac.plist`

`@electron/osx-sign`'s built-in `default.darwin.plist` would also work (it grants allow-jit, audio-input, bluetooth, camera, print, usb, location) — this one is the minimal set this app actually uses.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.device.audio-input</key><true/>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
</dict>
</plist>
```

Deliberately **not** included:
- `com.apple.security.cs.disable-library-validation` — governs loading unsigned dylibs, not `spawn()`. `find node_modules -name binding.gyp` returns nothing; pdfkit, systeminformation, loudness (which shells out to `osascript`), kuroshiro and electron-squirrel-startup are all pure JS. Add it back only if a `.node` is introduced.
- App Sandbox network keys (`com.apple.security.network.server/client`) — this app is not sandboxed; they do nothing outside the sandbox.
- `com.apple.security.device.camera` — the Electron process never captures; `Camera.js:20-58` only answers a PeerJS call. Add it if that changes.

### `.github/workflows/macos-build.yml`

```yaml
name: macOS Build

on:
  workflow_dispatch:
  push:
    tags: ["v*"]

jobs:
  build:
    runs-on: macos-15
    strategy:
      fail-fast: false
      matrix:
        arch: [arm64, x64]
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - run: npm ci

      - name: Generate icon.icns
        run: |
          mkdir -p /tmp/icon.iconset
          for s in 16 32 128 256 512; do
            sips -z $s $s   src/icons/icon.png --out /tmp/icon.iconset/icon_${s}x${s}.png
            sips -z $((s*2)) $((s*2)) src/icons/icon.png --out /tmp/icon.iconset/icon_${s}x${s}@2x.png
          done
          iconutil -c icns /tmp/icon.iconset -o src/icons/icon.icns

      - name: Import Developer ID certificate
        env:
          APPLE_CERT_P12: ${{ secrets.APPLE_CERT_P12 }}          # base64 of the .p12
          APPLE_CERT_PASSWORD: ${{ secrets.APPLE_CERT_PASSWORD }}
          KEYCHAIN_PASSWORD: ${{ secrets.KEYCHAIN_PASSWORD }}
        run: |
          security create-keychain -p "$KEYCHAIN_PASSWORD" build.keychain
          security default-keychain -s build.keychain
          security unlock-keychain -p "$KEYCHAIN_PASSWORD" build.keychain
          # without list-keychains, codesign may not search the new keychain
          security list-keychains -d user -s build.keychain login.keychain-db
          # keep it unlocked through notarization
          security set-keychain-settings -t 3600 -u build.keychain
          echo "$APPLE_CERT_P12" | base64 --decode > /tmp/cert.p12
          security import /tmp/cert.p12 -k build.keychain -P "$APPLE_CERT_PASSWORD" -T /usr/bin/codesign
          security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" build.keychain
          rm -f /tmp/cert.p12

      - name: Make
        env:
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}  # "Developer ID Application: … (TEAMID)"
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          BUILD_ARCH: ${{ matrix.arch }}
        run: npm run make -- --arch=${{ matrix.arch }}

      - uses: actions/upload-artifact@v4
        with:
          name: encore-macos-${{ matrix.arch }}
          # @actions/glob does NOT support brace expansion — *.{dmg,zip} matches nothing.
          path: |
            out/make/**/*.dmg
            out/make/**/*.zip
```

Notes: `macos-15` runners are arm64; the `x64` leg cross-packages, which is safe here only because there are zero native modules. Verify the result with `spctl -a -vvv -t install "out/…/Encore Karaoke.app"` and `xcrun stapler validate` on the DMG.

---

## Deferred / not worth it

| Item | Why |
|---|---|
| `protocols: [{ name, schemes: ["encore"] }]` (`forge.config.js:7`) | No `encore://` feature exists — nothing produces or consumes one. Decide the scheme in the same release as `appBundleId` **if** you ever build deep links; Launch Services caches the registration per bundle id. |
| Pinning the mDNS interface via `new Bonjour({ interface })` (`main.js:72`) | The awdl0/llw0 premise is false — both have IPv6-only addresses on a real Mac, so `allInterfaces()` never joins them, and no join errors occur in practice. Worse, `interface` also drives `socket.bind()`, and binding 5353 to a unicast address stops the socket receiving multicast. Only attempt with `bind: "0.0.0.0"` explicitly, and only after 1.11/1.17. |
| `setSimpleFullScreen` in place of `setKiosk` (`main.js:527`) | Trades Electron's hardened `NSApplicationPresentationOptions` (hide dock+menubar, disable process switching / force quit) for a mode where Cmd+Tab still works, and drags in `isFullScreen()`/`enter-full-screen` fixes at `main.js:458`, `:570-575`, `:696-712`. |
| Patching `src/libs/worklet_processor.js:645` allocations | Dead file: no importers, and it imports a nonexistent `./worklet_url.js`. The live worklet is `spessasynth_lib/dist/spessasynth_processor.min.js`, and this app never enables `oneOutputMode`, so the real cost is ~375 small array allocations/sec — upstream hygiene at most. Delete the file instead. |
| `backdrop-filter` on `.modal-container` (`style.css:901`) | Used only by `EncoreLoader.js:51`, the startup library picker — no video behind it, runs once. |
| Self-hosted PeerJS broker (`Camera.js:28`, `Sessions.js:41-60`) | Legitimate — an app whose description says "Runs offline" silently depends on `0.peerjs.com:443` plus Google STUN — but it is cross-platform architecture work, not macOS optimization. Track separately. Note the macOS half of that finding is weak: this app calls `getUserMedia` and has no `setPermissionRequestHandler`, so Chromium emits real host candidates rather than `.local` mDNS ones. |
| `.local` hostname in the QR (`main.js:1861`) | Nice idea (iOS resolves it natively, sidesteps interface selection entirely) but `os.hostname()` ≠ the Bonjour name — read `scutil --get LocalHostName` — and Android `.local` support is unreliable. Additive fallback text only, and only after testing on a real Android phone. |
| `session.setPermissionRequestHandler` (`main.js:593`) | Electron currently auto-grants everything to `http://127.0.0.1:<PORT>`, which is fine for the mic but also silently grants geolocation/notifications/midi-sysex. Worth adding eventually (with `setPermissionCheckHandler` — most web APIs check before requesting), but it fixes nothing user-visible today. |
| `await askForMediaAccess()` in `app.whenReady()` before `createWindow()` | Reproduces the exact "naked system alert from an app you just double-clicked" problem this plan fixes elsewhere. Read `getMediaAccessStatus()` non-blocking at ready, expose it over the preload bridge, and let the renderer trigger the prompt when scoring is first enabled (see 1.12/1.13). |
