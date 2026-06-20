// Standalone self-check for src/cli/pm.ts.
//
// Run with: node src/cli/pm.selfcheck.ts   (Node 24 strips the TS types)
//
// Exercises detection + arg building without spawning a real install. Never
// imported by index.ts; never an esbuild entry.

import {
  detectPackageManager,
  isInstalled,
  installDevArgs,
  formatCommand,
  installCommand,
  installDevDep,
  type PackageManager,
} from './pm.ts';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error('pm self-check FAILED:', msg);
    process.exit(1);
  }
};

const cwd = process.cwd();
const pkg = '@svelte-plugin/font';

console.log('detectPackageManager(cwd):', detectPackageManager(cwd));
console.log('isInstalled(cwd, pkg):', isInstalled(cwd, pkg));

for (const pm of ['npm', 'pnpm', 'yarn', 'bun'] as PackageManager[]) {
  console.log(
    `installDevArgs(${pm}):`,
    JSON.stringify(installDevArgs(pm, pkg)),
    '->',
    formatCommand(pm, installDevArgs(pm, pkg)),
  );
}

// Arg-shape assertions.
assert(
  JSON.stringify(installCommand('npm', pkg, true)) === JSON.stringify(['install', '-D', pkg]),
  'npm dev args',
);
assert(
  JSON.stringify(installCommand('npm', pkg, false)) === JSON.stringify(['install', '--save', pkg]),
  'npm prod args',
);
assert(
  JSON.stringify(installCommand('pnpm', pkg, true)) === JSON.stringify(['add', '-D', pkg]),
  'pnpm dev args (no empty flag)',
);
assert(
  JSON.stringify(installCommand('yarn', pkg, true)) === JSON.stringify(['add', '--dev', pkg]),
  'yarn dev args',
);
assert(
  JSON.stringify(installCommand('bun', pkg, true)) === JSON.stringify(['add', '-d', pkg]),
  'bun dev args',
);

// dryRun never spawns and reports ok with the command to print.
const dry = installDevDep({ pm: 'npm', pkg, cwd, dryRun: true });
assert(dry.ran === false && dry.ok === true, 'dryRun does not spawn, reports ok');
assert(dry.command === 'npm install -D ' + pkg, `dryRun command string, got '${dry.command}'`);

// A non-resolvable PM surfaces a reason (ENOENT) rather than an opaque ok:false.
const bad = installDevDep({
  pm: 'definitely-not-a-pm' as PackageManager,
  pkg,
  cwd,
  dryRun: false,
});
assert(bad.ran === true && bad.ok === false, 'missing PM reports not ok');
assert(typeof bad.reason === 'string' && bad.reason.length > 0, 'missing PM surfaces a reason');
console.log('missing-PM reason:', bad.reason);

console.log('pm.ts self-check: ALL PASSED');
