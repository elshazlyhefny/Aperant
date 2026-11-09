import path from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { exec } from 'child_process';
import { homedir } from 'os';
import { promisify } from 'util';
import { getCurrentOS } from '../../../platform';
import { isPathSafe } from './path-safety';
import { IDE_DETECTION, TERMINAL_DETECTION, CLI_DETECTION } from './tables';
import type { DetectedTool, DetectedTools } from './types';

const execAsync = promisify(exec);

/**
 * Smart app detection using native OS APIs for faster, more comprehensive discovery
 */

// Cache for installed apps (refreshed on each detection call)
let installedAppsCache: Set<string> = new Set();

/**
 * macOS: Use Spotlight (mdfind) to quickly find all installed .app bundles
 */
async function detectMacApps(): Promise<Set<string>> {
  const apps = new Set<string>();
  try {
    // Use mdfind to query Spotlight for all applications - much faster than directory scanning
    // Timeout after 10 seconds to prevent hangs on systems with slow Spotlight indexing
    const { stdout } = await execAsync('mdfind -onlyin /Applications "kMDItemKind == Application" 2>/dev/null | head -500', { timeout: 10000 });
    const appPaths = stdout.trim().split('\n').filter(p => p);

    for (const appPath of appPaths) {
      // Extract app name from path (e.g., "/Applications/Visual Studio Code.app" -> "Visual Studio Code")
      const match = appPath.match(/\/([^/]+)\.app$/i);
      if (match) {
        apps.add(match[1].toLowerCase());
      }
    }
  } catch {
    // Fallback: scan /Applications directory
    try {
      const appDir = '/Applications';
      if (existsSync(appDir)) {
        const entries = readdirSync(appDir);
        for (const entry of entries) {
          if (entry.endsWith('.app')) {
            apps.add(entry.replace('.app', '').toLowerCase());
          }
        }
      }
    } catch {
      // Ignore errors
    }
  }
  return apps;
}

/**
 * Windows: Check registry and common installation paths
 */
async function detectWindowsApps(): Promise<Set<string>> {
  const apps = new Set<string>();
  try {
    // Query registry for installed programs using PowerShell
    const { stdout } = await execAsync(
      `powershell -Command "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Select-Object DisplayName | ConvertTo-Json"`,
      { timeout: 10000 }
    );
    const programs = JSON.parse(stdout);
    if (Array.isArray(programs)) {
      for (const prog of programs) {
        if (prog.DisplayName) {
          apps.add(prog.DisplayName.toLowerCase());
        }
      }
    }
  } catch {
    // Fallback: check common paths
    const commonPaths = [
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      process.env.LOCALAPPDATA || ''
    ];
    for (const basePath of commonPaths) {
      if (basePath && existsSync(basePath)) {
        try {
          const entries = readdirSync(basePath);
          for (const entry of entries) {
            apps.add(entry.toLowerCase());
          }
        } catch {
          // Ignore errors
        }
      }
    }
  }
  return apps;
}

/**
 * Linux: Parse .desktop files from standard locations for fast app discovery
 */
async function detectLinuxApps(): Promise<Set<string>> {
  const apps = new Set<string>();
  const desktopDirs = [
    '/usr/share/applications',
    '/usr/local/share/applications',
    `${homedir()}/.local/share/applications`,
    '/var/lib/flatpak/exports/share/applications',
    '/var/lib/snapd/desktop/applications'
  ];

  for (const dir of desktopDirs) {
    try {
      if (existsSync(dir)) {
        const files = readdirSync(dir);
        for (const file of files) {
          if (file.endsWith('.desktop')) {
            // Extract app name from .desktop filename
            const name = file.replace('.desktop', '').toLowerCase();
            apps.add(name);

            // Also try to read the Name= field from .desktop file for better matching
            try {
              const content = readFileSync(path.join(dir, file), 'utf-8');
              const nameMatch = content.match(/^Name=(.+)$/m);
              if (nameMatch) {
                apps.add(nameMatch[1].toLowerCase());
              }
            } catch {
              // Ignore read errors
            }
          }
        }
      }
    } catch {
      // Ignore directory errors
    }
  }

  // Also check common binary paths
  const binPaths = ['/usr/bin', '/usr/local/bin', '/snap/bin'];
  for (const binPath of binPaths) {
    try {
      if (existsSync(binPath)) {
        const bins = readdirSync(binPath);
        for (const bin of bins) {
          apps.add(bin.toLowerCase());
        }
      }
    } catch {
      // Ignore errors
    }
  }

  return apps;
}

/**
 * Check if an app is installed using the cached app list + specific path checks
 */
function isAppInstalled(
  appNames: string[],
  specificPaths: string[],
  _platform: string
): { installed: boolean; foundPath: string } {
  // First, check the cached app list (fast)
  for (const name of appNames) {
    if (installedAppsCache.has(name.toLowerCase())) {
      return { installed: true, foundPath: '' };
    }
  }

  // Then check specific paths (for apps not in standard locations)
  for (const checkPath of specificPaths) {
    const expandedPath = checkPath
      .replace('%USERNAME%', process.env.USERNAME || process.env.USER || '')
      .replace('~', homedir());

    // Validate path doesn't contain traversal attempts after expansion
    if (!isPathSafe(expandedPath)) {
      console.warn('[detectTool] Skipping potentially unsafe path:', checkPath);
      continue;
    }

    // Handle glob patterns (e.g., JetBrains*) - just check if directory exists for base path
    const basePath = expandedPath.split('*')[0];
    if (existsSync(expandedPath) || (basePath !== expandedPath && existsSync(basePath))) {
      return { installed: true, foundPath: expandedPath };
    }
  }

  return { installed: false, foundPath: '' };
}

/**
 * Detect installed IDEs and terminals on the system
 * Uses smart platform-native detection for faster results
 */
export async function detectInstalledTools(): Promise<DetectedTools> {
  const platform = getCurrentOS() as 'darwin' | 'win32' | 'linux';
  const ides: DetectedTool[] = [];
  const terminals: DetectedTool[] = [];

  // Build app cache using platform-native detection (fast!)
  console.log('[DevTools] Starting smart app detection...');
  const startTime = Date.now();

  if (platform === 'darwin') {
    installedAppsCache = await detectMacApps();
  } else if (platform === 'win32') {
    installedAppsCache = await detectWindowsApps();
  } else {
    installedAppsCache = await detectLinuxApps();
  }

  console.log(`[DevTools] Found ${installedAppsCache.size} apps in ${Date.now() - startTime}ms`);

  // Detect IDEs using cached app list + specific path checks
  for (const [id, config] of Object.entries(IDE_DETECTION)) {
    if (id === 'custom' || !config) continue;

    const paths = config.paths[platform] || [];
    // Generate search names from the config name and id
    const searchNames = [
      config.name.toLowerCase(),
      id.toLowerCase(),
      // Handle common variations
      config.name.replace(/\s+/g, '').toLowerCase(),
      config.name.replace(/\s+/g, '-').toLowerCase()
    ];

    const { installed, foundPath } = isAppInstalled(searchNames, paths, platform);

    // Also try command check if not found via app detection
    let finalInstalled = installed;
    if (!finalInstalled && config.commands[platform]) {
      try {
        if (platform === 'win32') {
          await execAsync(`where ${config.commands[platform]}`, { timeout: 2000 });
        } else {
          await execAsync(`which ${config.commands[platform]}`, { timeout: 2000 });
        }
        finalInstalled = true;
      } catch {
        // Command not found
      }
    }

    if (finalInstalled) {
      ides.push({
        id,
        name: config.name,
        path: foundPath,
        installed: true
      });
    }
  }

  // Detect Terminals using cached app list + specific path checks
  for (const [id, config] of Object.entries(TERMINAL_DETECTION)) {
    if (id === 'custom' || !config) continue;

    const paths = config.paths[platform] || [];
    const searchNames = [
      config.name.toLowerCase(),
      id.toLowerCase(),
      config.name.replace(/\s+/g, '').toLowerCase()
    ];

    const { installed, foundPath } = isAppInstalled(searchNames, paths, platform);

    if (installed) {
      terminals.push({
        id,
        name: config.name,
        path: foundPath,
        installed: true
      });
    }
  }

  // Always add system terminal as fallback
  if (!terminals.find(t => t.id === 'system')) {
    terminals.unshift({
      id: 'system',
      name: 'System Terminal',
      path: '',
      installed: true
    });
  }

  // Detect CLIs using command checks (CLIs are command-line tools, not GUI apps)
  const clis: DetectedTool[] = [];
  for (const [id, config] of Object.entries(CLI_DETECTION)) {
    if (id === 'custom' || !config) continue;

    const command = config.commands[platform];
    if (!command) continue;

    try {
      if (platform === 'win32') {
        await execAsync(`where ${command}`, { timeout: 2000 });
      } else {
        await execAsync(`which ${command}`, { timeout: 2000 });
      }
      clis.push({
        id,
        name: config.name,
        path: command,
        installed: true
      });
    } catch {
      // Command not found
    }
  }

  console.log(`[DevTools] Detection complete: ${ides.length} IDEs, ${terminals.length} terminals, ${clis.length} CLIs`);
  return { ides, terminals, clis };
}
