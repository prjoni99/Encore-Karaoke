const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const path = require("path");
const fs = require("fs");

const APP_NAME = "Encore Karaoke";

// Sign only when the environment supplies an identity, so `npm run package`
// still produces a working unsigned build on a dev machine with no certs.
const signing = process.env.APPLE_SIGNING_IDENTITY
  ? {
      osxSign: {
        identity: process.env.APPLE_SIGNING_IDENTITY,
        // packager defaults this to true, which downgrades a signing failure
        // to a warning -- you ship an unsigned app believing it succeeded.
        continueOnError: false,
        optionsForFile: () => ({
          entitlements: "build/entitlements.mac.plist",
          hardenedRuntime: true,
        }),
      },
      // Notarization is separately gated: signing alone is useful locally,
      // notarizing requires credentials and a network round-trip to Apple.
      //
      // Preferred: a notarytool keychain profile, created once with
      //   xcrun notarytool store-credentials "encore-notary" \
      //     --apple-id <id> --team-id 53MUTM55LC --password <app-specific-pw>
      // so the app-specific password lives in the keychain and never appears
      // in a shell env, a CI log, or this file. CI (which has no keychain
      // profile) falls back to the explicit credential triple.
      ...(process.env.APPLE_KEYCHAIN_PROFILE
        ? {
            osxNotarize: {
              keychainProfile: process.env.APPLE_KEYCHAIN_PROFILE,
            },
          }
        : process.env.APPLE_ID && {
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
    name: APP_NAME,

    // Extensionless: packager appends .icns on darwin and .ico on win32. The
    // previous "icon.ico" was silently ignored on macOS -- no error, the
    // bundle just kept Electron's default atom icon.
    icon: "dist/resources/icon",

    // --- macOS bundle identity ---
    appBundleId: "org.encorekaraoke.desktop",
    appCategoryType: "public.app-category.music",
    appCopyright: "Copyright © 2026 Encore Karaoke Labs",

    // Written as NS<Type>UsageDescription into the app plist and every helper
    // plist. Without these, calling getUserMedia on macOS terminates the
    // process rather than showing a denial.
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

    // Do NOT add CFBundleIdentifier or LSApplicationCategoryType here --
    // packager writes those from appBundleId/appCategoryType and duplicates
    // can conflict.
    extendInfo: {
      NSLocalNetworkUsageDescription:
        "Encore Karaoke uses your local network so phones on the same Wi-Fi can act as remote controls, and to find Encore song-update servers.",
      // Declaration hygiene per Apple TN3179. bonjour-service does raw 5353
      // multicast rather than dns-sd, so this does not by itself unblock
      // discovery -- keep it in sync with the service types used in main.js.
      NSBonjourServices: ["_enmoku._tcp", "_encore-server._tcp"],
      NSRemovableVolumesUsageDescription:
        "Encore Karaoke reads your karaoke library from external drives.",
      NSNetworkVolumesUsageDescription:
        "Encore Karaoke reads your karaoke library from network shares.",
    },

    ...signing,

    extraResource: ["dist/resources/static", "dist/resources/icon.png"],
    linux: {
      target: "deb",
    },
    ignore: (file) => {
      if (!file || file === "/" || file === "") return false;

      let normalizedPath = file.replace(/\\/g, "/");
      if (normalizedPath.endsWith("/")) {
        normalizedPath = normalizedPath.slice(0, -1);
      }

      if (
        normalizedPath === "/dist/resources/static" ||
        normalizedPath === "/dist/resources/static/assets" ||
        normalizedPath.startsWith("/dist/resources/static/assets/fonts")
      ) {
        return false;
      }

      if (normalizedPath.startsWith("/dist/resources/static")) return true;

      if (normalizedPath === "/dist/resources/icon.png") return true;

      if (normalizedPath === "/package.json") return false;
      if (normalizedPath.startsWith("/dist")) return false;
      if (normalizedPath.startsWith("/node_modules")) return false;

      return true;
    },
    // Windows/Linux want a lowercase binary name. macOS must NOT set this:
    // packager derives CFBundleDisplayName from executableName, so setting it
    // makes the microphone prompt read "encore-karaoke would like to access
    // the microphone". Omitting it on darwin makes packager use the app name
    // for CFBundleExecutable, CFBundleDisplayName and Contents/MacOS/ alike.
    //
    // This cannot be repaired in a postPackage hook: @electron/packager signs
    // AND notarizes inside its own pipeline, so Forge's postPackage runs after
    // both, and editing Info.plist there invalidates the signature
    // ("invalid Info.plist (plist or signature have been modified)").
    //
    // process.platform is the build host, which is correct here -- macOS
    // bundles can only be signed on macOS, and Windows/Linux artifacts are
    // built on their own runners.
    ...(process.platform === "darwin"
      ? {}
      : { executableName: "encore-karaoke" }),
  },
  hooks: {},
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        authors: "Encore Karaoke Labs",
        description: "Encore Karaoke app",
      },
    },
    {
      // Kept alongside the DMG: Squirrel.Mac consumes zips for auto-update.
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
    {
      // darwin hosts only -- appdmg shells out to hdiutil.
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {
        name: APP_NAME,
        // Must exist or the maker throws; produced by build.js from src/icons.
        icon: "dist/resources/icon.icns",
        format: "ULFO",
      },
    },
    {
      name: "@electron-forge/maker-deb",
      config: {
        authors: "Encore Karaoke Labs",
        description: "Encore Karaoke for Linux",
        name: "Encore",
        category: "Games",
      },
    },
  ],
  plugins: [
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
