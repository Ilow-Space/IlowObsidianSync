import { PluginSettings } from '@presentation/Plugin';

function isSelfPluginPath(relPath: string): boolean {
	return (
		relPath.startsWith('plugins/ilow-sync/') ||
		relPath === 'plugins/ilow-sync' ||
		relPath.startsWith('plugins/obsidian-ilow-')
	);
}

function isWorkspacePath(relPath: string): boolean {
	return (
		relPath === 'workspace.json' ||
		relPath === 'workspace-mobile.json' ||
		relPath.endsWith('/workspace.json') ||
		relPath.endsWith('/workspace-mobile.json')
	);
}

function isCoreSettingsPath(relPath: string): boolean {
	return (
		relPath === 'appearance.json' ||
		relPath === 'community-plugins.json' ||
		relPath === 'hotkeys.json'
	);
}

function checkPluginPath(relPath: string, settings?: Partial<PluginSettings>): boolean {
	const parts = relPath.split('/');
	if (parts.length === 2) {
		return true;
	}
	const fileName = parts.slice(2).join('/');
	if (fileName === 'data.json') {
		return settings?.syncPluginSettings !== false;
	}
	if (fileName === 'main.js' || fileName === 'manifest.json' || fileName === 'styles.css') {
		return settings?.syncPluginBinaries === true;
	}
	return false;
}

export function isAllowedConfigPath(
	path: string,
	configDir: string = '.obsidian',
	settings?: Partial<PluginSettings>
): boolean {
	const normalizedConfigDir = configDir.replace(/^\/+|\/+$/g, '') || '.obsidian';

	if (!path.startsWith(normalizedConfigDir + '/') && path !== normalizedConfigDir) {
		return !path.startsWith('.') && !path.includes('/.');
	}

	const relPath = path === normalizedConfigDir ? '' : path.substring(normalizedConfigDir.length + 1);

	if (isSelfPluginPath(relPath) || isWorkspacePath(relPath)) {
		return false;
	}

	if (relPath === '' || relPath === 'plugins' || relPath === 'themes') {
		return true;
	}

	if (isCoreSettingsPath(relPath)) {
		return settings?.syncAppearance !== false;
	}

	if (relPath.startsWith('themes/')) {
		return settings?.syncThemes !== false;
	}

	if (relPath.startsWith('plugins/')) {
		return checkPluginPath(relPath, settings);
	}

	return false;
}
