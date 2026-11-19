'use strict';
const key = document.getElementById('key');
const enabled = document.getElementById('enabled');
const clear = document.getElementById('clear');
const model = document.getElementById('model');
const customModel = document.getElementById('custom-model');
const status = document.getElementById('status');

function showModelField() {
    customModel.style.display = model.value === 'custom' ? 'block' : 'none';
}

model.addEventListener('change', showModelField);

chrome.storage.local.get(['geminiApiKey', 'aiShortAnswerEnabled', 'geminiModel']).then(settings => {
    enabled.checked = settings.aiShortAnswerEnabled === true;
    if (settings.geminiApiKey) key.placeholder = 'Key saved (enter a new key to replace it)';
    const savedModel = settings.geminiModel || 'gemini-flash-latest';
    const known = Array.from(model.options).some(option => option.value === savedModel);
    if (known) model.value = savedModel;
    else { model.value = 'custom'; customModel.value = savedModel; }
    showModelField();
}).catch(() => { status.textContent = 'Could not load AI settings.'; });

document.getElementById('save').addEventListener('click', async () => {
    const selectedModel = model.value === 'custom' ? customModel.value.trim() : model.value;
    const values = { aiShortAnswerEnabled: enabled.checked, geminiModel: selectedModel || 'gemini-flash-latest' };
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
