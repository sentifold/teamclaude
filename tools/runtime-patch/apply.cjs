#!/usr/bin/env node
/**
 * Apply the reliability patch to an installed @karpeleslab/teamclaude.
 *
 * This edits the INSTALLED npm package in place, not this repository: the
 * patch targets the shipped `src/*.js` files. It is idempotent (every change
 * carries a marker comment and is skipped if already present), fail-closed
 * (an unexpected layout aborts before writing), and post-checked (`node
 * --check` on every file it touched).
 *
 * Usage:
 *   node tools/runtime-patch/apply.cjs          # patch the global install
 *   node tools/runtime-patch/apply.cjs --check  # report status, change nothing
 *
 * Override the package root with AGENT_ROUTER_NPM_ROOT_OVERRIDE when testing
 * against an extracted tarball instead of a global install.
 */
"use strict";

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PACKAGE_NAME = "@karpeleslab/teamclaude";
// The patch matches exact source layouts, so it is pinned to the version it
// was written against. A different version must be re-verified rather than
// patched on a best-effort basis.
const PINNED_VERSION = "1.1.13";

// Every change the payload makes carries one of these marker comments. They
// are the idempotency key AND the post-condition: a run that reports success
// without leaving all of them behind is treated as a failed patch.
const MARKERS = [
	[
		"src/account-manager.js",
		"TeamClaude local policy: break weekly-reset ties by the 5-hour reset",
	],
	[
		"src/account-manager.js",
		"TeamClaude local policy: keep the current account across quota-window resets",
	],
	[
		"src/server.js",
		"TeamClaude local policy: hide bounded transient retries across the usable pool",
	],
	[
		"src/upstream-fetch.js",
		"TeamClaude local policy: compose managed cancellation with direct-fetch timeout",
	],
];

function fail(message) {
	process.stderr.write(`error: ${message}\n`);
	process.exit(1);
}

function resolvePackageRoot() {
	const override = process.env.AGENT_ROUTER_NPM_ROOT_OVERRIDE;
	if (override) return path.join(override, PACKAGE_NAME);
	let npmRoot;
	try {
		npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
	} catch (error) {
		fail(`could not resolve the global npm root: ${error.message}`);
	}
	return path.join(npmRoot, PACKAGE_NAME);
}

function readInstalledVersion(packageRoot) {
	const manifestPath = path.join(packageRoot, "package.json");
	if (!fs.existsSync(manifestPath)) {
		fail(
			`${PACKAGE_NAME} is not installed at ${packageRoot}.\n` +
				`Install the pinned version first:\n` +
				`  npm install -g --ignore-scripts ${PACKAGE_NAME}@${PINNED_VERSION}`,
		);
	}
	return JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
}

function patchStatus(packageRoot) {
	return MARKERS.map(([relativePath, marker]) => {
		const filePath = path.join(packageRoot, relativePath);
		const present =
			fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").includes(marker);
		return { relativePath, marker, present };
	});
}

function main() {
	const checkOnly = process.argv.includes("--check");
	const packageRoot = resolvePackageRoot();
	const installedVersion = readInstalledVersion(packageRoot);

	if (installedVersion !== PINNED_VERSION) {
		fail(
			`${PACKAGE_NAME} ${installedVersion} is installed, but this patch is pinned to ` +
				`${PINNED_VERSION}.\nThe patch matches exact source layouts and refuses to run ` +
				`against an unverified version.\nInstall the pinned version:\n` +
				`  npm install -g --ignore-scripts ${PACKAGE_NAME}@${PINNED_VERSION}`,
		);
	}

	if (checkOnly) {
		const status = patchStatus(packageRoot);
		for (const entry of status) {
			process.stdout.write(
				`${entry.present ? "ok     " : "MISSING"}  ${entry.relativePath}  ${entry.marker}\n`,
			);
		}
		process.exit(status.every((entry) => entry.present) ? 0 : 1);
	}

	const targets = {
		ROUTER_TEAMCLAUDE_ACCOUNT_MANAGER_FILE: path.join(packageRoot, "src/account-manager.js"),
		ROUTER_TEAMCLAUDE_SERVER_FILE: path.join(packageRoot, "src/server.js"),
		ROUTER_TEAMCLAUDE_UPSTREAM_FETCH_FILE: path.join(packageRoot, "src/upstream-fetch.js"),
	};
	for (const [name, filePath] of Object.entries(targets)) {
		if (!fs.existsSync(filePath)) fail(`${name} is missing: ${filePath}`);
	}

	const payload = path.join(__dirname, "payloads", "teamclaude-runtime.cjs");
	const applied = spawnSync(process.execPath, [payload], {
		env: { ...process.env, ...targets },
		stdio: "inherit",
	});
	if (applied.status !== 0) fail("the runtime patch aborted; the package was left unchanged");

	for (const filePath of Object.values(targets)) {
		const checked = spawnSync(process.execPath, ["--check", filePath], { encoding: "utf8" });
		if (checked.status !== 0) {
			fail(`patched file failed syntax validation: ${filePath}\n${checked.stderr}`);
		}
	}

	const status = patchStatus(packageRoot);
	const missing = status.filter((entry) => !entry.present);
	if (missing.length > 0) {
		fail(
			`the patch reported success but these changes are absent:\n` +
				missing.map((entry) => `  ${entry.relativePath}: ${entry.marker}`).join("\n"),
		);
	}

	process.stdout.write(
		`patched ${PACKAGE_NAME}@${PINNED_VERSION} at ${packageRoot}\n` +
			`  sticky account selection across quota-window resets\n` +
			`  bounded hidden retries, failover and pool waits\n` +
			`  caller abort composed with the direct-fetch headers timeout\n`,
	);
}

main();
