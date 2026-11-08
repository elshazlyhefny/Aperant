import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import type { Components } from 'react-markdown';
import { useTranslation } from 'react-i18next';

function isHttpUrl(href: string | undefined): href is string {
  if (!href) return false;
  try {
    const { protocol } = new URL(href);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Markdown link renderer. Only http(s) links are rendered as anchors, and they
 * open in the system browser so the app window can never navigate away.
 * Everything else renders as plain text.
 */
export function MarkdownLink({
  href,
  children,
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { t } = useTranslation('common');

  if (!isHttpUrl(href)) {
    return <span className="text-muted-foreground">{children}</span>;
  }

  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    Promise.resolve(window.electronAPI.openExternal(href)).catch(() => {
      // Ignore failures to open the external browser
    });
  };

  return (
    <a
      href={href}
      rel="noopener noreferrer"
      className="text-primary hover:underline"
      onClick={open}
      onAuxClick={(event) => event.preventDefault()}
    >
      {children}
      <span className="sr-only"> {t('accessibility.opensInNewWindow')}</span>
    </a>
  );
}

export const markdownLinkComponents: Components = { a: MarkdownLink };
