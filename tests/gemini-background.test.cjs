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
        console, URL, AbortSignal, Uint8Array, btoa, Date
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
    assert.match(calls[0].url, /gemini-3\.5-flash-lite:generateContent$/);
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
