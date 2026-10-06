// WeVideo (Playposit) ToolKit - Background Service Worker

// Track activated tabs: tabId -> { solveActive: boolean, fastStepActive: boolean }
const activeTabStates = new Map();

// Helper to inject into a tab or frame
async function injectYeeter(tabId, frameId = null) {
    try {
        const target = frameId !== null ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true };

        await chrome.scripting.insertCSS({
            target,
            files: ["styles.css"]
        }).catch(() => {});

        await chrome.scripting.executeScript({
            target,
            files: ["content.js"]
        }).catch(() => {});

        console.log(`[ToolKit BG] Injected into tab ${tabId}${frameId !== null ? ` (frame ${frameId})` : ' (all frames)'}`);
    } catch (err) {
        console.warn(`[ToolKit BG] Injection error on tab ${tabId}:`, err);
    }
}

// 1. User clicks the extension action icon on a tab to activate it
chrome.action.onClicked.addListener(async (tab) => {
    if (!tab || !tab.id || !tab.url) return;
    const url = tab.url.toLowerCase();
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.includes('youtube.com') || url.includes('netflix.com')) {
        console.log(`[ToolKit BG] Skipping activation on restricted/media URL: ${tab.url}`);
        return;
    }

    if (!activeTabStates.has(tab.id)) {
        // Activate on this tab
        activeTabStates.set(tab.id, { solveActive: false, fastStepActive: false });
        chrome.action.setBadgeText({ tabId: tab.id, text: "ON" });
        chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#10b981" });
        await injectYeeter(tab.id);
    } else {
        // Re-inject / ping if clicked again
        await injectYeeter(tab.id);
    }
});

// 2. Auto-initialize detection for configured activation URLs
async function checkAutoInitialize(tabId, url) {
    if (!url) return;
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.startsWith('chrome://') || lowerUrl.startsWith('chrome-extension://') || lowerUrl.includes('youtube.com') || lowerUrl.includes('netflix.com')) {
        return;
    }
    try {
        const data = await chrome.storage.local.get(['activationUrls', 'autoInitEnabled']);
        if (!data || data.autoInitEnabled !== true) return;
        const urlsStr = (data && data.activationUrls) ? data.activationUrls : '';
        const list = urlsStr.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
        if (list.length === 0) return;

        const matched = list.some(target => lowerUrl.includes(target));
        if (matched) {
            console.log(`[ToolKit BG] Auto-initializing on matching URL: ${url}`);
            if (!activeTabStates.has(tabId)) {
                activeTabStates.set(tabId, { solveActive: false, fastStepActive: false });
                chrome.action.setBadgeText({ tabId, text: "ON" });
                chrome.action.setBadgeBackgroundColor({ tabId, color: "#10b981" });
            }
            await injectYeeter(tabId);
        }
    } catch (e) {
        console.warn("[ToolKit BG] Error checking auto-init:", e);
    }
}

// Check tabs when updated
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab && tab.url) {
        checkAutoInitialize(tabId, tab.url);
    }
});

// Open onboarding guide upon fresh install
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        chrome.tabs.create({ url: "onboarding.html" });
    }
});

// Reset active running states when the main page navigates or refreshes (F5)
chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) {
        if (activeTabStates.has(details.tabId)) {
            const state = activeTabStates.get(details.tabId);
            state.solveActive = false;
            state.fastStepActive = false;
            chrome.action.setBadgeText({ tabId: details.tabId, text: "ON" });
            chrome.action.setBadgeBackgroundColor({ tabId: details.tabId, color: "#10b981" });
        }
    }
});

// 3. Handle subframe reloads / navigations ONLY on activated tabs (e.g. PlayPosit Retake reload)
chrome.webNavigation.onCompleted.addListener(async (details) => {
    if (!activeTabStates.has(details.tabId)) return; // Completely ignore tabs where ToolKit is not activated
    if (details.url && (details.url.includes('youtube.com') || details.url.includes('netflix.com'))) return;

    console.log(`[ToolKit BG] Frame reloaded in active tab ${details.tabId}, frame ${details.frameId}. Re-injecting...`);
    await injectYeeter(details.tabId, details.frameId);
});

// 4. Clean up closed tabs
chrome.tabs.onRemoved.addListener((tabId) => {
    activeTabStates.delete(tabId);
});

// 5. State synchronization and message handling
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'open-onboarding') {
        chrome.tabs.create({ url: "onboarding.html" });
        sendResponse({ success: true });
        return true;
    }

    const tabId = sender.tab ? sender.tab.id : null;
    if (!tabId) return;

    if (msg.type === 'yeeter-state-update') {
        const current = activeTabStates.get(tabId) || { solveActive: false, fastStepActive: false };
        current.solveActive = !!msg.solveActive;
        current.fastStepActive = !!msg.fastStepActive;
        activeTabStates.set(tabId, current);

        // Update badge to reflect solving state
        if (current.solveActive) {
            chrome.action.setBadgeText({ tabId, text: "RUN" });
            chrome.action.setBadgeBackgroundColor({ tabId, color: "#3b82f6" });
        } else {
            chrome.action.setBadgeText({ tabId, text: "ON" });
            chrome.action.setBadgeBackgroundColor({ tabId, color: "#10b981" });
        }
        sendResponse({ success: true });
    } else if (msg.type === 'yeeter-state-query') {
        const state = activeTabStates.get(tabId) || { solveActive: false, fastStepActive: false };
        console.log(`[ToolKit BG] State query from tab ${tabId}:`, state);
        sendResponse(state);
    }
    return true; // Keep message channel open for async response
});
