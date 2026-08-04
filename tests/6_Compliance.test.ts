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

    // Note: The jscpd duplication check has been shifted strictly to the `npm run dry` CLI
    // step in package.json to prevent Vite module resolution failures in simulated DOMs.
});