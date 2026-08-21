import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isAllowedConfigPath } from '@domain/Utils/ConfigPathFilter';
import { ObsidianNoteRepository } from '@infrastructure/Obsidian/ObsidianNoteRepository';
import { ObsidianDiskReconciler } from '@application/Sync/ObsidianDiskReconciler';
import { SyncEventBus } from '@application/Sync/SyncEventBus';
import { LoroSyncEngine } from '@infrastructure/Crdt/LoroSyncEngine';

describe('Extension & Theme Settings Sync Suite', () => {
	const configDir = '.obsidian';

	describe('isAllowedConfigPath', () => {
		it('allows regular markdown notes', () => {
			expect(isAllowedConfigPath('Folder/Note.md', configDir)).toBe(true);
		});

		it('excludes workspace.json and workspace-mobile.json', () => {
			expect(isAllowedConfigPath('.obsidian/workspace.json', configDir)).toBe(false);
			expect(isAllowedConfigPath('.obsidian/workspace-mobile.json', configDir)).toBe(false);
		});

		it('handles plugin settings toggle (data.json)', () => {
			const path = '.obsidian/plugins/my-plugin/data.json';
			expect(isAllowedConfigPath(path, configDir, { syncPluginSettings: true })).toBe(true);
			expect(isAllowedConfigPath(path, configDir, { syncPluginSettings: false })).toBe(false);
		});

		it('handles plugin binaries toggle (main.js, manifest.json, styles.css)', () => {
			const mainJs = '.obsidian/plugins/my-plugin/main.js';
			expect(isAllowedConfigPath(mainJs, configDir, { syncPluginBinaries: true })).toBe(true);
			expect(isAllowedConfigPath(mainJs, configDir, { syncPluginBinaries: false })).toBe(false);
		});

		it('handles theme files toggle', () => {
			const themeCss = '.obsidian/themes/my-theme/theme.css';
			expect(isAllowedConfigPath(themeCss, configDir, { syncThemes: true })).toBe(true);
			expect(isAllowedConfigPath(themeCss, configDir, { syncThemes: false })).toBe(false);
		});

		it('handles appearance and core settings toggle', () => {
			const appearance = '.obsidian/appearance.json';
			expect(isAllowedConfigPath(appearance, configDir, { syncAppearance: true })).toBe(true);
			expect(isAllowedConfigPath(appearance, configDir, { syncAppearance: false })).toBe(false);
		});
	});

	describe('ObsidianNoteRepository Adapter Support', () => {
		it('reads and writes configuration files via app.vault.adapter', async () => {
			const mockAdapter = {
				exists: vi.fn().mockResolvedValue(true),
				read: vi.fn().mockResolvedValue('{"setting": "enabled"}'),
				write: vi.fn().mockResolvedValue(undefined),
				mkdir: vi.fn().mockResolvedValue(undefined),
				list: vi.fn().mockResolvedValue({ files: ['.obsidian/appearance.json'], folders: [] })
			};

			const mockApp: any = {
				vault: {
					configDir: '.obsidian',
					adapter: mockAdapter,
					getAbstractFileByPath: vi.fn().mockReturnValue(null),
					getMarkdownFiles: vi.fn().mockReturnValue([])
				}
			};

			const noteRepo = new ObsidianNoteRepository(mockApp);
			const content = await noteRepo.readNote('.obsidian/appearance.json');
			expect(content).toBe('{"setting": "enabled"}');
			expect(mockAdapter.read).toHaveBeenCalledWith('.obsidian/appearance.json');

			await noteRepo.writeNote('.obsidian/appearance.json', '{"setting": "updated"}');
			expect(mockAdapter.write).toHaveBeenCalledWith('.obsidian/appearance.json', '{"setting": "updated"}');

			const allNotes = await noteRepo.listAllNotes();
			expect(allNotes).toContain('.obsidian/appearance.json');
		});
	});

	describe('ObsidianDiskReconciler Hot Reloading', () => {
		it('triggers hot reload when writing config files', async () => {
			const mockCustomCss = { loadManifests: vi.fn() };
			const mockLoadData = vi.fn().mockResolvedValue(undefined);
			const mockPlugins = {
				getPlugin: vi.fn().mockReturnValue({ loadData: mockLoadData })
			};

			const mockAdapter = {
				exists: vi.fn().mockResolvedValue(true),
				read: vi.fn().mockResolvedValue('old-css'),
				write: vi.fn().mockResolvedValue(undefined),
				mkdir: vi.fn().mockResolvedValue(undefined)
			};

			const mockApp: any = {
				vault: {
					configDir: '.obsidian',
					adapter: mockAdapter,
					getAbstractFileByPath: vi.fn().mockReturnValue(null)
				},
				customCss: mockCustomCss,
				plugins: mockPlugins
			};

			const eventBus = new SyncEventBus();
			const syncEngine = new LoroSyncEngine();
			const reconciler = new ObsidianDiskReconciler(mockApp, syncEngine, eventBus);
			reconciler.initialize();

			eventBus.emit('CrdtTextChanged', {
				uuid: 'theme-uuid',
				path: '.obsidian/themes/my-theme/theme.css',
				content: 'new-css'
			});

			await reconciler.onIdle();

			expect(mockAdapter.write).toHaveBeenCalledWith('.obsidian/themes/my-theme/theme.css', 'new-css');
			expect(mockCustomCss.loadManifests).toHaveBeenCalled();

			eventBus.emit('CrdtTextChanged', {
				uuid: 'plugin-data-uuid',
				path: '.obsidian/plugins/sample-plugin/data.json',
				content: '{"k":"v"}'
			});

			await reconciler.onIdle();

			expect(mockPlugins.getPlugin).toHaveBeenCalledWith('sample-plugin');
			expect(mockLoadData).toHaveBeenCalled();
		});
	});
});
