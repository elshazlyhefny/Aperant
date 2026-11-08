/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import ReactMarkdown from 'react-markdown';
import '../../../shared/i18n';
import { MarkdownLink, markdownLinkComponents } from './markdown-link';

const mockOpenExternal = vi.fn();
Object.defineProperty(window, 'electronAPI', {
  value: { openExternal: mockOpenExternal },
  writable: true,
});

describe('MarkdownLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenExternal.mockResolvedValue(undefined);
  });

  it('opens https links externally and prevents default', () => {
    render(<MarkdownLink href="https://example.com/a">go</MarkdownLink>);
    const link = screen.getByRole('link');
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false);
    expect(mockOpenExternal).toHaveBeenCalledWith('https://example.com/a');
  });

  it('prevents middle-click navigation', () => {
    render(<MarkdownLink href="https://example.com">go</MarkdownLink>);
    expect(fireEvent(screen.getByRole('link'), new MouseEvent('auxclick', { bubbles: true, cancelable: true }))).toBe(false);
  });

  it.each(['javascript:alert(1)', '/relative', '#anchor', 'mailto:a@b.c', 'file:///etc/passwd', undefined])(
    'renders no anchor for %s',
    (href) => {
      render(<MarkdownLink href={href}>text</MarkdownLink>);
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.getByText('text')).toBeInTheDocument();
    }
  );

  it('works through ReactMarkdown', () => {
    render(<ReactMarkdown components={markdownLinkComponents}>{'[x](https://evil.example)'}</ReactMarkdown>);
    fireEvent.click(screen.getByRole('link'));
    expect(mockOpenExternal).toHaveBeenCalledWith('https://evil.example');
  });
});
