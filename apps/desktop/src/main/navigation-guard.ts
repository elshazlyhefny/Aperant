import { shell } from 'electron';
import type { WebContents } from 'electron';
import { join } from 'path';
import { pathToFileURL } from 'url';

const WINDOW_OPEN_SCHEMES = ['http:', 'https:', 'mailto:'];
const EXTERNAL_NAV_SCHEMES = ['http:', 'https:'];

/**
 * URL of the app's own renderer: the dev server in dev, the bundled index.html otherwise.
 * `appDir` is the directory of the compiled main bundle (renderer lives at ../renderer).
 */
export function getAppRendererUrl(appDir: string, isDev: boolean, devUrl = process.env['ELECTRON_RENDERER_URL']): string {
  if (isDev && devUrl) return devUrl;
  return pathToFileURL(join(appDir, '../renderer/index.html')).toString();
}

/** True only for the app's own renderer (same origin in dev, same file in prod). Hash/query ignored. */
export function isAppUrl(url: string, appRendererUrl: string): boolean {
  try {
    const target = new URL(url);
    const app = new URL(appRendererUrl);
    if (app.protocol === 'file:') {
      return target.protocol === 'file:' && target.pathname === app.pathname;
    }
    if (app.protocol !== 'http:' && app.protocol !== 'https:') return false;
    return target.origin === app.origin;
  } catch {
    return false;
  }
}

/** Only http(s) may be handed to the OS browser from a blocked navigation. */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    return EXTERNAL_NAV_SCHEMES.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Shared window.open policy: http/https/mailto open externally; the window is always denied. */
export function handleWindowOpen(details: { url: string }): { action: 'deny' } {
  try {
    const url = new URL(details.url);
    if (!WINDOW_OPEN_SCHEMES.includes(url.protocol)) {
      console.warn('[main] Blocked URL with disallowed scheme:', details.url);
      return { action: 'deny' };
    }
  } catch {
    console.warn('[main] Blocked invalid URL:', details.url);
    return { action: 'deny' };
  }
  shell.openExternal(details.url).catch((error) => {
    console.warn('[main] Failed to open external URL:', details.url, error);
  });
  return { action: 'deny' };
}

/** Block top-level navigation away from the app, webview attachment, and new windows. */
export function applyNavigationPolicy(contents: WebContents, appRendererUrl: string): void {
  const guard = (event: { url: string; preventDefault: () => void }) => {
    if (isAppUrl(event.url, appRendererUrl)) return;
    event.preventDefault();
    if (isAllowedExternalUrl(event.url)) {
      shell.openExternal(event.url).catch((error) => {
        console.warn('[main] Failed to open external URL:', event.url, error);
      });
    } else {
      console.warn('[main] Blocked navigation to:', event.url);
    }
  };
  // biome-ignore lint/suspicious/noExplicitAny: event typings differ across Electron versions
  const on = contents.on.bind(contents) as (name: string, listener: (...args: any[]) => void) => void;
  on('will-navigate', guard);
  on('will-redirect', guard);
  on('will-frame-navigate', guard);
  on('will-attach-webview', (e: { preventDefault: () => void }) => e.preventDefault());
  contents.setWindowOpenHandler(handleWindowOpen);
}
