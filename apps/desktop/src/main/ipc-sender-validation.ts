import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { is } from '@electron-toolkit/utils';
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
