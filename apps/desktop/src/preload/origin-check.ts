// zeenha fork: only expose the privileged electronAPI to the app's own renderer,
// never to a remote page that ends up in the window (e.g. via a link).
export interface LocationLike {
  protocol: string;
  origin: string;
}

export function isTrustedPageOrigin(
  locationLike: LocationLike,
  rendererUrlEnv: string | undefined
): boolean {
  if (locationLike.protocol === 'file:') return true;
  if (!rendererUrlEnv) return false;
  try {
    return new URL(rendererUrlEnv).origin === locationLike.origin;
  } catch {
    return false;
  }
}
