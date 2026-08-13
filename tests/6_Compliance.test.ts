import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { jscpd } from 'jscpd';

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

	it('Enforces DRY (Zero Code Duplication)', async () => {
		const duplicates = await jscpd({
			path: ['src'],
			minLines: 5,
			minTokens: 50,
			silent: true
		});

		expect(duplicates.length, 'Duplicate code blocks found! Refactor to satisfy DRY.').toBe(0);
	});
});