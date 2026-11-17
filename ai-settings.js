'use strict';
const key = document.getElementById('key');
const enabled = document.getElementById('enabled');
const clear = document.getElementById('clear');
const status = document.getElementById('status');

chrome.storage.local.get(['geminiApiKey', 'aiShortAnswerEnabled']).then(settings => {
    enabled.checked = settings.aiShortAnswerEnabled === true;
    if (settings.geminiApiKey) key.placeholder = 'Key saved (enter a new key to replace it)';
}).catch(() => { status.textContent = 'Could not load AI settings.'; });

document.getElementById('save').addEventListener('click', async () => {
    const values = { aiShortAnswerEnabled: enabled.checked };
    if (clear.checked) values.geminiApiKey = '';
    else if (key.value.trim()) values.geminiApiKey = key.value.trim();
    try {
        await chrome.storage.local.set(values);
        if ('geminiApiKey' in values) key.placeholder = values.geminiApiKey ? 'Key saved (enter a new key to replace it)' : 'Enter an API key';
        key.value = '';
        clear.checked = false;
        status.textContent = 'AI settings saved.';
    } catch (_) {
        status.textContent = 'Could not save AI settings.';
    }
});
