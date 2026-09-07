/**
 * Refuses to start a second local instance of this app.
 *
 * The Hub accepts exactly ONE relay connection per paired app. A second process
 * holding the same `privos-standalone-identity.json` does not fail cleanly — it
 * connects, the Hub closes the older socket with `1000 Replaced or shutdown`,
 * the loser reconnects on backoff and evicts the winner, and both sides spin
 * forever in `relay.ws_error` / `relay.disconnected` / `relay.reconnect.scheduled`.
 * Binding the HTTP port does not stop this: on Windows the second `app.listen`
 * still reports `serveApp.listening`, so a port clash is not a reliable guard.
 *
 * Stale instances are easy to leave behind because `npm start` spawns a chain
 * (npm -> tsx cli -> node server): killing the top of the chain, or closing the
 * terminal window, can orphan the grandchild that actually holds the relay socket.
 *
 * Default: report any live instance and exit non-zero so `prestart` aborts.
 * `--kill`: terminate them instead (what `npm run stop` does).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KILL = process.argv.includes('--kill');

const normalize = (s) => s.replace(/\\/g, '/').toLowerCase();
const ROOT_KEY = normalize(ROOT);

/** @returns {{pid: number, cmd: string}[]} every node process running this app's server entry. */
function findInstances() {
	const rows = [];

	if (process.platform === 'win32') {
		// wmic is gone on current Windows; CIM is the supported listing.
		const ps = spawnSync(
			'powershell.exe',
			[
				'-NoProfile',
				'-NonInteractive',
				'-Command',
				"Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
					'ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
			],
			{ encoding: 'utf8' },
		);
		for (const line of (ps.stdout ?? '').split(/\r?\n/)) {
			const tab = line.indexOf('\t');
			if (tab < 0) continue;
			rows.push({ pid: Number(line.slice(0, tab)), cmd: line.slice(tab + 1) });
		}
	} else {
		const ps = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
		for (const line of (ps.stdout ?? '').split('\n')) {
			const m = line.match(/^\s*(\d+)\s+(.*)$/);
			if (m) rows.push({ pid: Number(m[1]), cmd: m[2] });
		}
	}

	return rows.filter(({ pid, cmd }) => {
		if (!Number.isInteger(pid) || pid === process.pid || pid === process.ppid) return false;
		const c = normalize(cmd);
		// Both links of the chain (tsx launcher and the node child it spawns) carry
		// the project root and the server entry; the prestart scripts do not.
		return c.includes(ROOT_KEY) && c.includes('src/server.ts');
	});
}

const instances = findInstances();

if (instances.length === 0) {
	if (KILL) console.log('[single-instance] no running instance found');
	process.exit(0);
}

if (KILL) {
	for (const { pid } of instances) {
		try {
			process.kill(pid, 'SIGKILL');
			console.log(`[single-instance] stopped pid ${pid}`);
		} catch (error) {
			console.warn(`[single-instance] could not stop pid ${pid}: ${error.message}`);
		}
	}
	process.exit(0);
}

console.error(
	`\n[single-instance] Refusing to start: this app is already running (${instances.length} process(es)).\n` +
		'A second instance would fight the first for the Hub\'s single relay slot and both would\n' +
		'flap between "relay.disconnected" and "relay.reconnect.scheduled" indefinitely.\n',
);
for (const { pid, cmd } of instances) console.error(`  pid ${pid}  ${cmd.slice(0, 140)}`);
console.error('\nStop it with Ctrl+C in its terminal, or run:  npm run stop\n');
process.exit(1);
