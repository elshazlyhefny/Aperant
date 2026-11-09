import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
}));

import { shell } from 'electron';
import {
  applyNavigationPolicy,
  getAppRendererUrl,
  handleWindowOpen,
  isAllowedExternalUrl,
  isAppUrl,
} from '../navigation-guard';

const DEV = 'http://localhost:5173/';
const PROD = getAppRendererUrl('/opt/app/out/main', false);

function setup(appUrl: string) {
  const contents = new EventEmitter() as EventEmitter & { setWindowOpenHandler: ReturnType<typeof vi.fn> };
  contents.setWindowOpenHandler = vi.fn();
  applyNavigationPolicy(contents as never, appUrl);
  const fire = (name: string, url: string) => {
    const event = { url, preventDefault: vi.fn() };
    contents.emit(name, event);
    return event;
  };
  return { contents, fire };
}

describe('navigation-guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('builds the renderer URL', () => {
    expect(getAppRendererUrl('/x/out/main', true, DEV)).toBe(DEV);
    expect(PROD).toBe('file:///opt/app/out/renderer/index.html');
  });

  it('allows app URLs', () => {
    expect(isAppUrl('http://localhost:5173/#/x', DEV)).toBe(true);
    expect(isAppUrl(`${PROD}#/tasks?a=1`, PROD)).toBe(true);
    const { fire } = setup(DEV);
    expect(fire('will-navigate', 'http://localhost:5173/foo').preventDefault).not.toHaveBeenCalled();
  });

  it('blocks and externally opens https URLs', () => {
    const { fire } = setup(PROD);
    expect(fire('will-navigate', 'https://evil.example/').preventDefault).toHaveBeenCalled();
    expect(shell.openExternal).toHaveBeenCalledWith('https://evil.example/');
  });

  it('blocks other file:// paths', () => {
    const { fire } = setup(PROD);
    expect(fire('will-navigate', 'file:///etc/passwd').preventDefault).toHaveBeenCalled();
  });

  it.each(['javascript:alert(1)', 'data:text/html,hi', 'custom://x', 'not a url'])('blocks %s without opening', (url) => {
    const { fire } = setup(PROD);
    expect(fire('will-navigate', url).preventDefault).toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(isAllowedExternalUrl(url)).toBe(false);
  });

  it('guards redirects and frame navigations', () => {
    const { fire } = setup(PROD);
    expect(fire('will-redirect', 'https://evil.example/').preventDefault).toHaveBeenCalled();
    expect(fire('will-frame-navigate', 'https://evil.example/').preventDefault).toHaveBeenCalled();
  });

  it('prevents webview attachment', () => {
    const { fire } = setup(PROD);
    expect(fire('will-attach-webview', '').preventDefault).toHaveBeenCalled();
  });

  it('window.open policy is unchanged', () => {
    const { contents } = setup(PROD);
    expect(contents.setWindowOpenHandler).toHaveBeenCalledWith(handleWindowOpen);
    expect(handleWindowOpen({ url: 'mailto:a@b.c' })).toEqual({ action: 'deny' });
    expect(shell.openExternal).toHaveBeenCalledWith('mailto:a@b.c');
    vi.mocked(shell.openExternal).mockClear();
    expect(handleWindowOpen({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});
