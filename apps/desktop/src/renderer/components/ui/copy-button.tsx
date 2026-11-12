import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { Button, type ButtonProps } from './button';
import { cn } from '../../lib/utils';

const COPIED_RESET_MS = 2000;

export interface CopyButtonProps {
  /** Text written to the clipboard */
  text: string;
  /** Visible label; omit for an icon-only button */
  label?: string;
  /** Label shown (and announced) after a successful copy; defaults to "Copied" */
  copiedLabel?: string;
  /** Icon shown before copying; defaults to Copy */
  icon?: ComponentType<{ className?: string }>;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  className?: string;
  /** Overrides the default icon size (h-3.5 w-3.5) */
  iconClassName?: string;
  disabled?: boolean;
  onCopy?: () => void;
}

export function CopyButton({
  text,
  label,
  copiedLabel,
  icon: Icon = Copy,
  variant = 'ghost',
  size = 'sm',
  className,
  iconClassName = 'h-3.5 w-3.5',
  disabled,
  onCopy
}: CopyButtonProps) {
  const { t } = useTranslation('common');
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error('Failed to copy:', err);
      return;
    }
    setCopied(true);
    onCopy?.();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setCopied(false);
    }, COPIED_RESET_MS);
  }, [text, onCopy]);

  const copiedText = copiedLabel ?? t('buttons.copied');
  const idleText = label ?? t('buttons.copy');

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={cn(className)}
      onClick={handleCopy}
      disabled={disabled}
      aria-label={copied ? copiedText : idleText}
    >
      {copied ? (
        <Check className={cn(iconClassName, 'text-success', label && 'mr-1')} aria-hidden="true" />
      ) : (
        <Icon className={cn(iconClassName, label && 'mr-1')} aria-hidden="true" />
      )}
      <span aria-live="polite">{copied ? copiedText : label}</span>
    </Button>
  );
}
