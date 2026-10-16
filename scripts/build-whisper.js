#!/usr/bin/env node
'use strict';

// Builds whisper.cpp's `whisper-server` from a pinned release tag into
// vendor/whisper/ (packaged as an extraResource). CPU build, static, no
// OpenMP / MSVC runtime DLLs, so the Windows exe runs on a locked-down laptop
// without the VC++ redistributable. macOS keeps Metal (embedded shaders).
//
//   node scripts/build-whisper.js     (needs Node 18+, cmake, tar and a C++ compiler)

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TAG = 'v1.9.5';
const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'vendor', 'whisper-build');
const SRC = path.join(WORK, `whisper.cpp-${TAG.slice(1)}`);
const OUT = path.join(ROOT, 'vendor', 'whisper');
const EXE = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
// Windows compiler: `clangcl` (default) or `msvc` (CALLREC_WHISPER_TOOLCHAIN, for the CI comparison).
const TOOLCHAIN = process.platform === 'win32' ? (process.env.CALLREC_WHISPER_TOOLCHAIN || 'clangcl') : 'default';

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

async function fetchSource() {
  if (fs.existsSync(path.join(SRC, 'CMakeLists.txt'))) return;
  fs.mkdirSync(WORK, { recursive: true });
  const url = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${TAG}.tar.gz`;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const tgz = path.join(WORK, `${TAG}.tar.gz`);
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  run('tar', ['-xzf', path.basename(tgz)], { cwd: WORK }); // bsdtar ships with Windows 10+
}

function cmakeFlags() {
  const f = [
    '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF',
    '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=ON', '-DWHISPER_BUILD_SERVER=ON',
    '-DWHISPER_SDL2=OFF', '-DWHISPER_CURL=OFF',
  ];
  if (process.platform === 'darwin') {
    f.push('-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON', '-DGGML_NATIVE=OFF');
  } else {
    // Portable x64 CPU build: AVX2/FMA (every laptop CPU since ~2013), not the build machine's -march=native.
    f.push('-DGGML_NATIVE=OFF', '-DGGML_AVX=ON', '-DGGML_AVX2=ON', '-DGGML_FMA=ON', '-DGGML_F16C=ON');
  }
  if (process.platform === 'win32') {
    // clang-cl (Visual Studio's bundled LLVM): ggml's x86 kernels compile much
    // better than under MSVC. Same static CRT, so still no redistributable.
    if (TOOLCHAIN === 'clangcl') f.push('-T', 'ClangCL');
    f.push('-DGGML_OPENMP=OFF', '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded');
  }
  return f;
}

function findExe(dir) {
  for (const sub of ['bin/Release', 'bin', 'Release']) {
    const p = path.join(dir, sub, EXE);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`${EXE} not found under ${dir}`);
}

(async () => {
  await fetchSource();
  const build = path.join(WORK, `build-${process.platform}-${process.arch}-${TOOLCHAIN}`);
  run('cmake', ['-S', SRC, '-B', build, ...cmakeFlags()]);
  run('cmake', ['--build', build, '--config', 'Release', '--target', 'whisper-server', '-j', String(require('os').cpus().length)]);
  const exe = findExe(build);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(exe, path.join(OUT, EXE));
  fs.chmodSync(path.join(OUT, EXE), 0o755);
  fs.copyFileSync(path.join(SRC, 'LICENSE'), path.join(OUT, 'LICENSE-whisper.cpp.txt'));
  fs.writeFileSync(path.join(OUT, 'VERSION'), `whisper.cpp ${TAG} ${process.platform}-${process.arch}${process.platform === 'win32' ? ` ${TOOLCHAIN}` : ''}\n`);
  console.log(`built ${path.join(OUT, EXE)} (${(fs.statSync(path.join(OUT, EXE)).size / 1e6).toFixed(1)} MB)`);
})().catch((err) => { console.error(err.message); process.exit(1); });
