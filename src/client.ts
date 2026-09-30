/** Node-only Jev transport. The pure policy entry does not import this module. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';

/** Hosts keep their existing session filename policy and warning sink. */
export interface RequestRecord {
	readonly directory: string;
	readonly sessionId: string;
	readonly fileName: string;
	readonly warn: (message: string) => void;
}

/** Used for both the host's byte-budget check and the exact transmitted body. */
export function serializeJevRequest(state: unknown, questions: unknown): string {
	return JSON.stringify({ model: 'typesafe-ai/jev', state, questions });
}

/**
 * One POST only. Credentials, retries, timeouts and response parsing remain with the host.
 * Recording is best effort: neither fetch nor its caller waits for disk I/O, and sudden
 * process exit can lose pending records. body is the same complete, unredacted string.
 */
export function sendJevRequest(options: {
	readonly body: string;
	readonly apiKey: string;
	readonly signal: AbortSignal;
	readonly record?: RequestRecord;
}): Promise<Response> {
	const { body, apiKey, signal, record } = options;
	if (record) {
		const time = new Date().toISOString();
		void Promise.resolve().then(() => appendRequest(record, time, body));
	}
	return fetch('https://ai-gateway.vercel.sh/v1/evaluate', {
		method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
		body, signal,
	});
}

async function appendRequest(record: RequestRecord, time: string, body: string): Promise<void> {
	try {
		if (basename(record.fileName) !== record.fileName || !record.fileName.endsWith('.jsonl')
			|| record.fileName.includes('\\') || record.fileName.includes('\0')) {
			throw new Error('unsafe filename');
		}
		await fs.mkdir(record.directory, { recursive: true, mode: 0o700 });
		const directoryStat = await fs.lstat(record.directory);
		if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('unsafe directory');
		await fs.chmod(record.directory, 0o700);
		const handle = await fs.open(join(record.directory, record.fileName),
			constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0), 0o600);
		try {
			const fileStat = await handle.stat();
			if (!fileStat.isFile() || fileStat.nlink !== 1) throw new Error('unsafe file');
			await handle.chmod(0o600);
			await handle.appendFile(JSON.stringify({ time, sessionId: record.sessionId, body }) + '\n', 'utf8');
		} finally {
			await handle.close();
		}
	} catch {
		// Never include filesystem error messages: they may contain sensitive paths.
		try { record.warn('Jev request log write failed'); } catch { /* Observation cannot fail generation. */ }
	}
}
