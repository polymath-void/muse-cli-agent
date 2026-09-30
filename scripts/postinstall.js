#!/usr/bin/env node
/**
 * scripts/postinstall.js — Auto-install optional Python dependencies.
 *
 * Runs after `npm install`. Attempts to install `polymath-nodeos` (NodeOS)
 * via pip. Fails gracefully if Python is not available — NodeOS remains
 * an optional capability that activates only when detected.
 */

import { spawnSync } from "node:child_process";

const PYTHON_DEPS = [
  { pip: "polymath-nodeos", bin: "nodeos", label: "NodeOS (AST daemon)" },
];

function findPython() {
  for (const name of ["python3", "python"]) {
    const r = spawnSync(name, ["--version"], { stdio: "ignore" });
    if (r.status === 0) return name;
  }
  return null;
}

const python = findPython();
if (!python) {
  console.log("[muse-cli] Python not found — skipping optional NodeOS install.");
  process.exit(0);
}

for (const dep of PYTHON_DEPS) {
  // Check if already installed.
  const check = spawnSync(python, ["-m", "pip", "show", dep.pip], { stdio: "ignore" });
  if (check.status === 0) {
    console.log(`[muse-cli] ✓ ${dep.label} already installed.`);
    continue;
  }

  console.log(`[muse-cli] Installing ${dep.label} (${dep.pip})...`);
  const install = spawnSync(
    python,
    ["-m", "pip", "install", "--break-system-packages", "--quiet", dep.pip],
    { stdio: "inherit", timeout: 120_000 },
  );

  if (install.status === 0) {
    console.log(`[muse-cli] ✓ ${dep.label} installed successfully.`);
  } else {
    console.log(`[muse-cli] ○ ${dep.label} install failed (optional — muse-cli will work without it).`);
  }
}
