import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { AppSettings, IPCResult } from '../../shared/types';
import type { ProviderAccount } from '../../shared/types/provider-account';
import { withKeyStatusReset } from '../../shared/utils/api-key-status';
import { readSettingsFile, updateSettingsFile } from '../settings-utils';

const genAccountId = () => `pa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/** Read providerAccounts array from settings.json (read-only; [] when unreadable) */
function readProviderAccounts(): ProviderAccount[] {
  const settings = readSettingsFile();
  if (!settings) return [];
  return settings.providerAccounts ?? [];
}

/**
 * Provider account CRUD handlers. Every mutation runs inside updateSettingsFile
 * so the read, the checks and the write happen in one locked section and a
 * corrupt settings.json is never overwritten.
 */
export function registerProviderAccountHandlers(): void {
  // GET all provider accounts
  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_ACCOUNTS_GET,
    async (): Promise<IPCResult<{ accounts: ProviderAccount[] }>> => {
      try {
        const accounts = readProviderAccounts();
        return { success: true, data: { accounts } };
      } catch (error) {
        console.error('[PROVIDER_ACCOUNTS_GET] Error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to get provider accounts' };
      }
    }
  );

  // SAVE (create) a new provider account
  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_ACCOUNTS_SAVE,
    async (_event, account: Omit<ProviderAccount, 'id' | 'createdAt' | 'updatedAt'>): Promise<IPCResult<ProviderAccount>> => {
      try {
        const result = await updateSettingsFile(
          (settings): { kind: 'duplicate'; name: string } | { kind: 'created'; account: ProviderAccount; queueLength: number } => {
            const accounts: ProviderAccount[] = settings.providerAccounts ?? [];

            // Prevent duplicate: same email + provider already registered
            if (account.email) {
              const duplicate = accounts.find(
                (a) => a.provider === account.provider && a.email?.toLowerCase() === account.email!.toLowerCase()
              );
              if (duplicate) {
                return { kind: 'duplicate', name: duplicate.name };
              }
            }

            const now = Date.now();
            // New accounts always start unverified: ignore client-supplied key status
            const { keyStatus: _ks, keyStatusAt: _ksAt, ...accountFields } = account as typeof account & Partial<ProviderAccount>;
            const newAccount: ProviderAccount = {
              ...accountFields,
              id: genAccountId(),
              createdAt: now,
              updatedAt: now,
            };
            accounts.push(newAccount);
            settings.providerAccounts = accounts;

            // Add to globalPriorityOrder — prepend so new account becomes active
            const queue: string[] = settings.globalPriorityOrder ?? [];
            queue.unshift(newAccount.id);
            settings.globalPriorityOrder = queue;

            return { kind: 'created', account: newAccount, queueLength: queue.length };
          }
        );

        if (result.kind === 'duplicate') {
          return { success: false, error: `DUPLICATE_EMAIL:${result.name}` };
        }
        const newAccount = result.account;
        console.warn('[PROVIDER_ACCOUNTS_SAVE] Created account:', newAccount.id, newAccount.name, newAccount.provider, '| Queue position: #1 of', result.queueLength);
        return { success: true, data: newAccount };
      } catch (error) {
        console.error('[PROVIDER_ACCOUNTS_SAVE] Error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to save provider account' };
      }
    }
  );

  // UPDATE an existing provider account
  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_ACCOUNTS_UPDATE,
    async (_event, id: string, updates: Partial<ProviderAccount>): Promise<IPCResult<ProviderAccount>> => {
      try {
        const result = await updateSettingsFile(
          (settings): { kind: 'not_found' } | { kind: 'updated'; account: ProviderAccount } => {
            const accounts: ProviderAccount[] = settings.providerAccounts ?? [];
            const index = accounts.findIndex(a => a.id === id);
            if (index === -1) {
              return { kind: 'not_found' };
            }
            const existing = accounts[index];
            // zeenha fork: a changed key or endpoint starts unverified; status is never client-set
            const { keyStatus: _ks, keyStatusAt: _ksAt, ...safeUpdates } = updates;
            const credentialsChanged =
              (safeUpdates.apiKey !== undefined && safeUpdates.apiKey !== existing.apiKey) ||
              (safeUpdates.baseUrl !== undefined && safeUpdates.baseUrl !== existing.baseUrl);
            const updated: ProviderAccount = {
              ...(credentialsChanged ? withKeyStatusReset(existing) : existing),
              ...safeUpdates,
              id, // prevent id override
              updatedAt: Date.now(),
            };
            accounts[index] = updated;
            settings.providerAccounts = accounts;
            return { kind: 'updated', account: updated };
          }
        );

        if (result.kind === 'not_found') {
          return { success: false, error: `Account not found: ${id}` };
        }
        console.warn('[PROVIDER_ACCOUNTS_UPDATE] Updated account:', id);
        return { success: true, data: result.account };
      } catch (error) {
        console.error('[PROVIDER_ACCOUNTS_UPDATE] Error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to update provider account' };
      }
    }
  );

  // DELETE a provider account
  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_ACCOUNTS_DELETE,
    async (_event, id: string): Promise<IPCResult> => {
      try {
        const result = await updateSettingsFile((settings): { kind: 'not_found' } | { kind: 'deleted' } => {
          const accounts: ProviderAccount[] = settings.providerAccounts ?? [];
          const filtered = accounts.filter(a => a.id !== id);
          if (filtered.length === accounts.length) {
            return { kind: 'not_found' };
          }
          settings.providerAccounts = filtered;

          // Remove from globalPriorityOrder
          const queue: string[] = settings.globalPriorityOrder ?? [];
          settings.globalPriorityOrder = queue.filter(qid => qid !== id);

          // Remove from crossProviderPriorityOrder
          const cpQueue: string[] = settings.crossProviderPriorityOrder ?? [];
          if (cpQueue.length > 0) {
            settings.crossProviderPriorityOrder = cpQueue.filter(qid => qid !== id);
          }
          return { kind: 'deleted' };
        });

        if (result.kind === 'not_found') {
          return { success: false, error: `Account not found: ${id}` };
        }
        console.warn('[PROVIDER_ACCOUNTS_DELETE] Deleted account:', id);
        return { success: true };
      } catch (error) {
        console.error('[PROVIDER_ACCOUNTS_DELETE] Error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to delete provider account' };
      }
    }
  );

  // SET QUEUE ORDER for provider accounts (global priority queue)
  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_ACCOUNTS_SET_QUEUE_ORDER,
    async (_event, order: string[]): Promise<IPCResult> => {
      try {
        await updateSettingsFile((settings) => {
          settings.globalPriorityOrder = order;
        });

        // Sync to claude-profiles.json so usage-monitor (which reads from profileManager) stays in sync
        try {
          const { getClaudeProfileManager } = await import('../claude-profile-manager');
          const manager = getClaudeProfileManager();
          manager.setAccountPriorityOrder(order);
        } catch {
          // Non-fatal: usage-monitor may use stale order until next app restart
        }

        console.warn('[PROVIDER_ACCOUNTS_SET_QUEUE_ORDER] Queue order updated:', order.length, 'accounts');
        return { success: true };
      } catch (error) {
        console.error('[PROVIDER_ACCOUNTS_SET_QUEUE_ORDER] Error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to set queue order' };
      }
    }
  );

  // SET CROSS-PROVIDER QUEUE ORDER (separate priority for cross-provider mode)
  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_ACCOUNTS_SET_CROSS_PROVIDER_QUEUE_ORDER,
    async (_event, order: string[]): Promise<IPCResult> => {
      try {
        await updateSettingsFile((settings) => {
          settings.crossProviderPriorityOrder = order;
        });
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to set cross-provider queue order' };
      }
    }
  );

  // SAVE MODEL OVERRIDES (cross-provider model equivalence user overrides)
  ipcMain.handle(
    IPC_CHANNELS.MODEL_OVERRIDES_SAVE,
    async (_event, overrides: NonNullable<AppSettings['modelOverrides']>): Promise<IPCResult> => {
      try {
        await updateSettingsFile((settings) => {
          settings.modelOverrides = overrides;
        });
        console.warn('[MODEL_OVERRIDES_SAVE] Model overrides saved');
        return { success: true };
      } catch (error) {
        console.error('[MODEL_OVERRIDES_SAVE] Error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to save model overrides' };
      }
    }
  );

  // CHECK ENV credentials (detect which providers have env vars set)
  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_ACCOUNTS_CHECK_ENV,
    async (): Promise<IPCResult<Record<string, boolean>>> => {
      try {
        const envMap: Record<string, boolean> = {};
        const envVarMapping: Record<string, string> = {
          ANTHROPIC_API_KEY: 'anthropic',
          OPENAI_API_KEY: 'openai',
          GOOGLE_GENERATIVE_AI_API_KEY: 'google',
          MISTRAL_API_KEY: 'mistral',
          GROQ_API_KEY: 'groq',
          XAI_API_KEY: 'xai',
          AWS_ACCESS_KEY_ID: 'amazon-bedrock',
          AZURE_OPENAI_API_KEY: 'azure',
        };
        for (const [envVar, provider] of Object.entries(envVarMapping)) {
          if (process.env[envVar]) {
            envMap[provider] = true;
          }
        }
        return { success: true, data: envMap };
      } catch (error) {
        console.error('[PROVIDER_ACCOUNTS_CHECK_ENV] Error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to check env credentials' };
      }
    }
  );
}
