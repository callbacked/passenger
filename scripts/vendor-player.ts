import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchPlayer } from './patch-player.ts';

interface Asset {
  path: string;
  url: string;
  sha256: string;
}

interface VendoredFile {
  path: string;
  data: Buffer;
  sha256: string;
  source: string;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDirectory = join(root, 'node_modules/@libmedia/avplayer');
const destination = join(root, 'public/vendor/avplayer');
const version = '1.3.1';
// The npm release's gitHead also identifies its matching decoder ABI.
const revision = '152f629d3021fd8013efa464fcb7b55f9fbe7753';
const upstream = `https://raw.githubusercontent.com/zhaohappy/libmedia/${revision}`;

const wasm = [
  ['decode/h264.wasm', 'b74abea1d814b89dd66d5072f9e0845db6d6b05102536560ed6141025d602120'],
  ['decode/aac.wasm', '9cbef85899775c7431dfffbd704d30fa185089f1f4280e2ea90be07e40b635c8'],
  ['decode/vp9.wasm', '71ce0ca267d3adf3048352a93e0146a13c32bb7f95a2243f4d11bf6f95942f15'],
  ['decode/opus.wasm', '9c0ca5f7d22fe0d2557b6cb075a48dd3c3c1295dd1da0f7ef7dd36f8071d9235'],
  ['resample/resample.wasm', '7709e04280d6f9487872cbcfbffa747032aaa5e45a72849a1aaceb05259b347d'],
  ['stretchpitch/stretchpitch.wasm', '9397d474f85fbf3d0bc6b5b78bb500d0329a7a2c4ce212c8531cd56514434a7a'],
].map(([path, sha256]) => ({ path: `wasm/${path}`, url: `${upstream}/dist/${path}`, sha256 }));

const licenses = [
  ['COPYING.LGPLv3', `${upstream}/COPYING.LGPLv3`, 'ea8af5e789cb2d4e9b10bce3874982ade163b749b6bfbdb32e2df21c4d106de1'],
  ['COPYING.GPLv3', 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.0/COPYING.GPLv3', '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'],
  ['COPYING.LGPLv2.1', 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.0/COPYING.LGPLv2.1', 'b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe'],
  ['common-MIT.txt', 'https://raw.githubusercontent.com/zhaohappy/common/00c9c3c481cf7c53ed252cec6ca2dc6e9732ea28/LICENSE', 'fdeb424d242a713fb3e5034fbd4e505a8d7622f0bfcd0617c00770423948a54e'],
  ['cheap-MIT.txt', 'https://raw.githubusercontent.com/zhaohappy/cheap/85cc79e032cbd417e3bb4a218bdf26da537b970b/LICENSE', 'fdeb424d242a713fb3e5034fbd4e505a8d7622f0bfcd0617c00770423948a54e'],
  ['libvpx-LICENSE.txt', 'https://raw.githubusercontent.com/webmproject/libvpx/v1.14.0/LICENSE', '8267348d5af1262c11d1a08de2f5afc77457755f1ac658627dd9acf71011d615'],
  ['libvpx-PATENTS.txt', 'https://raw.githubusercontent.com/webmproject/libvpx/v1.14.0/PATENTS', 'cc3273e0694ea5896145e0677699b53471b03ea43021ddc50e7923fbb9f5023c'],
  ['assjs-MIT.txt', 'https://raw.githubusercontent.com/weizhenye/ASS/v0.1.4/LICENSE', '974299957766f1c4a9d17931bff936598e7f8a03d6aacf861771400a4f4850a0'],
  ['ass-compiler-MIT.txt', 'https://raw.githubusercontent.com/weizhenye/ass-compiler/v0.1.15/LICENSE', 'fdcbadae050202e76ec7ce4c6fbec5f13640cfb4bb868ffe4de775b7e37f584b'],
].map(([path, url, sha256]) => ({ path: `licenses/${path}`, url, sha256 }));

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

async function download(asset: Asset): Promise<Asset & { data: Buffer }> {
  try {
    const cached = await readFile(join(destination, asset.path));
    if (sha256(cached) === asset.sha256) return { ...asset, data: cached };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${asset.path}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (sha256(data) !== asset.sha256) throw new Error(`${asset.path}: SHA-256 mismatch`);
  return { ...asset, data };
}

async function main() {
  const metadata = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
  if (metadata.name !== '@libmedia/avplayer' || metadata.version !== version) {
    throw new Error(`Expected @libmedia/avplayer@${version}; run npm ci with the committed lockfile.`);
  }

  const bundleDirectory = join(packageDirectory, 'dist/umd');
  const names = (await readdir(bundleDirectory)).filter((name) => /^(?:\d+\.)?avplayer\.js$/.test(name)).sort();
  if (!names.includes('avplayer.js') || names.length !== 32) {
    throw new Error('The pinned AVPlayer release must contain its main UMD bundle and 31 dynamic chunks.');
  }
  const files: VendoredFile[] = [];
  for (const name of names) {
    const original = await readFile(join(bundleDirectory, name));
    const data = name === 'avplayer.js' ? Buffer.from(patchPlayer(original.toString('utf8'))) : original;
    files.push({ path: name, data, sha256: sha256(data), source: `@libmedia/avplayer@${version}/dist/umd/${name}` });
  }

  // Validate every network response before replacing the previously usable assets.
  const results = await Promise.allSettled([...wasm, ...licenses].map(download));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Player assets could not be verified');
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { url, ...file } = result.value;
    files.push({ ...file, source: url });
  }
  const notes = await readFile(join(root, 'docs/player-licenses.md'));
  files.push({ path: 'SOURCES.md', data: notes, sha256: sha256(notes), source: 'docs/player-licenses.md' });
  const patch = await readFile(join(root, 'scripts/patch-player.ts'));
  files.push({ path: 'patch-player.ts', data: patch, sha256: sha256(patch), source: 'scripts/patch-player.ts' });

  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), '.avplayer-'));
  try {
    for (const file of files) {
      const target = join(staging, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.data);
    }
    await writeFile(join(staging, 'manifest.json'), JSON.stringify({
      package: metadata.name,
      version,
      revision,
      variant: 'baseline-wasm32',
      patches: ['ID3-prefixed HLS AAC format detection (patch-player.ts)', 'Ignore IPC replies after cancellation closes the port (patch-player.ts)'],
      files: files.map(({ path, sha256: digest, source, data }) => ({ path, sha256: digest, bytes: data.length, source })),
    }, null, 2) + '\n');
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const bytes = files.reduce((total, file) => total + file.data.length, 0);
  console.log(`Prepared AVPlayer ${version}: ${files.length} verified files, ${(bytes / 1024 / 1024).toFixed(2)} MiB in public/vendor/avplayer.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
