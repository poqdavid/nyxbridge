import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outdir = 'module/webroot/js';

rmSync(`${root}/${outdir}`, { recursive: true, force: true });

await build({
	absWorkingDir: root,
	entryPoints: ['webui/src/app.ts'],
	outfile: `${outdir}/app.js`,
	bundle: true,
	format: 'esm',
	target: 'es2020',
	charset: 'utf8',
	legalComments: 'none',
	banner: { js: '// NyxBridge WebUI, built from webui/src (TypeScript). Source: https://github.com/poqdavid/nyxbridge' },
	logLevel: 'warning',
});
