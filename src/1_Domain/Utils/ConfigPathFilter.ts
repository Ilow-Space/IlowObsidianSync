import { PluginSettings } from '@presentation/Plugin';

export function isAllowedConfigPath(
	path: string,
	configDir: string = '.obsidian',
	settings?: Partial<PluginSettings>
): boolean {
	const normalizedConfigDir = configDir.replace(/^\/+|\/+$/g, '') || '.obsidian';

	// If path doesn't start with configDir
	if (!path.startsWith(normalizedConfigDir + '/') && path !== normalizedConfigDir) {
		// Non-hidden files are allowed
		if (!path.startsWith('.') && !path.includes('/.')) {
			return true;
		}
		return false;
	}

	const relPath = path === normalizedConfigDir ? '' : path.substring(normalizedConfigDir.length + 1);

	// Exclude device-specific state
	if (
		relPath === 'workspace.json' ||
		relPath === 'workspace-mobile.json' ||
		relPath.endsWith('/workspace.json') ||
		relPath.endsWith('/workspace-mobile.json')
	) {
		return false;
	}

	// Folder chain under configDir itself
	if (relPath === '' || relPath === 'plugins' || relPath === 'themes') {
		return true;
	}

	// Core Settings
	if (
		relPath === 'appearance.json' ||
		relPath === 'community-plugins.json' ||
		relPath === 'hotkeys.json'
	) {
		return settings?.syncAppearance !== false;
	}

	// Themes: themes/<theme-name>/**
	if (relPath.startsWith('themes/')) {
		return settings?.syncThemes !== false;
	}

	// Plugins: plugins/<plugin-id>/...
	if (relPath.startsWith('plugins/')) {
		const parts = relPath.split('/');
		// parts[0] = 'plugins', parts[1] = plugin-id, parts[2] = file
		if (parts.length === 2) {
			// Folder node for plugin: plugins/<plugin-id>
			return true;
		}

		const fileName = parts.slice(2).join('/');
		if (fileName === 'data.json') {
			return settings?.syncPluginSettings !== false;
		}
		if (fileName === 'main.js' || fileName === 'manifest.json' || fileName === 'styles.css') {
			return settings?.syncPluginBinaries === true;
		}
	}

	return false;
}
