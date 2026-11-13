import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { is } from '@electron-toolkit/utils';
import { IPC_CHANNELS } from '../shared/constants';
import { getAppRendererUrl, isAppUrl } from './navigation-guard';

// ESM-compatible __dirname: the main process builds to ESM, where the global does not exist.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Minimal shape of an IPC event that carries the frame that sent it. */
export interface IpcSenderEvent {
  senderFrame?: { url: string } | null;
}

/**
 * True only when the IPC message was sent by a frame showing the app's own renderer.
 * Uses the same dev/prod logic as the navigation guard. A missing senderFrame is untrusted.
 */
export function isTrustedSender(event: IpcSenderEvent | null | undefined): boolean {
  const url = event?.senderFrame?.url;
  if (!url) return false;
  return isAppUrl(url, getAppRendererUrl(__dirname, is.dev));
}

/** Check a sender and log a warning for the channel when it is untrusted. */
export function assertTrustedSender(event: IpcSenderEvent | null | undefined, channel: string): boolean {
  if (isTrustedSender(event)) return true;
  console.warn(`[ipc] Rejected ${channel} from untrusted sender:`, event?.senderFrame?.url ?? '(no frame)');
  return false;
}

/**
 * Channels registered without the sender guard, each with the reviewed reason.
 */
export const UNGUARDED_IPC_CHANNELS: ReadonlyMap<string, string> = new Map([
  [
    IPC_CHANNELS.GITHUB_AUTH_CHANGED,
    'In-process ipcMain.emit signal from github/oauth-handlers.ts consumed by github/pr/query-handlers.ts; the listener receives no IPC event, so there is no sender to check.',
  ],
]);

type AnyFn = (...args: any[]) => any;

/** Minimal structural type of ipcMain that the guard needs. */
export interface GuardableIpc {
  handle: AnyFn;
  handleOnce: AnyFn;
  on: AnyFn;
  once: AnyFn;
}

const guardedIpc = new WeakSet<object>();

/**
 * zeenha fork: the sender check is installed globally on ipcMain instead of in each handler.
 * Per-handler checks are easy to forget in new handlers (40+ modules), so every channel is
 * guarded by default and only reviewed exceptions are listed in UNGUARDED_IPC_CHANNELS.
 * Idempotent: a second call on the same object does nothing.
 */
export function installIpcSenderGuard(ipc: GuardableIpc): void {
  if (guardedIpc.has(ipc)) return;
  guardedIpc.add(ipc);

  for (const method of ['handle', 'handleOnce'] as const) {
    const original = ipc[method].bind(ipc) as AnyFn;
    ipc[method] = (channel: string, handler: AnyFn) => {
      if (UNGUARDED_IPC_CHANNELS.has(channel)) return original(channel, handler);
      return original(channel, (event: IpcSenderEvent, ...args: unknown[]) => {
        if (!assertTrustedSender(event, channel)) throw new Error('Untrusted sender');
        return handler(event, ...args);
      });
    };
  }

  for (const method of ['on', 'once'] as const) {
    const original = ipc[method].bind(ipc) as AnyFn;
    ipc[method] = (channel: string, listener: AnyFn) => {
      if (UNGUARDED_IPC_CHANNELS.has(channel)) return original(channel, listener);
      const wrapped = (event: IpcSenderEvent, ...args: unknown[]) => {
        if (!assertTrustedSender(event, channel)) {
          // An untrusted sender must not consume a one-shot listener.
          if (method === 'once') original(channel, wrapped);
          return;
        }
        return listener(event, ...args);
      };
      // Lets removeListener/off by the original reference keep working.
      (wrapped as AnyFn & { listener?: AnyFn }).listener = listener;
      original(channel, wrapped);
      return ipc;
    };
  }
}
