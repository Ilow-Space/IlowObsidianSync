import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';

describe('Architecture & Design Compliance Suite', () => {
	it('Enforces DDD Layering, SOLID, & Linus Torvalds 3-Tab Rules', async () => {
		const eslint = new ESLint();
		const results = await eslint.lintFiles(['src/**/*.ts']);
		
		const formatter = await eslint.loadFormatter('stylish');
		const resultText = await formatter.format(results);

		const totalErrors = results.reduce((acc, curr) => acc + curr.errorCount, 0);
		
		if (totalErrors > 0) {
			console.error(resultText);
		}

		expect(totalErrors, 'Architecture or Linus 3-tab rule violations found!').toBe(0);
	});

	it('Enforces no deprecated display() implementation in SettingsTab for Obsidian 1.13+ compliance', async () => {
		const fs = await import('node:fs');
		const content = fs.readFileSync('src/4_Presentation/SettingsTab.ts', 'utf-8');
		const hasDisplayMethod = /^\s*(override\s+|public\s+)?display\s*\(\s*\)\s*:/m.test(content);
		expect(hasDisplayMethod, 'SettingsTab implements deprecated display() method! Use getSettingDefinitions() instead.').toBe(false);
	});

    // Note: The jscpd duplication check has been shifted strictly to the `npm run dry` CLI
    // step in package.json to prevent Vite module resolution failures in simulated DOMs.
});