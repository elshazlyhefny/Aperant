import { contextBridge } from 'electron';
import { createElectronAPI } from './api';
import { isTrustedPageOrigin } from './origin-check';

// Only expose the API to the app's own renderer (file: or the dev server)
if (isTrustedPageOrigin(window.location, process.env.ELECTRON_RENDERER_URL)) {
  // Create the unified API by combining all domain-specific APIs
  const electronAPI = createElectronAPI();

  // Expose to renderer via contextBridge
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);

  // Expose debug flag for debug logging
  contextBridge.exposeInMainWorld('DEBUG', process.env.DEBUG === 'true');

  // Expose platform information for platform-specific behavior (e.g., PTY resize timing)
  contextBridge.exposeInMainWorld('platform', {
    isWindows: process.platform === 'win32',
    isMacOS: process.platform === 'darwin',
    isLinux: process.platform === 'linux',
    isUnix: process.platform !== 'win32',
  });
}
