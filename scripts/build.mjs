// Bundles the Preact frontend (src/main.jsx) into public/dist/ with esbuild.
// Usage: node scripts/build.mjs [--watch]
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetVersion } from '../server/static.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'public/dist');
const fontsOut = path.join(outdir, 'fonts');
const watch = process.argv.includes('--watch');

// Only the latin + latin-ext subsets of the variable-weight faces are shipped.
const FONT_SOURCES = [
  { pkg: '@fontsource-variable/inter', css: ['wght.css', 'wght-italic.css'] },
  { pkg: '@fontsource-variable/jetbrains-mono', css: ['wght.css'] },
];
const SUBSET = /-(latin|latin-ext)-wght-(normal|italic)$/;
// Faces kept in the repo (src/fonts/; not in node_modules): Source Serif 4 (OFL 1.1,
// fontsource 5.3.1, latin), the serif of headings and the new-session greeting.
const VENDORED_FONTS = [
  { family: 'Source Serif 4 Variable', file: 'source-serif-4-latin-wght-normal.woff2', style: 'normal' },
  { family: 'Source Serif 4 Variable', file: 'source-serif-4-latin-wght-italic.woff2', style: 'italic' },
];
const LATIN_RANGE =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

// Reads the fontsource CSS, keeps the wanted @font-face blocks, copies their
// woff2 files into public/dist/fonts/ and returns CSS pointing at the copies.
async function buildFontCss() {
  await fs.mkdir(fontsOut, { recursive: true });
  const rules = [];
  for (const source of FONT_SOURCES) {
    const pkgDir = path.join(root, 'node_modules', source.pkg);
    for (const file of source.css) {
      const css = await fs.readFile(path.join(pkgDir, file), 'utf8');
      for (const [, name, block] of css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)) {
        if (!SUBSET.test(name)) continue;
        const url = block.match(/url\(\.\/files\/([^)]+)\)/)?.[1];
        if (!url) continue;
        await fs.copyFile(path.join(pkgDir, 'files', url), path.join(fontsOut, url));
        // The content hash lets the server cache the font for a year (see server/static.mjs).
        const version = assetVersion(await fs.readFile(path.join(fontsOut, url)));
        rules.push(`/* ${name} */\n` + block.replace(/url\(\.\/files\/([^)]+)\)/, `url(./fonts/$1?v=${version})`));
      }
    }
  }
  for (const font of VENDORED_FONTS) {
    await fs.copyFile(path.join(root, 'src/fonts', font.file), path.join(fontsOut, font.file));
    const version = assetVersion(await fs.readFile(path.join(fontsOut, font.file)));
    rules.push(
      `@font-face {\n  font-family: '${font.family}';\n  font-style: ${font.style};\n  font-display: swap;\n  font-weight: 200 900;\n` +
        `  src: url(./fonts/${font.file}?v=${version}) format('woff2-variations');\n  unicode-range: ${LATIN_RANGE};\n}`,
    );
  }
  if (!rules.length) throw new Error('No font faces matched; check @fontsource-variable packages');
  return rules.join('\n');
}

// `import 'harbor:fonts'` in main.jsx resolves to the generated @font-face rules.
function fontsPlugin(fontCss) {
  return {
    name: 'harbor-fonts',
    setup(build) {
      build.onResolve({ filter: /^harbor:fonts$/ }, () => ({ path: 'fonts.css', namespace: 'harbor-fonts' }));
      // The copied fonts, linked with their version (not bundled).
      build.onResolve({ filter: /^\.\/fonts\/[^?]+\.woff2\?v=\w+$/ }, (args) => ({ path: args.path, external: true }));
      build.onLoad({ filter: /.*/, namespace: 'harbor-fonts' }, () => ({ contents: fontCss, loader: 'css' }));
    },
  };
}

function reportPlugin() {
  return {
    name: 'report',
    setup(build) {
      let started = 0;
      build.onStart(() => { started = Date.now(); });
      build.onEnd(async (result) => {
        if (result.errors.length) return;
        const files = await fs.readdir(outdir);
        const sizes = await Promise.all(files.filter((f) => /\.(js|css)$/.test(f)).map(async (f) => {
          const { size } = await fs.stat(path.join(outdir, f));
          return `${f} ${(size / 1024).toFixed(1)} kB`;
        }));
        console.log(`built in ${Date.now() - started} ms: ${sizes.join(', ')}`);
      });
    },
  };
}

// KaTeX (src/vendor/katex/): its own bundle, stylesheet and fonts, which
// src/lib/typeset.js loads with the first math. Returns their versioned URLs.
async function buildKatex() {
  const from = path.join(root, 'src/vendor/katex');
  const to = path.join(outdir, 'katex');
  await fs.mkdir(path.join(to, 'fonts'), { recursive: true });
  await fs.copyFile(path.join(from, 'katex.css'), path.join(to, 'katex.css'));
  for (const font of await fs.readdir(path.join(from, 'fonts'))) {
    await fs.copyFile(path.join(from, 'fonts', font), path.join(to, 'fonts', font));
  }
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['src/lib/katexEntry.js'],
    outfile: path.join(to, 'katex.js'),
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2022',
    legalComments: 'none',
    logLevel: 'warning',
  });
  const url = async (file) => `/dist/katex/${file}?v=${assetVersion(await fs.readFile(path.join(to, file)))}`;
  return { js: await url('katex.js'), css: await url('katex.css') };
}

await fs.rm(outdir, { recursive: true, force: true });
const fontCss = await buildFontCss();
const katexAssets = await buildKatex();

const options = {
  absWorkingDir: root,
  entryPoints: { app: 'src/main.jsx' },
  outdir,
  bundle: true,
  format: 'esm',
  minify: !watch,
  sourcemap: true,
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  external: ['*.woff2'],
  legalComments: 'none',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'), __KATEX_ASSETS__: JSON.stringify(katexAssets) },
  plugins: [fontsPlugin(fontCss), reportPlugin()],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching src/ for changes…');
} else {
  await esbuild.build(options);
}
