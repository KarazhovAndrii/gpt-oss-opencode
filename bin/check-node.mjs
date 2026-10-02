#!/usr/bin/env node
// Runs before the TypeScript entry points (see package.json scripts). Plain JavaScript on
// purpose: Node.js before 22.18 cannot load the .ts files at all and would otherwise stop
// with "Unknown file extension .ts" instead of saying what to install.

/** Node.js runs .ts files without flags from 22.18 (22.x) and 23.6. */
export function supportsTypeScript(version) {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  if (major === 22) return minor >= 18;
  if (major === 23) return minor >= 6;
  return major > 23;
}

const version = process.versions.node;
if (!supportsTypeScript(version)) {
  const windows = process.platform === "win32";
  console.error(
    [
      `gpt-oss-opencode needs Node.js 22.18 or newer; this is Node.js ${version} (${process.execPath}).`,
      "It runs its TypeScript files directly, which older versions of Node.js cannot do.",
      "",
      `Install the current LTS from https://nodejs.org${windows ? " (or: winget install OpenJS.NodeJS.LTS)" : ""},`,
      "open a new terminal so it is found first, and run the same command again.",
      `Without admin rights: a version manager such as fnm${windows ? " (winget install Schniz.fnm)" : ""} installs Node.js for your user only.`,
    ].join("\n"),
  );
  process.exit(1);
}
