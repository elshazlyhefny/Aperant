import type { ProviderAccount, ProviderAccountView } from '../types/provider-account';
import type { AppSettings, RendererAppSettings } from '../types/settings';

export function toProviderAccountView(account: ProviderAccount): ProviderAccountView {
  // zeenha fork: allowlist fields so new credentials cannot cross IPC by default.
  const view: ProviderAccountView = {
    id: account.id,
    provider: account.provider,
    name: account.name,
    authType: account.authType,
    billingModel: account.billingModel,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    hasApiKey: typeof account.apiKey === 'string' && account.apiKey.trim().length > 0,
  };

  if (account.email !== undefined) view.email = account.email;
  if (account.baseUrl !== undefined) view.baseUrl = account.baseUrl;
  if (account.region !== undefined) view.region = account.region;
  if (account.claudeProfileId !== undefined) view.claudeProfileId = account.claudeProfileId;
  if (account.usage !== undefined) view.usage = account.usage;
  if (account.rateLimitEvents !== undefined) view.rateLimitEvents = account.rateLimitEvents;
  if (account.customModels !== undefined) view.customModels = account.customModels;
  if (account.keyStatus !== undefined) view.keyStatus = account.keyStatus;
  if (account.keyStatusAt !== undefined) view.keyStatusAt = account.keyStatusAt;

  return view;
}

export function toProviderAccountViews(accounts: ProviderAccount[] | undefined): ProviderAccountView[] {
  return accounts?.map(toProviderAccountView) ?? [];
}

export function toRendererSettings(settings: AppSettings): RendererAppSettings {
  const { providerAccounts, ...otherSettings } = settings;
  if (providerAccounts !== undefined) {
    return { ...otherSettings, providerAccounts: toProviderAccountViews(providerAccounts) };
  }
  return otherSettings;
}
