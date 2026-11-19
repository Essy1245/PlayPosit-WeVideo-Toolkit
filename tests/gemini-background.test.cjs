const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup() {
    const listeners = [];
    const storage = { local: { aiShortAnswerEnabled: true, geminiApiKey: 'test-key' }, session: {} };
    const events = () => ({ addListener() {} });
    const area = name => ({
        async get(keys) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) result[key] = storage[name][key];
            return result;
        },
        async set(values) { Object.assign(storage[name], values); }
    });
    let calls = [];
    const context = {
        chrome: { action: { onClicked: events() }, tabs: { onUpdated: events(), onRemoved: events() }, webNavigation: { onCommitted: events(), onCompleted: events() }, runtime: { onInstalled: events(), onMessage: { addListener(fn) { listeners.push(fn); } } }, storage: { local: area('local'), session: area('session') } },
        fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"answer":"2650"}' }] } }] }) }; },
        console, URL, AbortSignal, Uint8Array, Blob, btoa, Date
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync('background.js', 'utf8'), context);
    const send = (msg, sender = { tab: { id: 1 }, frameId: 2, url: 'https://www.wevideo.com/interactive/player' }) => new Promise(resolve => {
        for (const listener of listeners) listener(msg, sender, resolve);
    });
    return { context, storage, calls, send };
}

test('sends question and image once, never puts key in URL, and enforces cooldown', async () => {
    const { send, calls } = setup();
    const msg = { type: 'gemini-solve', question: 'Calculate the total.', images: ['data:image/png;base64,YWJj'] };
    const result = await send(msg);
    assert.equal(result.answer, '2650');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /gemini-4-hydrogen:generateContent$/);
    assert.doesNotMatch(calls[0].url, /test-key/);
    assert.equal(calls[0].options.headers['x-goog-api-key'], 'test-key');
    assert.equal(JSON.parse(calls[0].options.body).contents[0].parts[1].inline_data.data, 'YWJj');
    assert.match((await send(msg)).error, /cooldown/);
    assert.equal(calls.length, 1);
});

test('does not call Gemini when disabled, missing key, or image is invalid', async () => {
    const { send, calls, storage } = setup();
    const msg = { type: 'gemini-solve', question: 'Question', images: [] };
    storage.local.aiShortAnswerEnabled = false;
    assert.match((await send(msg)).error, /disabled/);
    storage.local.aiShortAnswerEnabled = true;
    storage.local.geminiApiKey = '';
    assert.match((await send(msg)).error, /key/);
    storage.local.geminiApiKey = 'test-key';
    assert.match((await send({ ...msg, images: ['data:image/svg+xml;base64,YWJj'] })).error, /image|request/i);
    assert.equal(calls.length, 0);
});

test('a 429 stops with a quota message and no automatic retry', async () => {
    const { context, send } = setup();
    let count = 0;
    context.fetch = async () => { count++; return { ok: false, status: 429 }; };
    const result = await send({ type: 'gemini-solve', question: 'Question', images: [] });
    assert.match(result.error, /quota|rate limit/i);
    assert.equal(count, 1);
});

test('uses a valid custom model and explains model access failures', async () => {
    const { context, send, calls, storage } = setup();
    storage.local.geminiModel = 'gemini-3.8-flash';
    context.fetch = async (url) => {
        calls.push({ url });
        return { ok: false, status: 403, json: async () => ({ error: { message: 'permission denied' } }) };
    };
    const result = await send({ type: 'gemini-solve', question: 'Question', images: [] });
    assert.match(calls[0].url, /gemini-3\.8-flash:generateContent$/);
    assert.match(result.error, /denied access.*gemini-3\.8-flash/i);
});

test('falls back to Hydrogen for an invalid stored model', async () => {
    const { context, send, calls, storage } = setup();
    storage.local.geminiModel = 'bad model name';
    context.fetch = async (url) => {
        calls.push({ url });
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"answer":"4"}' }] } }] }) };
    };
    await send({ type: 'gemini-solve', question: 'Question', images: [] });
    assert.match(calls[0].url, /gemini-4-hydrogen:generateContent$/);
});

test('migrates retired model choices while preserving newer explicit models', async () => {
    const { context } = setup();
    for (const old of ['gemini-3.5-flash-lite', 'gemini-3.1-pro-preview', 'gemini-2.5-flash']) {
        assert.equal(context.getGeminiModel(old), 'gemini-4-hydrogen');
    }
    for (const current of ['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-3.8-flash', 'gemini-flash-latest']) {
        assert.equal(context.getGeminiModel(current), current);
    }
});

test('reports image download failure without sending an incomplete question to Gemini', async () => {
    const { context, send } = setup();
    let calls = 0;
    context.fetch = async () => { calls++; return { ok: false, status: 403 }; };
    const result = await send({ type: 'gemini-solve', question: 'Question', images: ['https://example.com/table.png'] });
    assert.match(result.error, /image.*HTTP 403/i);
    assert.equal(calls, 1);
});

test('distinguishes a Gemini connection failure from an image failure', async () => {
    const { context, send } = setup();
    context.fetch = async () => { throw new TypeError('network error'); };
    const result = await send({ type: 'gemini-solve', question: 'Question', images: [] });
    assert.match(result.error, /connect to Gemini/i);
});

test('downloads a cross-origin question image in the background and includes its bytes', async () => {
    const { context, send } = setup();
    let requestBody;
    context.fetch = async (url, options) => {
        if (url.startsWith('https://cdn.playposit.com/')) {
            assert.equal(options.credentials, 'omit');
            return { ok: true, blob: async () => new Blob([Buffer.from('89504e470d0a1a0a0102', 'hex')], { type: 'application/octet-stream' }) };
        }
        requestBody = JSON.parse(options.body);
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"answer":"4"}' }] } }] }) };
    };
    const result = await send({ type: 'gemini-solve', question: 'Question', images: ['https://cdn.playposit.com/table.png'] });
    assert.equal(result.answer, '4');
    assert.equal(requestBody.contents[0].parts[1].inline_data.mime_type, 'image/png');
    assert.equal(requestBody.contents[0].parts[1].inline_data.data, Buffer.from('89504e470d0a1a0a0102', 'hex').toString('base64'));
    assert.match(requestBody.contents[0].parts[0].text, /Question/);
});

test('rejects a non-image response before sending question text to Gemini', async () => {
    const { context, send } = setup();
    let count = 0;
    context.fetch = async () => { count++; return { ok: true, blob: async () => new Blob(['<html>error</html>'], { type: 'application/octet-stream' }) }; };
    const result = await send({ type: 'gemini-solve', question: 'Question', images: ['https://cdn.playposit.com/table.png'] });
    assert.match(result.error, /not a supported/i);
    assert.equal(count, 1);
});
