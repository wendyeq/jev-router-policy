import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sendJevRequest, serializeJevRequest } from '../src/client.ts';
import type { RequestRecord } from '../src/client.ts';

async function lines(path: string, count: number) {
	for (let attempt = 0; attempt < 200; attempt++) {
		try {
			const rows = (await fs.readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
			if (rows.length === count) return rows;
		} catch { /* Append has not finished yet. */ }
		await delay(5);
	}
	assert.fail('request records did not finish');
}

async function fixture(t: TestContext) {
	const root = await fs.mkdtemp(join(tmpdir(), 'jev-client-'));
	t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
	const warnings: string[] = [];
	const record: RequestRecord = { directory: join(root, 'requests'), sessionId: 'synthetic/汉',
		fileName: `${encodeURIComponent('synthetic/汉')}.jsonl`, warn: message => warnings.push(message) };
	return { root, record, warnings, path: join(record.directory, record.fileName) };
}

// This literal is the pre-extraction wire format, not a second production serializer.
test('serialization preserves old DSH and Pi bytes, ordering, unicode and omitted fields', () => {
	const states = [{ messages: [{ role: 'user', text: '合成\n"任务"😀' }], currentEffort: 'high' },
		{ modelId: 'test/gpt-6.1-sol', currentEffort: null, messages: [{ role: 'tool', text: 'synthetic' }] },
		{ task: 'synthetic', history: [{ role: 'assistant', content: 'done' }] }];
	const questions = { route: { type: 'choice', instructions: 'synthetic only', criteria: { low: 'simple', high: 'hard' } } };
	for (const state of states) {
		assert.equal(serializeJevRequest(state, questions), JSON.stringify({ model: 'typesafe-ai/jev', state, questions }));
	}
});

test('each POST records only time, sessionId and exact fetch body, with private permissions', async t => {
	const { record, path, warnings } = await fixture(t);
	const response = new Response('synthetic HTTP error', { status: 503 });
	const calls: { url: unknown; options: RequestInit }[] = [];
	t.mock.method(globalThis, 'fetch', async (url: unknown, options: RequestInit) => { calls.push({ url, options }); return response; });
	const body = serializeJevRequest({ messages: [{ role: 'user', text: 'SYNTHETIC private text 汉😀' }] }, { route: { type: 'choice' } });
	const signal = new AbortController().signal;
	for (let i = 0; i < 3; i++) assert.equal(await sendJevRequest({ body, apiKey: 'FAKE-KEY-NOT-A-CREDENTIAL', signal, record }), response);
	const records = await lines(path, 3);
	assert.equal(calls.length, 3);
	for (const [i, row] of records.entries()) {
		assert.deepEqual(Object.keys(row), ['time', 'sessionId', 'body']);
		assert.equal(row.sessionId, record.sessionId);
		assert.equal(row.body, calls[i]!.options.body);
		assert.ok(Number.isFinite(Date.parse(row.time)));
		assert.equal(calls[i]!.url, 'https://ai-gateway.vercel.sh/v1/evaluate');
		assert.equal(calls[i]!.options.method, 'POST');
		assert.equal(calls[i]!.options.signal, signal);
		assert.deepEqual(calls[i]!.options.headers, { Authorization: 'Bearer FAKE-KEY-NOT-A-CREDENTIAL', 'Content-Type': 'application/json' });
	}
	const raw = await fs.readFile(path, 'utf8');
	assert.ok(!raw.includes('FAKE-KEY-NOT-A-CREDENTIAL'));
	assert.ok(!raw.includes('Authorization'));
	assert.equal((await fs.stat(record.directory)).mode & 0o777, 0o700);
	assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
	assert.deepEqual(warnings, []);
});

test('slow disk does not delay fetch or its result; completed append is checked separately', async t => {
	const { record, path } = await fixture(t);
	let release!: () => void;
	const stalled = new Promise<void>(resolve => { release = resolve; });
	const mkdir = fs.mkdir.bind(fs);
	t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => { await stalled; return mkdir(...args); });
	let fetched = false;
	t.mock.method(globalThis, 'fetch', async () => { fetched = true; return new Response('ready'); });
	const result = await sendJevRequest({ body: 'synthetic body', apiKey: 'fake', signal: new AbortController().signal, record });
	assert.equal(fetched, true);
	assert.equal(await result.text(), 'ready');
	await assert.rejects(fs.stat(path));
	release();
	assert.equal((await lines(path, 1))[0].body, 'synthetic body');
});

test('write failure emits a short warning without body/key/error and cannot fail network', async t => {
	const { record, warnings } = await fixture(t);
	t.mock.method(fs, 'mkdir', async () => { throw new Error('synthetic secret body and fake key'); });
	t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
	assert.equal(await (await sendJevRequest({ body: 'synthetic secret body', apiKey: 'fake key', signal: new AbortController().signal, record })).text(), 'ok');
	for (let i = 0; i < 100 && warnings.length === 0; i++) await delay(5);
	assert.deepEqual(warnings, ['Jev request log write failed']);
});

test('network rejection remains the same error even if warning sink throws', async t => {
	const { record } = await fixture(t);
	const failure = new Error('synthetic network');
	t.mock.method(fs, 'mkdir', async () => { throw new Error('disk'); });
	t.mock.method(globalThis, 'fetch', async () => { throw failure; });
	await assert.rejects(sendJevRequest({ body: 'synthetic', apiKey: 'fake', signal: new AbortController().signal,
		record: { ...record, warn: () => { throw new Error('warning sink'); } } }), error => error === failure);
	await delay(10);
});

test('unsafe filenames and symlink request targets never escape or overwrite a file', async t => {
	const { root, record, warnings } = await fixture(t);
	t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
	const outside = join(root, 'outside.jsonl');
	await fs.writeFile(outside, 'untouched');
	await fs.mkdir(record.directory);
	await fs.symlink(outside, join(record.directory, record.fileName));
	for (const fileName of ['../outside.jsonl', '/outside.jsonl', '..\\outside.jsonl', record.fileName]) {
		await sendJevRequest({ body: 'synthetic', apiKey: 'fake', signal: new AbortController().signal, record: { ...record, fileName } });
	}
	for (let i = 0; i < 100 && warnings.length < 4; i++) await delay(5);
	assert.equal(warnings.length, 4);
	assert.equal(await fs.readFile(outside, 'utf8'), 'untouched');
});

test('symlink request directory is rejected', async t => {
	const { root, record, warnings } = await fixture(t);
	const elsewhere = join(root, 'elsewhere');
	await fs.mkdir(elsewhere);
	await fs.symlink(elsewhere, record.directory);
	t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
	await sendJevRequest({ body: 'synthetic', apiKey: 'fake', signal: new AbortController().signal, record });
	for (let i = 0; i < 100 && warnings.length === 0; i++) await delay(5);
	assert.equal(warnings.length, 1);
	assert.deepEqual(await fs.readdir(elsewhere), []);
});
