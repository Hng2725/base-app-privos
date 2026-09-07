/**
 * Windows-only repair for `@privos_ai/app-server`'s standalone identity guard.
 *
 * The SDK refuses to load `privos-standalone-identity.json` unless the file
 * stats as POSIX mode 0600 owned by the current uid/gid. On Windows that check
 * can never pass: libuv synthesises `mode` from the read-only attribute alone
 * (0o666, or 0o444 when read-only) and reports uid/gid 0, so `fs.chmod(p, 0o600)`
 * is a silent no-op. The result is a hard boot failure in `standalone-production`
 * mode on any native Windows dev machine.
 *
 * This script rewrites the installed `assertSafeFileStat` so that on win32 it
 * only asserts the path is a regular file, and leaves the POSIX ownership + mode
 * assertion untouched everywhere else. It is a no-op on non-Windows platforms
 * (so the Linux marketplace image keeps the real check), it is idempotent, and it
 * runs from `prestart` — never from `postinstall` — so `npm ci` inside the
 * Dockerfile is unaffected.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'privos-windows-identity-mode-shim';

const TARGET = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'node_modules/@privos_ai/app-server/dist/relay/standalone-identity.js',
);

const NEEDLE = 'function assertSafeFileStat(stat, filePath) {\n';

const SHIM = `function assertSafeFileStat(stat, filePath) {
    // ${MARKER}: Windows cannot represent POSIX mode 0600 — libuv reports 0o666
    // (or 0o444 when read-only) and uid/gid 0, and chmod(0o600) is a no-op, so the
    // mode/ownership assertion below can never pass. Assert the path shape only.
    if (process.platform === 'win32') {
        if (!stat.isFile()) {
            throw new StandaloneIdentityError('IDENTITY_FILE_MODE_INVALID', \`Standalone identity file \${filePath} is not a regular file.\`);
        }
        return;
    }
`;

if (process.platform !== 'win32') process.exit(0);

if (!fs.existsSync(TARGET)) {
	console.warn(`[patch-sdk-windows] skipped: ${TARGET} not found (run npm install first)`);
	process.exit(0);
}

const source = fs.readFileSync(TARGET, 'utf8');

if (source.includes(MARKER)) process.exit(0);

if (!source.includes(NEEDLE)) {
	console.error(
		'[patch-sdk-windows] could not find assertSafeFileStat in @privos_ai/app-server — ' +
			'the SDK changed shape. Re-check whether the 0600 guard is still Windows-hostile.',
	);
	process.exit(1);
}

fs.writeFileSync(TARGET, source.replace(NEEDLE, SHIM), 'utf8');
console.log('[patch-sdk-windows] applied Windows identity-file mode shim to @privos_ai/app-server');
