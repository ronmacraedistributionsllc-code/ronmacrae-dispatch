import type React from "react";

const APP_VERSION_NAME = "1";
const APK_PATH = "/downloads/ronmacrae-dispatch.apk";

/**
 * A direct-download page for the Android app (spec: "push it to be live
 * so I can use on the site") — separate from, and ahead of, the Google
 * Play Store listing (a hard boundary this assistant can't complete
 * itself: uploading needs the business owner's own Google login in the
 * Play Console). The APK here is the exact same signed, verified release
 * build the AAB was built from — see android/README.md for how it's
 * produced and re-verified (apksigner/aapt2), never a separate,
 * differently-signed artifact.
 *
 * Android blocks installs from outside the Play Store by default
 * ("Unknown sources") — the instructions below are the real, current
 * steps for that, not decorative copy.
 */
export function DownloadApp(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-lg space-y-4 p-4">
      <header className="text-center">
        <img src="/icons/icon-192.png" alt="" className="mx-auto mb-3 h-16 w-16 rounded-2xl" />
        <h1 className="text-xl font-bold">Ronmacrae Dispatch for Android</h1>
        <p className="text-sm text-zinc-400">Version {APP_VERSION_NAME} · direct download, not yet on Google Play</p>
      </header>

      <div className="card space-y-3 text-center">
        <a className="btn-accent block w-full !py-3 text-base font-semibold" href={APK_PATH} download>
          Download the app (.apk)
        </a>
        <p className="text-xs text-zinc-500">
          Works on Android 5.0 (Lollipop) and newer. This installs the real, signed app — the same one built for the
          Play Store — just not through the Play Store yet.
        </p>
      </div>

      <div className="card space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">How to install it</h2>
        <ol className="list-inside list-decimal space-y-1.5 text-sm text-zinc-300">
          <li>Tap "Download the app" above — Chrome will save the file.</li>
          <li>
            Open the downloaded file. Android will warn that it blocks installs from this source by default —
            tap <strong>Settings</strong> in that prompt.
          </li>
          <li>Turn on <strong>Allow from this source</strong> for your browser, then go back.</li>
          <li>Tap <strong>Install</strong>. The app icon appears on your home screen once it's done.</li>
        </ol>
        <p className="text-xs text-zinc-500">
          This one-time permission only applies to installs coming from wherever you downloaded this file — it
          doesn't loosen your phone's security generally, and you can turn it back off afterward in Settings.
        </p>
      </div>
    </div>
  );
}
