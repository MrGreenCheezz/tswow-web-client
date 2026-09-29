import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Test the current TypeScript through existing dist/code import paths without emitting JS or
// generating client data. Pair with tsc --noEmit: transpilation alone does not check types.
// Local ignored protocol/client metadata must already be available, just as for a normal build.
const dist = new URL('../dist/code/', import.meta.url).href;
const src = new URL('../src/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && (specifier.startsWith('.') || specifier.startsWith('file:'))) {
      const url = new URL(specifier, context.parentURL).href;
      if (url.startsWith(dist) && url.endsWith('.js') &&
          existsSync(fileURLToPath(src + url.slice(dist.length).replace(/\.js$/, '.ts')))) {
        return { url, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(dist) && url.endsWith('.js')) {
      const sourceUrl = src + url.slice(dist.length).replace(/\.js$/, '.ts');
      const sourcePath = fileURLToPath(sourceUrl);
      if (existsSync(sourcePath)) {
        const result = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
          fileName: sourcePath,
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
        });
        return { format: 'module', source: result.outputText, shortCircuit: true };
      }
    }
    return nextLoad(url, context);
  },
});
