import * as fs from 'node:fs';
import path from 'node:path';
import { fsCompat } from './fsCompat.js';

// ---------------------------------------------------------------------------
// Public API — generic config store
// ---------------------------------------------------------------------------

export interface ConfigMigration {
  /** Current on-disk version. */
  fromVersion: number;
  /** Target version after migration. */
  toVersion: number;
  /** Returns a new config object, or the same if no migration is needed. */
  migrate(raw: unknown): unknown;
}

/** Minimal contract for anything that needs to read/write config files. */
export interface ConfigFileIO {
  existsSync(p: string): boolean;
  readFileSync(p: string, encoding: string): string;
  writeFileSync(p: string, data: string, encoding: string): void;
  mkdirSync(p: string, opts?: { recursive: boolean }): void;
}

/** Resolves the canonical path for a config file at a given scope. */
export type ConfigPathResolver = (scope: 'global' | 'project') => string;

// ---------------------------------------------------------------------------
// ConfigStore — per-scope load/migrate/merge, with scoped read/write
// ---------------------------------------------------------------------------

export interface RawConfig {
  version?: number;
  updatedAt?: string;
  [key: string]: unknown;
}

type Scope = 'global' | 'project';

interface LoadedScope {
  scope: Scope;
  filePath: string;
  config: RawConfig | null;
}

export class ConfigStore {
  /** In-memory state: one config per scope. */
  private scopes: Map<Scope, RawConfig>;
  private readonly fileIO: ConfigFileIO;
  private readonly resolver: ConfigPathResolver;
  private readonly migrations: ConfigMigration[];
  private targetVersion: number;

  constructor(opts: {
    initial?: RawConfig;
    fileIO?: ConfigFileIO;
    resolver: ConfigPathResolver;
    targetVersion?: number;
    migrations?: ConfigMigration[];
  }) {
    this.fileIO = opts.fileIO ?? fsCompat;
    this.resolver = opts.resolver;
    this.migrations = opts.migrations ?? [];
    this.targetVersion = opts.targetVersion ?? 1;

    // Build per-scope in-memory state from the initial config.
    const base = opts.initial ?? {};
    if (!base.updatedAt) base.updatedAt = new Date().toISOString();
    if (!base.version) base.version = this.targetVersion;
    this.scopes = new Map([
      ['global', { ...base }],
      ['project', { ...base }],
    ]);
  }

  // -- Loading / merging ---------------------------------------------------

  /** Load all scopes from disk, migrate each independently, then merge. */
  load(): void {
    const globalPath = this.resolver('global');
    const projectPath = this.resolver('project');

    const loaded: LoadedScope[] = [
      { scope: 'global', filePath: globalPath, config: this._loadOne(globalPath) },
      { scope: 'project', filePath: projectPath, config: this._loadOne(projectPath) },
    ];

    for (const entry of loaded) {
      if (!entry.config) continue;
      // Migrate independently before storing.
      const migrated = this._migrate(entry.config);
      this.scopes.set(entry.scope, migrated);
    }
  }

  // -- Reading -------------------------------------------------------------

  /**
   * Get config. Without a scope argument, returns the merged view
   * (project overrides global for conflicting keys).
   */
  get(scope?: Scope): RawConfig {
    if (!scope) return this._merge();
    const raw = this.scopes.get(scope);
    return raw ? JSON.parse(JSON.stringify(raw)) : {};
  }

  // -- Writing -------------------------------------------------------------

  /** Replace the config for a specific scope (in-memory only). */
  set(config: RawConfig, scope: Scope): void {
    this.scopes.set(scope, { ...config, updatedAt: new Date().toISOString() });
  }

  /** Persist a specific scope to disk. Defaults to project. */
  save(scope: Scope = 'project'): void {
    const config = this.scopes.get(scope);
    if (!config) return;

    const filePath = this.resolver(scope);
    this._ensureDir(filePath);
    this.fileIO.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
  }

  // -- Helpers -------------------------------------------------------------

  private _loadOne(filePath: string): RawConfig | null {
    try {
      if (!this.fileIO.existsSync(filePath)) return null;
      const raw = this.fileIO.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as RawConfig;
      if (parsed.version === undefined || !parsed.updatedAt) return null;
      return parsed;
    } catch (err) {
      console.error(`[config] failed to load ${filePath}: ${String(err)}`);
      return null;
    }
  }

  private _migrate(raw: RawConfig): RawConfig {
    let current = raw;
    for (const migration of this.migrations) {
      const fromVer = typeof current.version === 'number' ? current.version : 0;
      if (fromVer < migration.fromVersion) continue;
      current = migration.migrate(current) as RawConfig;
    }
    return current;
  }

  /** Deep-merge `b` into `a`, preserving nested object keys from `a`. */
  private _deepMerge(a: RawConfig, b: RawConfig): RawConfig {
    const result = { ...a };
    for (const key of Object.keys(b)) {
      if (
        typeof b[key] === 'object' && b[key] !== null &&
        !Array.isArray(b[key]) &&
        typeof result[key] === 'object' && result[key] !== null &&
        !Array.isArray(result[key])
      ) {
        result[key] = this._deepMerge(result[key] as RawConfig, b[key] as RawConfig);
      } else {
        result[key] = b[key];
      }
    }
    return result;
  }

  private _merge(): RawConfig {
    const globalCfg = this.scopes.get('global') ?? {};
    const projectCfg = this.scopes.get('project') ?? {};
    return { ...this._deepMerge(globalCfg, projectCfg), updatedAt: new Date().toISOString() };
  }

  private _ensureDir(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!this.fileIO.existsSync(dir)) {
      this.fileIO.mkdirSync(dir, { recursive: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (not exported)
// ---------------------------------------------------------------------------

function defaultPathResolver(cwd: string): ConfigPathResolver {
  const globalHome = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  return (scope) => {
    if (scope === 'global') return path.join(globalHome, '.h', 'config.json');
    return path.join(cwd, '.h', 'config.json');
  };
}

/** Create a ConfigStore wired to the default .h config paths. */
export function createDefaultConfigStore(opts?: {
  targetVersion?: number;
  migrations?: ConfigMigration[];
}): ConfigStore {
  return new ConfigStore({
    resolver: defaultPathResolver(process.cwd()),
    targetVersion: opts?.targetVersion ?? 1,
    migrations: opts?.migrations ?? [],
  });
}

// ---------------------------------------------------------------------------
// AppConfig — singleton that seeds global config from .env / .env.example
// ---------------------------------------------------------------------------

/** Parse a .env-style file into key-value pairs. */
export function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Strip `export ` prefix (e.g. `export KEY=value` → `KEY=value`)
    trimmed = trimmed.replace(/^export\s+/, '');
    // Re-check after stripping export
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!key) continue;

    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip inline comments (# and everything after, outside quotes)
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
      // For quoted values, find the closing quote and strip anything after it
      const quoteChar = value[0];
      const closeIdx = value.indexOf(quoteChar, 1);
      if (closeIdx !== -1) {
        value = value.slice(0, closeIdx + 1);
        // Strip any inline comment after the closing quote
        const rest = value.slice(closeIdx + 1).trim();
        if (rest.startsWith('#')) {
          value = value.slice(0, closeIdx + 1);
        }
      }
      // Remove surrounding quotes (only if we actually found a closing quote)
      if (closeIdx !== -1 && value.length >= 2) {
        value = value.slice(1, -1);
      }
    } else {
      // Unquoted values: strip everything from the first #
      const commentIdx = value.indexOf('#');
      if (commentIdx !== -1) {
        value = value.slice(0, commentIdx).trim();
      }
    }

    result[key] = value;
  }
  return result;
}

/** Read defaults: tries .env first, falls back to .env.example. */
function getDefaults(): Record<string, string> {
  const cwd = process.cwd();
  for (const fileName of ['.env', '.env.example']) {
    try {
      const content = fs.readFileSync(path.join(cwd, fileName), 'utf-8');
      const parsed = parseEnv(content);
      if (Object.keys(parsed).length > 0) return parsed;
    } catch {
      // file not found or unreadable — try next
    }
  }
  return {};
}

/** Singleton that initializes the config store and seeds global config. */
export class AppConfig {
  private static _instance: AppConfig | null = null;

  static getInstance(): AppConfig {
    if (!AppConfig._instance) {
      AppConfig._instance = new AppConfig();
    }
    return AppConfig._instance;
  }

  private readonly store: ConfigStore;

  private constructor() {
    this.store = createDefaultConfigStore();
    this._init();
  }

  private _init(): void {
    const globalPath = path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? '.',
      '.h', 'config.json'
    );

    // Seed global config from .env / .env.example defaults.
    // Use exclusive create ({ flag: 'wx' }) to avoid TOCTOU race:
    // if the file already exists (created by another process),
    // we silently skip — its content is already valid.
    const defaults = getDefaults();
    const seedConfig: RawConfig = {
      ...defaults,
      version: 1,
      updatedAt: new Date().toISOString(),
    };

    try {
      fs.writeFileSync(globalPath, JSON.stringify(seedConfig, null, 2), {
        flag: 'wx',
      });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      // File was created by another process — skip seeding.
    }

    // Load all scopes into memory (including the seeded global config)
    this.store.load();
  }

  /** Get a raw value from the merged config. */
  get(key: string): unknown {
    return this.store.get()[key];
  }

  getString(key: string, fallback?: string): string | undefined {
    const val = this.store.get()[key];
    if (val === undefined) return fallback;
    return String(val);
  }

  getInt(key: string, fallback?: number): number {
    const val = this.store.get()[key];
    if (val === undefined) return fallback ?? 0;
    return parseInt(String(val), 10);
  }

  getFloat(key: string, fallback?: number): number {
    const val = this.store.get()[key];
    if (val === undefined) return fallback ?? 0;
    return parseFloat(String(val));
  }
}

// ---------------------------------------------------------------------------
// GuardrailConfigManager — domain layer built on ConfigStore
// ---------------------------------------------------------------------------

export interface DirectoryPermission {
  dir: string;
  access: 'allow' | 'deny';
}

/** Normalise a path to its canonical absolute form. */
export function normalizeDir(dir: string): string {
  try {
    return fs.realpathSync(dir) ?? path.resolve(dir);
  } catch {
    return path.resolve(dir);
  }
}

const PERMISSIONS_KEY = 'directoryPermissions';

export class GuardrailConfigManager {
  private store: ConfigStore;

  constructor(store: ConfigStore) {
    this.store = store;
    this.store.load();
  }

  /** Get all directory permissions (merged, deduplicated). */
  listPermissions(): DirectoryPermission[] {
    const raw = this.store.get() as RawConfig & { [PERMISSIONS_KEY]?: DirectoryPermission[] };
    const perms = raw[PERMISSIONS_KEY] ?? [];
    // Deduplicate by dir, last wins.
    const seen = new Map<string, DirectoryPermission>();
    for (const p of perms) seen.set(p.dir, p);
    return Array.from(seen.values());
  }

  /** Set a directory permission at the given scope and persist immediately. */
  setPermission(dir: string, access: 'allow' | 'deny'): void {
    const normalized = normalizeDir(dir);
    const raw = this.store.get() as RawConfig & { [PERMISSIONS_KEY]?: DirectoryPermission[] };
    const perms = [...(raw[PERMISSIONS_KEY] ?? [])];

    const idx = perms.findIndex(p => p.dir === normalized);
    if (idx >= 0) {
      perms[idx] = { dir: normalized, access };
    } else {
      perms.push({ dir: normalized, access });
    }

    this.store.set({ ...raw, [PERMISSIONS_KEY]: perms }, 'project');
    this.store.save('project');
  }

  /** Remove a directory permission and persist immediately. */
  removePermission(dir: string): void {
    const normalized = normalizeDir(dir);
    const raw = this.store.get() as RawConfig & { [PERMISSIONS_KEY]?: DirectoryPermission[] };
    const perms = (raw[PERMISSIONS_KEY] ?? []).filter(p => p.dir !== normalized);

    this.store.set({ ...raw, [PERMISSIONS_KEY]: perms }, 'project');
    this.store.save('project');
  }

  /** Check whether a directory is allowed, denied, or neutral. */
  checkPermission(dir: string): 'allow' | 'deny' | 'neutral' {
    const normalized = normalizeDir(dir);
    const raw = this.store.get() as RawConfig & { [PERMISSIONS_KEY]?: DirectoryPermission[] };
    const perms = raw[PERMISSIONS_KEY] ?? [];

    for (const perm of perms) {
      if (perm.dir === normalized) return perm.access;
      if (normalized.startsWith(perm.dir + path.sep)) return perm.access;
    }

    return 'neutral';
  }

  /** Reload from disk (useful after external changes). */
  reload(): void {
    this.store.load();
  }

  /** Get the raw config for debugging / inspection. */
  getRaw(): RawConfig {
    return this.store.get();
  }
}
