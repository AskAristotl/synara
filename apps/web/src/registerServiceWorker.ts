import { isElectron } from "./env";

/**
 * Registers the PWA service worker (`/sw.js`) so the app is installable to a
 * phone/desktop home screen and can relaunch offline.
 *
 * Guards:
 *  - Production only. In dev the SW would race Vite's HMR and cache stale
 *    modules; installability is only meaningful against the built app anyway
 *    (which is exactly what the remote/mobile flow serves — see REMOTE.md).
 *  - Never inside Electron. The desktop shell is already a native window; a SW
 *    would only add a caching layer with nothing to gain.
 *  - Only when the browser actually supports service workers.
 *
 * Registration is best-effort and fire-and-forget: any failure is logged and
 * swallowed so it can never block app boot.
 */
export function registerServiceWorker(): void {
  if (isElectron) return;
  if (!import.meta.env.PROD) return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  // Wait for load so SW install/precache never contends with first paint.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("[pwa] service worker registration failed", error);
    });
  });
}
