import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';

  return {
    css: {
      postcss: {
        plugins: [],
      },
    },

    test: {
      environment: 'jsdom',
      setupFiles: ['./tests/setup.ts'],
      globals: true,
      pool: 'forks'
    },

    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: isDev ? 'inline' : false,
      minify: !isDev,

      lib: {
        entry: path.resolve(__dirname, 'src/4_Presentation/Plugin.ts'),
        formats: ['cjs'],
        fileName: () => 'main.js',
      },

      rollupOptions: {
        external: [
          'obsidian',
          'electron',
          '@codemirror/autocomplete',
          '@codemirror/collab',
          '@codemirror/commands',
          '@codemirror/language',
          '@codemirror/lint',
          '@codemirror/search',
          '@codemirror/state',
          '@codemirror/view',
          '@lezer/common',
          '@lezer/highlight',
          '@lezer/lr',
        ],
        output: {
          entryFileNames: 'main.js',
          assetFileNames: 'styles.css',
          exports: 'default',
        },
      },
    },

    resolve: {
      alias: {
        '@domain': path.resolve(__dirname, 'src/1_Domain'),
        '@application': path.resolve(__dirname, 'src/2_Application'),
        '@infrastructure': path.resolve(__dirname, 'src/3_Infrastructure'),
        '@presentation': path.resolve(__dirname, 'src/4_Presentation'),
        ...(process.env.VITEST ? { 'obsidian': path.resolve(__dirname, 'tests/setup.ts') } : {})
      },
    },
  };
});