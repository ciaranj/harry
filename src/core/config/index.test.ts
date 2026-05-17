import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { ConfigStore, GuardrailConfigManager, RawConfig, ConfigFileIO, parseEnv } from './index.js';

// ===================================================================
// In-memory ConfigFileIO — zero side effects.
// ===================================================================
function makeInMemoryIO(): ConfigFileIO & { getStore: () => Map<string, string> } {
  const store = new Map<string, string>();

  const io: ConfigFileIO = {
    existsSync(p) { return store.has(p); },
    readFileSync(p, e) { return store.get(p) ?? ''; },
    writeFileSync(p, data, e) { store.set(p, data); },
    mkdirSync() { /* no-op */ },
  };

  return Object.assign(io, { getStore: () => store });
}

function setFile(io: ConfigFileIO & { getStore: () => Map<string, string> }, filePath: string, content: RawConfig | null): void {
  if (content === null) io.getStore().delete(filePath);
  else io.getStore().set(filePath, JSON.stringify(content, null, 2));
}

// ===================================================================
// ConfigStore tests
// ===================================================================
describe('ConfigStore', () => {
  const globalPath = '/fake/home/.h/config.json';
  const projectPath = '/fake/project/.h/config.json';

  function resolver(): (scope: 'global' | 'project') => string {
    return (scope) => scope === 'global' ? globalPath : projectPath;
  }

  let io: ConfigFileIO & { getStore: () => Map<string, string> };

  beforeEach(() => { io = makeInMemoryIO(); });

  it('should start with the initial config for both scopes', () => {
    const store = new ConfigStore({ resolver: resolver(), fileIO: io, initial: { version: 2, foo: 'bar' } });
    expect(store.get()).toEqual(expect.objectContaining({ version: 2, foo: 'bar' }));
    expect(store.get('global')).toEqual(expect.objectContaining({ version: 2, foo: 'bar' }));
    expect(store.get('project')).toEqual(expect.objectContaining({ version: 2, foo: 'bar' }));
  });

  it('should load and migrate each scope independently before merging', () => {
    setFile(io, globalPath, { version: 0, updatedAt: 'now', globalKey: 'global-val' });
    setFile(io, projectPath, { version: 1, updatedAt: 'now', projectKey: 'project-val' });

    const store = new ConfigStore({
      resolver: resolver(), fileIO: io,
      targetVersion: 2,
      migrations: [
        { fromVersion: 0, toVersion: 1, migrate: (raw) => ({ ...raw as Record<string, unknown>, migratedGlobal: true, version: 1 }) },
        { fromVersion: 1, toVersion: 2, migrate: (raw) => ({ ...raw as Record<string, unknown>, migratedAgain: true, version: 2 }) },
      ],
    });

    store.load();

    // Per-scope reads show individual migration results.
    const globalCfg = store.get('global') as RawConfig & { migratedGlobal?: boolean };
    expect(globalCfg.migratedGlobal).toBe(true);
    expect(globalCfg.version).toBe(2);

    const projectCfg = store.get('project') as RawConfig & { migratedAgain?: boolean };
    expect(projectCfg.migratedAgain).toBe(true);
    expect(projectCfg.version).toBe(2);

    // Merged view combines both.
    const merged = store.get();
    expect(merged.globalKey).toBe('global-val');
    expect(merged.projectKey).toBe('project-val');
  });

  it('should save to the specified scope', () => {
    const store = new ConfigStore({ resolver: resolver(), fileIO: io });
    store.set({ version: 1, hello: 'world' }, 'global');
    store.save('global');

    const cfg = JSON.parse(io.getStore().get(globalPath)!);
    expect(cfg.hello).toBe('world');
    // Project scope should not have been written.
    expect(io.getStore().has(projectPath)).toBe(false);
  });

  it('should default save to project scope', () => {
    const store = new ConfigStore({ resolver: resolver(), fileIO: io });
    store.set({ version: 1, hello: 'world' }, 'project');
    store.save(); // no scope arg

    const cfg = JSON.parse(io.getStore().get(projectPath)!);
    expect(cfg.hello).toBe('world');
  });

  it('should merge with project overriding global', () => {
    setFile(io, globalPath, { version: 1, updatedAt: 'now', a: 1, shared: 'global' });
    setFile(io, projectPath, { version: 1, updatedAt: 'now', b: 2, shared: 'project' });

    const store = new ConfigStore({ resolver: resolver(), fileIO: io });
    store.load();

    const merged = store.get();
    expect(merged.a).toBe(1);
    expect(merged.b).toBe(2);
    expect(merged.shared).toBe('project'); // project wins
  });

  it('should deep-merge nested objects, preserving keys from global', () => {
    setFile(io, globalPath, {
      version: 1, updatedAt: 'now',
      tools: { readFiles: true, writeToFile: true },
      nested: { deep: { key: 'global' } },
    });
    setFile(io, projectPath, {
      version: 1, updatedAt: 'now',
      tools: { writeToFile: false },
      nested: { deep: { other: true } },
    });

    const store = new ConfigStore({ resolver: resolver(), fileIO: io });
    store.load();

    const merged = store.get();
    const tools = merged.tools as Record<string, unknown>;
    expect(tools.readFiles).toBe(true);        // preserved from global
    expect(tools.writeToFile).toBe(false);      // overridden by project
    const deep = merged.nested?.deep as Record<string, unknown>;
    expect(deep.key).toBe('global');            // preserved from global
    expect(deep.other).toBe(true);              // added by project
  });

  it('should not deep-merge arrays — project array replaces global array', () => {
    setFile(io, globalPath, {
      version: 1, updatedAt: 'now',
      arr: [1, 2, 3],
    });
    setFile(io, projectPath, {
      version: 1, updatedAt: 'now',
      arr: [4],
    });

    const store = new ConfigStore({ resolver: resolver(), fileIO: io });
    store.load();

    const merged = store.get();
    expect(merged.arr).toEqual([4]);
  });

  it('should handle missing scopes gracefully', () => {
    const store = new ConfigStore({ resolver: resolver(), fileIO: io });
    store.load();

    // No files exist — each scope retains its constructor-initialized defaults.
    expect(store.get()).toEqual(expect.objectContaining({ updatedAt: expect.any(String) }));
    expect(store.get('global')).toEqual(expect.objectContaining({ updatedAt: expect.any(String) }));
    expect(store.get('project')).toEqual(expect.objectContaining({ updatedAt: expect.any(String) }));
  });

  it('should skip migration when scope is already at target version', () => {
    setFile(io, projectPath, { version: 1, data: 'kept' });

    const store = new ConfigStore({
      resolver: resolver(), fileIO: io,
      targetVersion: 1,
      migrations: [{ fromVersion: 0, toVersion: 1, migrate: (raw) => ({ ...raw as Record<string, unknown>, migrated: true }) }],
    });

    store.load();
    const projectCfg = store.get('project') as Record<string, unknown>;
    expect(projectCfg.migrated).toBeUndefined();
  });
});

// ===================================================================
// parseEnv tests
// ===================================================================
describe('parseEnv', () => {
  it('should parse simple KEY=VALUE pairs', () => {
    const result = parseEnv('KEY=value');
    expect(result).toEqual({ KEY: 'value' });
  });

  it('should strip inline comments from unquoted values', () => {
    const result = parseEnv('KEY=value # comment');
    expect(result).toEqual({ KEY: 'value' });
  });

  it('should preserve # inside quoted values', () => {
    const result = parseEnv('KEY="value with # hash"');
    expect(result).toEqual({ KEY: 'value with # hash' });
  });

  it('should strip inline comments after closing quote', () => {
    const result = parseEnv('KEY="value"#comment');
    expect(result).toEqual({ KEY: 'value' });
  });

  it('should NOT strip quotes from unclosed quotes (fix for issue #1)', () => {
    const result = parseEnv('KEY="unclosed');
    // Before fix: value would be "nclosed" (slice(1,-1) on "unclosed)
    // After fix: value stays as "unclosed" (no stripping without closing quote)
    expect(result).toEqual({ KEY: '"unclosed' });
  });

  it('should handle empty quoted value', () => {
    const result = parseEnv('KEY=""');
    expect(result).toEqual({ KEY: '' });
  });

  it('should handle quoted value with trailing whitespace', () => {
    const result = parseEnv('KEY="value"   ');
    expect(result).toEqual({ KEY: 'value' });
  });

  it('should skip lines without equals sign', () => {
    const result = parseEnv('NOEQUALS');
    expect(result).toEqual({});
  });

  it('should skip export prefix', () => {
    const result = parseEnv('export KEY=value');
    expect(result).toEqual({ KEY: 'value' });
  });
});

// ===================================================================
// GuardrailConfigManager tests — injects a ConfigStore with in-memory I/O
// ===================================================================
describe('GuardrailConfigManager', () => {
  const projectCwd = '/fake/project';
  const globalHome = '/fake/home';

  let io: ConfigFileIO & { getStore: () => Map<string, string> };

  beforeEach(() => { io = makeInMemoryIO(); });

  function makeStore(): ConfigStore {
    const resolver: (scope: 'global' | 'project') => string = (scope) => {
      if (scope === 'global') return path.join(globalHome, '.h', 'config.json');
      return path.join(projectCwd, '.h', 'config.json');
    };
    return new ConfigStore({ resolver, fileIO: io, targetVersion: 1 });
  }

  function createManager(): GuardrailConfigManager {
    return new GuardrailConfigManager(makeStore());
  }

  it('should start with empty permissions', () => {
    expect(createManager().listPermissions()).toHaveLength(0);
  });

  it('should set and read a permission', () => {
    const mgr = createManager();
    mgr.setPermission('/some/dir', 'allow');

    // Verify the file was written (in-memory).
    const savedPath = path.join(projectCwd, '.h', 'config.json');
    expect(io.getStore().has(savedPath)).toBe(true);

    const perms = mgr.listPermissions();
    expect(perms).toHaveLength(1);
    expect(perms[0].dir).toBe(path.resolve('/some/dir'));
    expect(perms[0].access).toBe('allow');
  });

  it('should check permissions with prefix match', () => {
    setFile(io, path.join(projectCwd, '.h', 'config.json'), {
      version: 1, updatedAt: 'now', directoryPermissions: [
        { dir: path.resolve('/base'), access: 'deny' as const },
      ],
    });

    const mgr = createManager();
    mgr.reload();

    expect(mgr.checkPermission('/base')).toBe('deny');
    expect(mgr.checkPermission('/base/sub/deep')).toBe('deny');
    expect(mgr.checkPermission('/other')).toBe('neutral');
  });

  it('should remove a permission', () => {
    setFile(io, path.join(projectCwd, '.h', 'config.json'), {
      version: 1, updatedAt: 'now', directoryPermissions: [
        { dir: path.resolve('/some/dir'), access: 'allow' as const },
      ],
    });

    const mgr = createManager();
    mgr.reload();

    mgr.removePermission('/some/dir');
    expect(mgr.listPermissions()).toHaveLength(0);
  });

  it('should deduplicate permissions (last wins)', () => {
    setFile(io, path.join(projectCwd, '.h', 'config.json'), {
      version: 1, updatedAt: 'now', directoryPermissions: [
        { dir: path.resolve('/dup'), access: 'deny' as const },
        { dir: path.resolve('/dup'), access: 'allow' as const },
      ],
    });

    const mgr = createManager();
    mgr.reload();

    expect(mgr.listPermissions()).toHaveLength(1);
    expect(mgr.listPermissions()[0].access).toBe('allow');
  });

 it('should persist and reload from disk', () => {
    const store = makeStore();
    const mgr = new GuardrailConfigManager(store);

    // Write a permission via the manager.
    mgr.setPermission('/persisted', 'allow');

    // Verify the file was written to the in-memory IO.
    const savedPath = path.join(projectCwd, '.h', 'config.json');
    expect(io.getStore().has(savedPath)).toBe(true);
    const written = JSON.parse(io.getStore().get(savedPath)!);
    expect(written.directoryPermissions).toHaveLength(1);

    // Reload the SAME manager — should pick up the persisted data.
    mgr.reload();
    expect(mgr.listPermissions()).toHaveLength(1);
    expect(mgr.checkPermission('/persisted')).toBe('allow');
  });

  it('should survive a fresh store reading from the same IO', () => {
    const store = makeStore();
    const mgr1 = new GuardrailConfigManager(store);
    mgr1.setPermission('/cross', 'deny');

    // Confirm data is in the shared IO.
    const savedPath = path.join(projectCwd, '.h', 'config.json');
    expect(io.getStore().has(savedPath)).toBe(true);
    const storedContent = io.getStore().get(savedPath)!;
    const parsed = JSON.parse(storedContent);
    expect(parsed.directoryPermissions).toHaveLength(1);

    // Create a brand-new store pointing at the same in-memory IO.
    const store2 = makeStore();
    const mgr2 = new GuardrailConfigManager(store2);

    // Verify it loaded the persisted data from the shared IO.
    expect(mgr2.listPermissions()).toHaveLength(1);
    expect(mgr2.checkPermission('/cross')).toBe('deny');
  });
});
