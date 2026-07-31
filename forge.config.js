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
      // notarizing requires credentials and a network round-trip.
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
    executableName: "encore-karaoke",
  },
  hooks: {
    // packager derives CFBundleDisplayName from executableName, and it applies
    // extendInfo BEFORE that write -- so extendInfo cannot fix it. Without
    // this the macOS microphone prompt reads "encore-karaoke would like to
    // access the microphone". postPackage runs before signing, which is
    // required: mutating the bundle after signing invalidates the signature.
    postPackage: async (_forgeConfig, options) => {
      if (options.platform !== "darwin") return;
      // plist@5 is ESM-only (no "require" condition in its exports map), so a
      // bare require() from this CJS config throws. The hook is async, so a
      // dynamic import is the clean way in.
      const plist = await import("plist");
      for (const out of options.outputPaths) {
        const infoPath = path.join(
          out,
          `${APP_NAME}.app`,
          "Contents",
          "Info.plist",
        );
        if (!fs.existsSync(infoPath)) continue;
        const info = plist.parse(fs.readFileSync(infoPath, "utf8"));
        info.CFBundleDisplayName = APP_NAME;
        fs.writeFileSync(infoPath, plist.build(info));
      }
      // Do NOT rename Contents/MacOS/encore-karaoke -- CFBundleExecutable
      // must keep matching the binary on disk.
    },
  },
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
