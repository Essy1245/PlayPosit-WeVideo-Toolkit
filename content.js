// WeVideo (Playposit) ToolKit Content Script
// Architecture: Host frame (Canvas page) ↔ postMessage ↔ Player frame (iframe with video)
(function () {
    if (window.playpositYeeterLoaded) {
        console.log("WeVideo (Playposit) ToolKit already loaded. Re-checking.");
        if (window.playpositYeeter) {
            window.playpositYeeter.recheckAll();
        }
        return;
    }

    // Safety guard: NEVER run on YouTube, Netflix, or any site that is not PlayPosit/WeVideo or an LTI Canvas host!
    const hostname = window.location.hostname.toLowerCase();
    const isPlaypositDomain = /playposit\.com|playpos\.it|wevideo\.com/.test(hostname);
    const isLtiOrCanvas = !!document.querySelector(
        '.tool_content_wrapper, iframe[src*="wevideo.com"], iframe[src*="playposit.com"], iframe.tool_launch, iframe[data-lti-launch]'
    );
    if (window === window.top && !isPlaypositDomain && !isLtiOrCanvas) {
        return;
    }

    window.playpositYeeterLoaded = true;
    console.log("WeVideo (Playposit) ToolKit initializing...");

    // Inject the visibility spoofer into the main world
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    script.onload = function () { this.remove(); };
    (document.head || document.documentElement).appendChild(script);

    // ─────────────────────────────────────────────
    //  Configuration
    // ─────────────────────────────────────────────
    const SKIP_INTERVAL_MS = 90;  // How often to skip
    const SKIP_AMOUNT_S    = 5;   // How much to skip per interval

    let fastStepInterval = null;
    let fastStepManuallyStopped = false;
    let currentVideo     = null;

    // ─────────────────────────────────────────────
    //  Debug Logging (persisted in localStorage + aggregated to host)
    // ─────────────────────────────────────────────
    const DEBUG_LOG_KEY = 'pp_yeeter_debug_logs';

    function logDebug(category, message, details = null) {
        const timestamp = new Date().toISOString().substring(11, 23);
        const frameType = window === window.top ? 'HOST' : (isPlayer ? 'PLAYER' : 'IFRAME');
        const entry = {
            time: timestamp,
            frame: frameType,
            cat: category,
            msg: message,
            data: details
        };

        const consolePrefix = `[ToolKit ${frameType}][${category}]`;
        if (details !== null && details !== undefined) {
            console.log(consolePrefix, message, details);
        } else {
            console.log(consolePrefix, message);
        }

        try {
            const list = JSON.parse(localStorage.getItem(DEBUG_LOG_KEY) || '[]');
            list.push(entry);
            if (list.length > 250) list.splice(0, list.length - 200);
            localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(list));
        } catch (e) {}

        // Forward entry up to host so the host has an all-frame combined log
        if (window.parent !== window) {
            sendEventUp('debug-log', { entry });
        }
    }

    function storeHostDebugLog(entry) {
        try {
            const list = JSON.parse(localStorage.getItem(DEBUG_LOG_KEY) || '[]');
            list.push(entry);
            if (list.length > 350) list.splice(0, list.length - 300);
            localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(list));
        } catch (e) {}
    }

    function formatLogsForExport() {
        let list = [];
        try {
            list = JSON.parse(localStorage.getItem(DEBUG_LOG_KEY) || '[]');
        } catch (e) {}

        const header = `=== WEVIDEO (PLAYPOSIT) TOOLKIT DEBUG LOG ===\nExported: ${new Date().toISOString()}\nTotal Entries: ${list.length}\nOrigin: ${window.location.href}\n----------------------------------\n`;
        const lines = list.map(e => {
            const dataStr = e.data ? ` | ${JSON.stringify(e.data)}` : '';
            return `[${e.time}][${e.frame}][${e.cat}] ${e.msg}${dataStr}`;
        });
        return header + (lines.length > 0 ? lines.join('\n') : '(No log entries recorded yet)');
    }

    // ─────────────────────────────────────────────
    //  Settings (persisted via localStorage)
    // ─────────────────────────────────────────────
    const SETTINGS_KEY = 'pp_yeeter_settings';

    function loadSettings() {
        try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
        catch (e) { return {}; }
    }
    function saveSetting(key, value) {
        const s = loadSettings();
        s[key] = value;
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({ [key]: value });
            }
        } catch (e) {}
    }
    function getSetting(key, defaultVal) {
        const s = loadSettings();
        return (key in s) ? s[key] : defaultVal;
    }

    // ─────────────────────────────────────────────
    //  PostMessage Bridge
    //  Commands go DOWN (host → player): pp-cmd-*
    //  Events go UP (player → host):     pp-evt-*
    // ─────────────────────────────────────────────
    const PP_MSG_PREFIX = 'pp-yeeter-';

    /** Send a command DOWN to all child iframes */
    function sendCommandDown(cmd, data = {}) {
        const msg = { type: PP_MSG_PREFIX + 'cmd', cmd, ...data };
        document.querySelectorAll('iframe').forEach(f => {
            try { f.contentWindow.postMessage(msg, '*'); } catch (e) {}
        });
    }

    /** Send an event UP to parent frame */
    function sendEventUp(evt, data = {}) {
        if (window.parent !== window) {
            try { window.parent.postMessage({ type: PP_MSG_PREFIX + 'evt', evt, ...data }, '*'); }
            catch (e) {}
        }
    }

    /** Relay: forward messages through intermediate frames */
    window.addEventListener('message', (e) => {
        if (!e.data || typeof e.data.type !== 'string') return;
        if (!e.data.type.startsWith(PP_MSG_PREFIX)) return;

        if (e.data.type === PP_MSG_PREFIX + 'cmd') {
            // Forward commands DOWN to child iframes
            document.querySelectorAll('iframe').forEach(f => {
                try {
                    if (f.contentWindow !== e.source) {
                        f.contentWindow.postMessage(e.data, '*');
                    }
                } catch (ex) {}
            });
            // Also handle locally if we are a player
            handleCommand(e.data);
        }

        if (e.data.type === PP_MSG_PREFIX + 'evt') {
            // Handle locally if we are a host
            handleEvent(e.data);
            // Forward events UP to parent
            if (window.parent !== window) {
                try { window.parent.postMessage(e.data, '*'); } catch (ex) {}
            }
        }
    });

    // ═══════════════════════════════════════════════
    //  HOST LOGIC (outer Canvas page — creates the panel)
    // ═══════════════════════════════════════════════

    let isHost = false;
    let hostFastStepActive = false;
    let hostSolveActive    = false;

    function detectHost() {
        // We're a host if we contain a PlayPosit/WeVideo iframe or a Canvas LTI wrapper
        return !!document.querySelector(
            '.tool_content_wrapper, ' +
            'iframe[src*="wevideo.com"], iframe[src*="playposit.com"], ' +
            'iframe.tool_launch, iframe[data-lti-launch]'
        );
    }

    function setupHost() {
        if (isHost) return; // already set up
        isHost = true;
        createPanel();

        // Heartbeat to keep child frames in sync (e.g. across retakes and iframe reloads)
        setInterval(() => {
            if (isHost && hostSolveActive) {
                sendCommandDown('solve-sync', { active: true });
            }
        }, 1200);
    }

    function findPlayerContainer() {
        const candidates = [
            document.querySelector('.tool_content_wrapper'),
            document.querySelector('iframe.tool_launch'),
            document.querySelector('iframe[data-lti-launch]'),
            document.querySelector('iframe[src*="wevideo.com"]'),
            document.querySelector('iframe[src*="playposit.com"]'),
        ];
        for (const el of candidates) {
            if (el && el.isConnected) return el;
        }
        return null;
    }

    function createPanel() {
        if (document.getElementById('pp-yeeter-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'pp-yeeter-panel';
        panel.innerHTML = `
            <!-- Row 1: Video Controls -->
            <div id="pp-yeeter-video-controls">
                <button class="pp-seek-btn" id="pp-seek-back">&#9664;&#9664; 10s</button>
                <div id="pp-seekbar-wrap">
                    <input type="range" id="pp-seekbar" min="0" max="100" step="0.1" value="0">
                </div>
                <span id="pp-time-display">0:00 / 0:00</span>
                <button class="pp-seek-btn" id="pp-seek-fwd">10s &#9654;&#9654;</button>
                <select id="pp-speed-select" title="Playback speed">
                    ${Array.from({length: 20}, (_, i) => `<option value="${i+1}">${i+1}×</option>`).join('')}
                </select>
            </div>

            <!-- Row 2: Action Buttons -->
            <div id="pp-yeeter-actions">
                <button id="fast-step-btn">FastStep</button>
                <button id="solve-btn">AutoSolve</button>
            </div>

            <!-- Row 3: Status (4-Message Preserved Feed) -->
            <div id="pp-status-bar">
                <div class="pp-status-item pp-status-latest info">
                    <span class="pp-status-text">Ready. Click FastStep or AutoSolve to begin.</span>
                </div>
            </div>

            <!-- Row 4: Settings -->
            <div id="pp-settings-row">
                <button id="pp-settings-toggle" title="Settings">
                    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58
                            c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96
                            c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84
                            c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33
                            c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58
                            C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61
                            l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54
                            c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54
                            c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32
                            c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z
                            M12,15.6c-1.98,0-3.6-1.62-3.6-3.6s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6
                            S13.98,15.6,12,15.6z"/>
                    </svg>
                    Settings
                </button>
                <div id="pp-settings-panel">
                    <div class="pp-settings-checkbox-grid">
                        <label class="pp-setting-item">
                            <input type="checkbox" id="pp-setting-bg-play">
                            <label for="pp-setting-bg-play">Play in background</label>
                        </label>
                        <label class="pp-setting-item">
                            <input type="checkbox" id="pp-setting-unlimited">
                            <label for="pp-setting-unlimited">Unlimited attempts</label>
                        </label>
                        <label class="pp-setting-item">
                            <input type="checkbox" id="pp-setting-chime-pause">
                            <label for="pp-setting-chime-pause">Chime on pause</label>
                        </label>
                        <label class="pp-setting-item">
                            <input type="checkbox" id="pp-setting-chime-complete" checked>
                            <label for="pp-setting-chime-complete">Chime on complete (100%)</label>
                        </label>
                        <label class="pp-setting-item">
                            <input type="checkbox" id="pp-setting-chime-retake">
                            <label for="pp-setting-chime-retake">Chime on retake (&lt;100%)</label>
                        </label>
                    </div>

                    <!-- FastStep Mode Slider (3 stops) -->
                    <div class="pp-setting-section">
                        <label class="pp-setting-label">FastStep Mode:</label>
                        <div class="pp-slider-container">
                            <input type="range" id="pp-faststep-mode-slider" min="1" max="3" step="1" value="2">
                            <div class="pp-slider-stops">
                                <span class="pp-stop-label pp-stop-1" data-stop="1">Legacy</span>
                                <span class="pp-stop-label pp-stop-2 active" data-stop="2">Balanced</span>
                                <span class="pp-stop-label pp-stop-3" data-stop="3">Super</span>
                            </div>
                        </div>
                        <div id="pp-mode-desc" class="pp-mode-desc">Balanced: Accelerated skipping pace (45ms / 10s). Fast &amp; recommended.</div>
                    </div>

                    <!-- Auto-initialize URLs -->
                    <div class="pp-setting-section">
                        <div class="pp-setting-item" style="margin-bottom: 8px;">
                            <input type="checkbox" id="pp-setting-auto-init-enabled">
                            <label for="pp-setting-auto-init-enabled"><strong>Enable Auto-Initialization on matching URLs</strong></label>
                        </div>
                        <label class="pp-setting-label" for="pp-auto-init-input">Auto-initialize URLs (comma-separated):</label>
                        <input type="text" id="pp-auto-init-input" class="pp-text-input" placeholder="e.g. canvas.example.edu/676767">
                        <div class="pp-setting-warning">
                            <strong>Important:</strong> Do not just enter generic Canvas domains (e.g. <code>canvas.example.edu</code>). This extension interacts with video players and will affect other non-PlayPosit course videos. Include the specific course URL with the course number, for example: <code>canvas.example.edu/676767</code>.
                        </div>
                        <div class="pp-setting-hint" style="margin-top: 6px; font-size: 11px; color: #475569; line-height: 1.4;">
                            <em>When Auto-initialize is OFF, click the extension icon in your Chrome toolbar to turn on controls and inject them into this assignment tab.</em>
                        </div>
                    </div>

                    <!-- Actions row -->
                    <div class="pp-settings-actions-row">
                        <button class="pp-settings-action-btn pp-guide-btn" id="pp-open-guide-btn" type="button">User Guide &amp; Onboarding</button>
                        <button class="pp-settings-action-btn" id="pp-copy-log-btn" type="button">Copy Debug Log</button>
                        <button class="pp-settings-action-btn" id="pp-clear-answers-btn" type="button">Clear Saved Answers</button>
                    </div>

                    <!-- Settings Footer: Save & Close -->
                    <div class="pp-settings-footer-row">
                        <button class="pp-settings-action-btn pp-save-btn" id="pp-save-settings-btn" type="button">Save Settings</button>
                        <button class="pp-settings-action-btn pp-close-btn" id="pp-close-settings-btn" type="button">Close Settings</button>
                    </div>
                </div>
            </div>
        `;

        // Insert panel after the player container
        const anchor = findPlayerContainer();
        if (anchor) {
            if (anchor.parentElement) {
                anchor.parentElement.insertBefore(panel, anchor.nextSibling);
            } else {
                document.body.appendChild(panel);
            }
        } else {
            document.body.appendChild(panel);
        }

        // ── Wire up events — all send commands DOWN to the player iframe ──
        document.getElementById('fast-step-btn').addEventListener('click', () => {
            if (hostFastStepActive) {
                hostFastStepActive = false;
                const btn = document.getElementById('fast-step-btn');
                if (btn) {
                    btn.textContent = 'FastStep';
                    btn.classList.remove('active');
                }
                sendCommandDown('faststep-stop');
                reportStateToBackground();
            } else {
                sendCommandDown('faststep-toggle');
            }
        });
        document.getElementById('solve-btn').addEventListener('click', () => {
            if (hostSolveActive) {
                hostSolveActive = false;
                const btn = document.getElementById('solve-btn');
                if (btn) {
                    btn.textContent = 'AutoSolve';
                    btn.classList.remove('active');
                }
                sendCommandDown('solve-stop');
                reportStateToBackground();
            } else {
                sendCommandDown('solve-toggle');
            }
        });
        document.getElementById('pp-seek-back').addEventListener('click', () => {
            sendCommandDown('seek', { delta: -10 });
        });
        document.getElementById('pp-seek-fwd').addEventListener('click', () => {
            sendCommandDown('seek', { delta: 10 });
        });
        document.getElementById('pp-speed-select').addEventListener('change', (e) => {
            sendCommandDown('speed', { value: parseFloat(e.target.value) });
        });

        // Seekbar scrubbing
        const seekbar = document.getElementById('pp-seekbar');
        seekbar.addEventListener('mouseup', () => {
            sendCommandDown('seekbar', { percent: parseFloat(seekbar.value) });
        });
        seekbar.addEventListener('input', () => {
            sendCommandDown('seekbar', { percent: parseFloat(seekbar.value) });
        });

        document.getElementById('pp-settings-toggle').addEventListener('click', () => {
            const sp = document.getElementById('pp-settings-panel');
            if (sp) sp.classList.toggle('open');
        });

        // Settings checkboxes — save locally AND forward to player
        const cbAutoInit = document.getElementById('pp-setting-auto-init-enabled');
        const cbBg       = document.getElementById('pp-setting-bg-play');
        const cbUnl      = document.getElementById('pp-setting-unlimited');
        const cbChimeP   = document.getElementById('pp-setting-chime-pause');
        const cbChimeC   = document.getElementById('pp-setting-chime-complete');
        const cbChimeR   = document.getElementById('pp-setting-chime-retake');

        if (cbAutoInit)  cbAutoInit.checked = getSetting('autoInitEnabled', false);
        cbBg.checked     = getSetting('bgPlay', false);
        cbUnl.checked    = getSetting('unlimitedAttempts', true);
        cbChimeP.checked = getSetting('chimeOnPause', false);
        cbChimeC.checked = getSetting('chimeOnComplete', true);
        cbChimeR.checked = getSetting('chimeOnRetake', false);

        if (cbAutoInit) {
            cbAutoInit.addEventListener('change', () => {
                saveSetting('autoInitEnabled', cbAutoInit.checked);
                setHostStatus(cbAutoInit.checked ? 'Auto-initialization enabled.' : 'Auto-initialization disabled.', 'info');
            });
        }
        cbBg.addEventListener('change', () => {
            saveSetting('bgPlay', cbBg.checked);
            sendCommandDown('setting', { key: 'bgPlay', value: cbBg.checked });
            setHostStatus(cbBg.checked ? 'Background play enabled.' : 'Background play disabled.', 'info');
        });
        cbUnl.addEventListener('change', () => {
            saveSetting('unlimitedAttempts', cbUnl.checked);
            sendCommandDown('setting', { key: 'unlimitedAttempts', value: cbUnl.checked });
        });
        cbChimeP.addEventListener('change', () => {
            saveSetting('chimeOnPause', cbChimeP.checked);
            sendCommandDown('setting', { key: 'chimeOnPause', value: cbChimeP.checked });
        });
        cbChimeC.addEventListener('change', () => {
            saveSetting('chimeOnComplete', cbChimeC.checked);
            sendCommandDown('setting', { key: 'chimeOnComplete', value: cbChimeC.checked });
        });
        cbChimeR.addEventListener('change', () => {
            saveSetting('chimeOnRetake', cbChimeR.checked);
            sendCommandDown('setting', { key: 'chimeOnRetake', value: cbChimeR.checked });
        });

        // FastStep Mode Slider
        const modeSlider = document.getElementById('pp-faststep-mode-slider');
        const modeDesc = document.getElementById('pp-mode-desc');
        const updateSliderDisplay = (val) => {
            const v = parseInt(val, 10);
            document.querySelectorAll('.pp-stop-label').forEach(el => {
                el.classList.toggle('active', parseInt(el.dataset.stop, 10) === v);
            });
            if (v === 1) {
                modeDesc.textContent = 'Legacy: Standard skipping pace (90ms / 5s). Proven & stable.';
            } else if (v === 2) {
                modeDesc.textContent = 'Balanced: Accelerated skipping pace (45ms / 10s). Fast & recommended.';
            } else if (v === 3) {
                modeDesc.textContent = 'Super: Immediately seeks toward the end to snap to upcoming questions. Experimental.';
            }
        };

        const currentMode = parseInt(getSetting('fastStepMode', 2), 10);
        modeSlider.value = currentMode;
        updateSliderDisplay(currentMode);

        modeSlider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            updateSliderDisplay(val);
            saveSetting('fastStepMode', val);
            sendCommandDown('setting', { key: 'fastStepMode', value: val });
        });

        document.querySelectorAll('.pp-stop-label').forEach(el => {
            el.addEventListener('click', () => {
                const val = parseInt(el.dataset.stop, 10);
                modeSlider.value = val;
                updateSliderDisplay(val);
                saveSetting('fastStepMode', val);
                sendCommandDown('setting', { key: 'fastStepMode', value: val });
            });
        });

        // Auto-initialize URLs Input
        const autoInitInput = document.getElementById('pp-auto-init-input');
        if (autoInitInput) {
            autoInitInput.value = getSetting('activationUrls', '');
            autoInitInput.addEventListener('change', () => {
                const val = autoInitInput.value.trim();
                saveSetting('activationUrls', val);
                setHostStatus('Auto-initialize URLs updated.', 'ok');
            });
        }

        // Open Guide / Onboarding button
        const btnGuide = document.getElementById('pp-open-guide-btn');
        if (btnGuide) {
            btnGuide.addEventListener('click', () => {
                try {
                    chrome.runtime.sendMessage({ type: 'open-onboarding' });
                } catch (e) {
                    window.open(chrome.runtime.getURL('onboarding.html'), '_blank');
                }
            });
        }

        const btnCopyLog = document.getElementById('pp-copy-log-btn');
        if (btnCopyLog) {
            btnCopyLog.addEventListener('click', async () => {
                const text = formatLogsForExport();
                try {
                    await navigator.clipboard.writeText(text);
                    setHostStatus('Debug log copied to clipboard!', 'ok');
                } catch (e) {
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    ta.style.position = 'fixed';
                    ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    ta.remove();
                    setHostStatus('Debug log copied to clipboard!', 'ok');
                }
            });
        }

        const btnClear = document.getElementById('pp-clear-answers-btn');
        if (btnClear) {
            btnClear.addEventListener('click', () => {
                localStorage.removeItem('pp_yeeter_answers');
                localStorage.removeItem('pp_yeeter_wrong_answers');
                localStorage.removeItem('pp_yeeter_pending');
                sendCommandDown('clear-answers');
                setHostStatus('Saved answers cleared from all frames.', 'ok');
            });
        }

        // Save Settings button
        const btnSave = document.getElementById('pp-save-settings-btn');
        if (btnSave) {
            btnSave.addEventListener('click', () => {
                const autoInit = cbAutoInit ? cbAutoInit.checked : false;
                const bgPlay = cbBg ? cbBg.checked : false;
                const unl = cbUnl ? cbUnl.checked : true;
                const chimeP = cbChimeP ? cbChimeP.checked : false;
                const chimeC = cbChimeC ? cbChimeC.checked : true;
                const chimeR = cbChimeR ? cbChimeR.checked : false;
                const mode = parseInt(modeSlider.value, 10) || 2;
                const urls = autoInitInput ? autoInitInput.value.trim() : '';

                saveSetting('autoInitEnabled', autoInit);
                saveSetting('bgPlay', bgPlay);
                saveSetting('unlimitedAttempts', unl);
                saveSetting('chimeOnPause', chimeP);
                saveSetting('chimeOnComplete', chimeC);
                saveSetting('chimeOnRetake', chimeR);
                saveSetting('fastStepMode', mode);
                saveSetting('activationUrls', urls);

                sendCommandDown('setting', { key: 'bgPlay', value: bgPlay });
                sendCommandDown('setting', { key: 'unlimitedAttempts', value: unl });
                sendCommandDown('setting', { key: 'chimeOnPause', value: chimeP });
                sendCommandDown('setting', { key: 'chimeOnComplete', value: chimeC });
                sendCommandDown('setting', { key: 'chimeOnRetake', value: chimeR });
                sendCommandDown('setting', { key: 'fastStepMode', value: mode });

                setHostStatus('Settings saved successfully.', 'ok');
                btnSave.textContent = 'Saved!';
                setTimeout(() => {
                    btnSave.textContent = 'Save Settings';
                }, 1500);
            });
        }

        // Close Settings button
        const btnClose = document.getElementById('pp-close-settings-btn');
        if (btnClose) {
            btnClose.addEventListener('click', () => {
                const sp = document.getElementById('pp-settings-panel');
                if (sp) sp.classList.remove('open');
            });
        }
    }

    /** Update the host panel UI from an event received from the player */
    function handleEvent(msg) {
        if (!isHost) return;

        switch (msg.evt) {
            case 'time-update': {
                const seekbar = document.getElementById('pp-seekbar');
                const timeEl  = document.getElementById('pp-time-display');
                if (seekbar && msg.duration) {
                    seekbar.value = (msg.currentTime / msg.duration) * 100;
                }
                if (timeEl) {
                    timeEl.textContent = `${formatTime(msg.currentTime)} / ${formatTime(msg.duration)}`;
                }
                break;
            }
            case 'status': {
                setHostStatus(msg.msg, msg.statusType || '');
                break;
            }
            case 'player-ready': {
                if (hostSolveActive) {
                    logDebug("Host", "Player frame ready; dispatching solve-sync");
                    sendCommandDown('solve-sync', { active: true });
                }
                break;
            }
            case 'faststep-state': {
                hostFastStepActive = msg.active;
                const btn = document.getElementById('fast-step-btn');
                if (btn) {
                    if (msg.active) {
                        btn.textContent = 'Stepping…';
                        btn.classList.add('active');
                    } else {
                        btn.textContent = 'FastStep';
                        btn.classList.remove('active');
                    }
                }
                reportStateToBackground();
                break;
            }
            case 'solve-state': {
                hostSolveActive = msg.active;
                const btn = document.getElementById('solve-btn');
                if (btn) {
                    if (msg.active) {
                        btn.textContent = msg.text || 'Waiting…';
                        btn.classList.add('active');
                    } else {
                        btn.textContent = 'AutoSolve';
                        btn.classList.remove('active');
                        // Broadcast to other frames to shut down their phantom guessers
                        sendCommandDown('solve-stop');
                    }
                }
                reportStateToBackground();
                break;
            }
            case 'solve-text': {
                const btn = document.getElementById('solve-btn');
                if (btn) btn.textContent = msg.text;
                break;
            }
            case 'debug-log': {
                if (msg.entry) {
                    storeHostDebugLog(msg.entry);
                }
                break;
            }
        }
    }

    const hostStatusHistory = [];
    const MAX_STATUS_HISTORY = 4;

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function setHostStatus(msg, type) {
        const bar = document.getElementById('pp-status-bar');
        if (!bar) return;

        const now = new Date();
        const timeStr = now.toTimeString().split(' ')[0];

        const last = hostStatusHistory[hostStatusHistory.length - 1];
        if (last && last.msg === msg && last.time === timeStr) {
            return;
        }

        hostStatusHistory.push({
            msg: msg,
            type: type || 'info',
            time: timeStr
        });

        if (hostStatusHistory.length > MAX_STATUS_HISTORY) {
            hostStatusHistory.shift();
        }

        renderHostStatusBar();
    }

    function renderHostStatusBar() {
        const bar = document.getElementById('pp-status-bar');
        if (!bar) return;

        if (hostStatusHistory.length === 0) {
            bar.innerHTML = `<div class="pp-status-item pp-status-latest info">
                <span class="pp-status-text">Ready. Click FastStep or AutoSolve to begin.</span>
            </div>`;
            return;
        }

        bar.innerHTML = hostStatusHistory.map((item, idx) => {
            const isLatest = (idx === hostStatusHistory.length - 1);
            const cls = isLatest ? `pp-status-item pp-status-latest ${item.type}` : `pp-status-item pp-status-history`;
            return `<div class="${cls}">
                <span class="pp-status-time">[${item.time}]</span>
                <span class="pp-status-text">${escapeHtml(item.msg)}</span>
            </div>`;
        }).join('');
    }

    // ═══════════════════════════════════════════════
    //  PLAYER LOGIC (inside iframe — has the video)
    // ═══════════════════════════════════════════════

    let isPlayer = false;

    /** Handle a command received from the host panel */
    function handleCommand(msg) {
        // We no longer block on !isPlayer because the question UI 
        // may be in a different iframe than the video.
        switch (msg.cmd) {
            case 'faststep-toggle':
                toggleFastStep();
                break;
            case 'faststep-stop':
                fastStepManuallyStopped = true;
                if (resumeVideoCheckInterval) {
                    clearInterval(resumeVideoCheckInterval);
                    resumeVideoCheckInterval = null;
                }
                if (fastStepInterval) {
                    stopFastStep(true);
                }
                {
                    const v = getVideo();
                    if (v && !v.paused) {
                        try { v.pause(); } catch (e) {}
                    }
                }
                sendEventUp('faststep-state', { active: false });
                sendEventUp('status', { msg: 'FastStep paused.', statusType: 'warn' });
                break;
            case 'solve-toggle':
                toggleSolve();
                break;
            case 'solve-sync':
            case 'solve-start':
                if ((msg.active || msg.cmd === 'solve-start') && !guesser.active && !(window === window.top && !isPlaypositDomain)) {
                    logDebug("Sync", "Received solve-sync from host; activating AutoSolve in player frame");
                    guesser.start();
                }
                break;
            case 'solve-stop':
                if (guesser.active) guesser.stop();
                break;
            case 'clear-answers':
                localStorage.removeItem('pp_yeeter_answers');
                localStorage.removeItem('pp_yeeter_wrong_answers');
                localStorage.removeItem('pp_yeeter_pending');
                logDebug("Storage", "Cleared saved answers across iframe storage");
                break;

            case 'seek': {
                const vid = getVideo();
                if (vid && vid.duration) {
                    vid.currentTime = Math.max(0, Math.min(vid.duration, vid.currentTime + (msg.delta || 0)));
                }
                break;
            }
            case 'seekbar': {
                const vid = getVideo();
                if (vid && vid.duration) {
                    vid.currentTime = (msg.percent / 100) * vid.duration;
                }
                break;
            }
            case 'speed': {
                const vid = getVideo();
                if (vid) {
                    vid.playbackRate = msg.value || 1;
                    sendEventUp('status', { msg: `Playback speed: ${msg.value}×`, statusType: 'info' });
                }
                break;
            }
            case 'setting': {
                saveSetting(msg.key, msg.value);
                break;
            }
        }
    }

    function setupPlayer() {
        if (isPlayer) return;
        isPlayer = true;
        // Start sending time updates to the host
        setInterval(() => {
            const vid = getVideo();
            if (vid && vid.duration && !isNaN(vid.duration)) {
                sendEventUp('time-update', {
                    currentTime: vid.currentTime,
                    duration:    vid.duration
                });
            }
        }, 300);
    }

    function getVideo() {
        // PlayPosit keeps old/hidden <video> elements around across attempts.
        // Release sticky selection if currentVideo is disconnected, ended, or finished
        if (currentVideo && (!currentVideo.isConnected || currentVideo.ended || currentVideo.offsetParent === null)) {
            currentVideo = null;
        }

        const vids = Array.from(document.querySelectorAll('video')).filter(v => v.isConnected);
        if (vids.length === 0) return null;

        // If there are unended videos available, completely ignore finished/ended videos
        const unendedVids = vids.filter(v => !v.ended && !(v.duration && v.currentTime >= v.duration - 0.5));
        const pool = unendedVids.length > 0 ? unendedVids : vids;

        let best = null, bestScore = -Infinity;
        for (const v of pool) {
            const isVisible = isElementVisible(v);
            if (!isVisible && pool.length > 1) continue;

            const r = v.getBoundingClientRect();
            let score = isVisible ? (r.width * r.height) : 0;

            // Prioritize playing, active, unended video
            if (!v.ended && !v.paused) score += 1e9;
            if (!v.ended && v.currentTime > 0) score += 1e6;
            if (!v.ended && currentVideo && v === currentVideo) score += 5e8; // Sticky preference ONLY for active video
            if (v.ended || (v.duration && v.currentTime >= v.duration - 0.5)) score -= 1e11; // Heavy penalty for finished video

            if (score > bestScore) {
                bestScore = score;
                best = v;
            }
        }

        if (best && !best.ended) {
            currentVideo = best;
        } else if (!best && pool.length > 0) {
            best = pool[0];
            if (!best.ended) currentVideo = best;
        }

        return best;
    }

    function isElementVisible(el) {
        if (!el) return false;
        if (!el.offsetWidth && !el.offsetHeight && !el.getClientRects().length) return false;
        if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false;
        try {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        } catch (e) {}
        return true;
    }

    function isExcludedControlBtn(el) {
        if (!el) return true;
        if (el.id === 'play-pause' || el.closest('#controls-wrapper') || el.closest('.playposit-video-controls') || el.closest('.vjs-control-bar') || el.closest('#controls')) {
            return true;
        }
        return false;
    }

    function getActiveQuestionContainer() {
        const candidates = [
            document.querySelector('.interaction.active'),
            document.querySelector('.v-dialog--active'),
            document.querySelector('.interaction-view.active'),
            document.querySelector('.interactions-wrapper .interaction.active')
        ];
        for (const c of candidates) {
            if (c && isElementVisible(c)) return c;
        }
        // Fallback: only if visibly displayed with positive dimensions and active inputs/buttons
        const activeModals = Array.from(document.querySelectorAll('.interaction, .question-app, .q')).filter(el => {
            if (!isElementVisible(el)) return false;
            // Must have visible inputs or buttons inside and positive dimensions
            const hasInputs = el.querySelectorAll('input[type="checkbox"], input[type="radio"]').length > 0;
            const hasBtns = el.querySelectorAll('button, .v-btn').length > 0;
            const r = el.getBoundingClientRect();
            return (hasInputs || hasBtns) && r.width > 120 && r.height > 60;
        });
        return activeModals.length > 0 ? activeModals[0] : null;
    }

    function hasActiveQuestion() {
        const container = getActiveQuestionContainer();
        if (!container) return false;
        const inputs = container.querySelectorAll('input[type="checkbox"], input[type="radio"]');
        for (const inp of inputs) {
            if (isElementVisible(inp) || (inp.parentElement && isElementVisible(inp.parentElement))) return true;
        }
        const buttons = container.querySelectorAll('button, .v-btn');
        for (const btn of buttons) {
            if (isElementVisible(btn) && !isExcludedControlBtn(btn)) {
                const txt = (btn.innerText || btn.textContent || '').trim().toLowerCase();
                if (txt.includes('submit') || txt.includes('retry') || txt.includes('continue') || txt.includes('next')) {
                    return true;
                }
            }
        }
        const title = container.querySelector('.pp-interaction-title, .interaction-title, .q-title');
        if (title && isElementVisible(title) && (title.innerText || '').trim().length > 0) {
            return true;
        }
        return false;
    }

    function findStartButton() {
        // 1. PlayPosit primary start button
        const initPlay = document.getElementById('initialize-play');
        if (initPlay && isElementVisible(initPlay) && !isExcludedControlBtn(initPlay)) return initPlay;

        // 2. PlayPosit big play overlays
        const bigPlay = document.querySelector('.vjs-big-play-button, .pp-ui-big-play-button, [aria-label*="Start playback" i]');
        if (bigPlay && isElementVisible(bigPlay) && !isExcludedControlBtn(bigPlay)) return bigPlay;

        // 3. Icon buttons (play_arrow) strictly outside control bar and outside interactions
        const iconBtns = Array.from(document.querySelectorAll('i.material-icons, i.v-icon'));
        for (const icon of iconBtns) {
            if (isExcludedControlBtn(icon) || icon.closest('.interaction')) continue;
            const text = (icon.innerText || icon.textContent || '').trim();
            if (text === 'play_arrow' || text === 'play_circle_filled') {
                const btn = icon.closest('button') || icon.closest('.v-btn') || icon.parentElement;
                if (btn && isElementVisible(btn) && !isExcludedControlBtn(btn) && !btn.closest('.interaction')) {
                    return btn;
                }
            }
        }

        // 4. Buttons with text "Start" or "Begin"
        const buttons = Array.from(document.querySelectorAll('button, .v-btn, [role="button"]'));
        for (const btn of buttons) {
            if (!isElementVisible(btn) || isExcludedControlBtn(btn) || btn.closest('.interaction')) continue;
            const t = (btn.innerText || btn.textContent || '').trim().toLowerCase();
            if (t === 'start' || t === 'begin') return btn;
            const cls = (typeof btn.className === 'string') ? btn.className.toLowerCase() : '';
            if (cls.includes('big-play') || cls.includes('hero-play')) return btn;
        }
        return null;
    }

    // ─────────────────────────────────────────────
    //  FastStep Logic
    // ─────────────────────────────────────────────

    function toggleFastStep() {
        if (fastStepInterval) {
            fastStepManuallyStopped = true;
            if (resumeVideoCheckInterval) {
                clearInterval(resumeVideoCheckInterval);
                resumeVideoCheckInterval = null;
            }
            stopFastStep(true);
            const v = getVideo();
            if (v && !v.paused) {
                try { v.pause(); } catch (e) {}
            }
            sendEventUp('faststep-state', { active: false });
            sendEventUp('status', { msg: 'FastStep paused.', statusType: 'warn' });
        } else {
            fastStepManuallyStopped = false;
            currentVideo = getVideo();
            if (!currentVideo) {
                // Silently ignore in frames without a video
                return;
            }

            const startBtn = findStartButton();
            if (startBtn) {
                logDebug("FastStep", "Triggering start button from FastStep activation");
                startBtn.click();
            }

            if (currentVideo.paused) {
                currentVideo.play().then(() => {
                    startFastStepLoop();
                }).catch(err => {
                    logDebug("FastStep", "Could not play video: " + err.message);
                    sendEventUp('status', { msg: 'Could not play video.', statusType: 'error' });
                });
            } else {
                startFastStepLoop();
            }

            sendEventUp('faststep-state', { active: true });
            sendEventUp('status', { msg: 'FastStep running – video will pause at interactions.', statusType: 'info' });
        }
        reportStateToBackground();
    }

    function getFastStepConfig() {
        const mode = parseInt(getSetting('fastStepMode', 2), 10);
        if (mode === 3) {
            // Super: Jump to next interaction point
            return { mode: 3, interval: 60, skip: 0 };
        } else if (mode === 1) {
            // Legacy: Standard pace (90ms / 5s)
            return { mode: 1, interval: 90, skip: 5 };
        } else {
            // Balanced (default): Accelerated skipping (45ms / 10s)
            return { mode: 2, interval: 45, skip: 10 };
        }
    }

    let timeUpdateListenerVideo = null;
    let timeUpdateHandler = null;

    function startFastStepLoop() {
        if (resumeVideoCheckInterval) {
            clearInterval(resumeVideoCheckInterval);
            resumeVideoCheckInterval = null;
        }
        if (fastStepInterval) clearInterval(fastStepInterval);
        if (timeUpdateListenerVideo && timeUpdateHandler) {
            try { timeUpdateListenerVideo.removeEventListener('timeupdate', timeUpdateHandler); } catch (e) {}
            timeUpdateListenerVideo = null;
            timeUpdateHandler = null;
        }

        let stallTicks = 0;
        reportStateToBackground();

        let activeVid = getVideo();
        if (!activeVid) {
            stopFastStep();
            return;
        }

        const config = getFastStepConfig();

        const stepTick = () => {
            if (!fastStepInterval && !timeUpdateListenerVideo) return;

            // Re-acquire video only if activeVid becomes disconnected or ended
            if (!activeVid || !activeVid.isConnected || activeVid.ended) {
                activeVid = getVideo();
                if (!activeVid || activeVid.ended) {
                    stopFastStep();
                    return;
                }
            }

            const vid = activeVid;

            // 1. Check if assignment reached 100% completion
            if (isAssignment100Complete()) {
                logDebug("FastStep", "Assignment 100% complete detected in FastStep loop; halting.");
                stopFastStep(true);
                sendEventUp('faststep-state', { active: false });
                if (getSetting('chimeOnComplete', true)) {
                    playCompletionChime();
                }
                sendEventUp('status', { msg: 'Assignment Complete! 100% Score achieved.', statusType: 'ok' });
                if (guesser.active) guesser.stop();
                return;
            }

            // 2. End detection: video ended or reached end of duration
            if (vid.ended || (vid.duration > 0 && vid.currentTime >= vid.duration - 0.3)) {
                logDebug("FastStep", "Video reached end of playback; stopping FastStep", { currentTime: vid.currentTime, duration: vid.duration });
                stopFastStep();
                sendEventUp('faststep-state', { active: false });
                return;
            }

            // 3. If the video is buffering or seeking, don't perform any checks or skips this tick
            if (vid.readyState < 3 || vid.seeking) return;

            // 4. Pause Detection
            if (vid.paused || vid.ended) {
                if (vid.ended || (vid.duration > 0 && vid.currentTime >= vid.duration - 0.5) || hasActiveQuestion() || !guesser.active) {
                    logDebug("FastStep", "Video paused (interaction or ended)", { paused: vid.paused, ended: vid.ended });
                    stopFastStep();
                    sendEventUp('faststep-state', { active: false });
                    if (guesser.active && !guesser.busy && hasActiveQuestion()) {
                        guesser.tick();
                    }
                    return;
                }

                // Buffer/stall retry
                stallTicks++;
                if (stallTicks < 35) {
                    vid.play().catch(() => {});
                    return;
                }

                // Stalled > 3s without a question
                logDebug("FastStep", "Playback stalled for >3s without interaction; halting FastStep & AutoSolve");
                stopFastStep();
                sendEventUp('faststep-state', { active: false });
                if (guesser.active) {
                    guesser.stop();
                    sendEventUp('status', { msg: 'Playback stalled (no question detected). AutoSolve stopped.', statusType: 'warn' });
                }
                return;
            }

            stallTicks = 0;

            if (config.mode === 3) {
                // Mode 3: Super (Experimental)
                // Seek forward toward the end of the video. PlayPosit catches any forward seek
                // that crosses an unanswered question and forces the playback to halt at the question!
                const targetTime = Math.max(0, vid.duration - 0.2);
                if (vid.currentTime < targetTime - 0.8) {
                    vid.currentTime = targetTime;
                } else if (vid.currentTime + 5 < vid.duration) {
                    vid.currentTime += 5;
                } else {
                    vid.currentTime = vid.duration;
                    stopFastStep();
                    sendEventUp('faststep-state', { active: false });
                }
            } else {
                // Mode 1 (Legacy) or Mode 2 (Balanced)
                const skipAmount = config.skip || 5;
                if (vid.currentTime + skipAmount < vid.duration) {
                    vid.currentTime += skipAmount;
                } else {
                    vid.currentTime = vid.duration;
                    logDebug("FastStep", "Reached end of video; stopping FastStep");
                    stopFastStep();
                    sendEventUp('faststep-state', { active: false });
                }
            }
        };

        fastStepInterval = setInterval(stepTick, config.interval);

        // Power-saving throttle bypass: listen to video decode timeupdate events
        // Native media decoding events are not clamped by browser background timer throttling
        timeUpdateListenerVideo = activeVid;
        timeUpdateHandler = () => {
            if (!fastStepInterval) return;
            stepTick();
        };
        try { activeVid.addEventListener('timeupdate', timeUpdateHandler); } catch (e) {}
    }

    function stopFastStep(skipPauseChime = false) {
        if (resumeVideoCheckInterval) {
            clearInterval(resumeVideoCheckInterval);
            resumeVideoCheckInterval = null;
        }
        if (timeUpdateListenerVideo && timeUpdateHandler) {
            try { timeUpdateListenerVideo.removeEventListener('timeupdate', timeUpdateHandler); } catch (e) {}
            timeUpdateListenerVideo = null;
            timeUpdateHandler = null;
        }
        if (fastStepInterval) {
            clearInterval(fastStepInterval);
            fastStepInterval = null;
            if (!skipPauseChime && getSetting('chimeOnPause', false)) {
                playPauseChime();
            }
            if (!skipPauseChime && !guesser.active) {
                sendEventUp('status', { msg: 'Paused — interaction required or video ended.', statusType: 'warn' });
            }
        }
        reportStateToBackground();
    }

    let resumeVideoCheckInterval = null;
    function resumeFastStepWhenVideoPlays() {
        if (fastStepManuallyStopped || !isAutomationActive()) return;
        if (resumeVideoCheckInterval) clearInterval(resumeVideoCheckInterval);
        let checks = 0;
        const maxChecks = 40; // 20 seconds
        resumeVideoCheckInterval = setInterval(() => {
            if (fastStepManuallyStopped || !isAutomationActive()) {
                clearInterval(resumeVideoCheckInterval);
                resumeVideoCheckInterval = null;
                return;
            }
            checks++;
            const vid = getVideo();
            if (vid) {
                if (vid.paused) {
                    vid.play().catch(() => {});
                }
                if (!vid.paused && vid.currentTime > 0 && !vid.ended) {
                    logDebug("FastStep", "Video confirmed playing. Starting FastStep loop.");
                    clearInterval(resumeVideoCheckInterval);
                    resumeVideoCheckInterval = null;
                    startFastStepLoop();
                    sendEventUp('faststep-state', { active: true });
                    sendEventUp('status', { msg: 'FastStep running – video will pause at interactions.', statusType: 'info' });
                    return;
                }
            }
            if (checks >= maxChecks) {
                clearInterval(resumeVideoCheckInterval);
                resumeVideoCheckInterval = null;
            }
        }, 500);
    }

    // ─────────────────────────────────────────────
    //  Chime Synthesis & Completion Check
    // ─────────────────────────────────────────────

    function isAssignment100Complete() {
        const bodyText = (document.body ? document.body.innerText : '') || '';
        const has100 = bodyText.includes('100%') ||
                       bodyText.includes('Score: 100') ||
                       bodyText.includes('100 / 100') ||
                       bodyText.includes('100/100');
        const hasComplete = bodyText.includes('Complete!') ||
                            bodyText.includes('Completed assignment') ||
                            bodyText.includes('Assignment complete') ||
                            !!document.querySelector('.complete-circle, [class*="complete"]');

        const vid = getVideo();
        const vidEnded = isVideoEnded(vid);

        return has100 && (hasComplete || vidEnded);
    }

    // Softened Alert Chime (Intelligent 6s rate-limiting + gentle dual harmonic bell)
    let lastPauseChimeTime = 0;
    const PAUSE_CHIME_COOLDOWN_MS = 6000; // 6-second cooldown prevents repeated spamming during question series

    function playPauseChime() {
        const now = Date.now();
        // Cross-frame coordination via sessionStorage with local fallback
        try {
            const last = parseInt(sessionStorage.getItem('pp_yeeter_last_pause_chime') || '0', 10);
            if (now - last < PAUSE_CHIME_COOLDOWN_MS) {
                logDebug("Chime", "Softened chime suppressed (cooldown active)");
                return;
            }
            sessionStorage.setItem('pp_yeeter_last_pause_chime', now.toString());
        } catch (e) {
            if (now - lastPauseChimeTime < PAUSE_CHIME_COOLDOWN_MS) {
                logDebug("Chime", "Softened chime suppressed (local cooldown active)");
                return;
            }
            lastPauseChimeTime = now;
        }

        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            const ctx = new AudioContext();

            // Gentle 2-tone bell chime (F#5 -> A5): warm, soft, non-piercing
            const notes = [
                { freq: 739.99, time: 0.00, dur: 0.35, gain: 0.045 }, // F#5
                { freq: 880.00, time: 0.09, dur: 0.50, gain: 0.050 }  // A5
            ];

            for (const n of notes) {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.type = 'sine';
                osc.frequency.setValueAtTime(n.freq, ctx.currentTime + n.time);

                const startTime = ctx.currentTime + n.time;
                const endTime = startTime + n.dur;

                // Soft attack ramp (30ms) to eliminate audio clicks, followed by smooth exponential decay
                gain.gain.setValueAtTime(0.0001, startTime);
                gain.gain.exponentialRampToValueAtTime(n.gain, startTime + 0.03);
                gain.gain.exponentialRampToValueAtTime(0.0001, endTime);

                osc.start(startTime);
                osc.stop(endTime);
            }
        } catch (e) {}
    }

    // Alias for backward compatibility
    function playChimeSequence() {
        playPauseChime();
    }

    // Satisfying ascending victory chord (C5 - E5 - G5 - C6) for 100% completion
    function playCompletionChime() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            const ctx = new AudioContext();
            const notes = [
                { freq: 523.25, time: 0.00, dur: 0.25 }, // C5
                { freq: 659.25, time: 0.12, dur: 0.25 }, // E5
                { freq: 783.99, time: 0.24, dur: 0.25 }, // G5
                { freq: 1046.50, time: 0.36, dur: 1.10 }, // C6
                { freq: 1318.51, time: 0.36, dur: 1.10 }  // E6 harmony
            ];

            for (const n of notes) {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.type = 'sine';
                osc.frequency.setValueAtTime(n.freq, ctx.currentTime + n.time);

                const startTime = ctx.currentTime + n.time;
                const endTime = startTime + n.dur;

                gain.gain.setValueAtTime(0.001, startTime);
                gain.gain.exponentialRampToValueAtTime(0.18, startTime + 0.04);
                gain.gain.exponentialRampToValueAtTime(0.0001, endTime);

                osc.start(startTime);
                osc.stop(endTime);
            }
        } catch (e) {}
    }

    // Gentle 2-tone notification (A4 -> D5) for retake reset
    function playRetakeChime() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            const ctx = new AudioContext();
            const notes = [
                { freq: 440.00, time: 0.00, dur: 0.25 }, // A4
                { freq: 587.33, time: 0.16, dur: 0.60 }  // D5
            ];

            for (const n of notes) {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.type = 'sine';
                osc.frequency.setValueAtTime(n.freq, ctx.currentTime + n.time);

                const startTime = ctx.currentTime + n.time;
                const endTime = startTime + n.dur;

                gain.gain.setValueAtTime(0.001, startTime);
                gain.gain.exponentialRampToValueAtTime(0.12, startTime + 0.03);
                gain.gain.exponentialRampToValueAtTime(0.0001, endTime);

                osc.start(startTime);
                osc.stop(endTime);
            }
        } catch (e) {}
    }

    // ─────────────────────────────────────────────
    //  AutoSolve toggle
    // ─────────────────────────────────────────────

    function reportStateToBackground(overrideSolve = null, overrideFastStep = null) {
        try {
            const solveActive = overrideSolve !== null ? !!overrideSolve : (isHost ? hostSolveActive : guesser.active);
            const fastStepActive = overrideFastStep !== null ? !!overrideFastStep : (isHost ? hostFastStepActive : !!fastStepInterval);
            chrome.runtime.sendMessage({
                type: 'yeeter-state-update',
                solveActive,
                fastStepActive
            });
        } catch (e) { /* extension context invalidated */ }
    }

    function toggleSolve() {
        if (guesser.active) {
            guesser.stop();
        } else {
            guesser.start();
        }
        reportStateToBackground();
    }

    // ─────────────────────────────────────────────
    //  Autoplay Monitor & Activity Guard
    // ─────────────────────────────────────────────

    function isAutomationActive() {
        return !!(guesser && guesser.active) || !!fastStepInterval;
    }

    function isVideoEnded(video) {
        if (!video) return false;
        return !!(video.ended || (video.duration > 0 && video.currentTime >= video.duration - 0.5));
    }

    function ensureVideoPlays(video) {
        if (!isAutomationActive() || fastStepManuallyStopped) return;
        if (!video || isVideoInProgress(video) || hasActiveQuestion() || isVideoEnded(video)) return;
        if (video.hasAttribute('data-yeeter-monitoring')) return;
        video.setAttribute('data-yeeter-monitoring', 'true');

        logDebug("Autoplay", "Starting autoplay monitor for video", { currentTime: video.currentTime });

        setTimeout(() => {
            let attempts = 0;
            const maxAttempts = 20;

            const interval = setInterval(() => {
                if (!isAutomationActive() || fastStepManuallyStopped || !video.isConnected || isVideoInProgress(video) || hasActiveQuestion() || isVideoEnded(video)) {
                    clearInterval(interval);
                    video.removeAttribute('data-yeeter-monitoring');
                    return;
                }

                if (!video.paused && video.currentTime > 0 && !isVideoEnded(video)) {
                    logDebug("Autoplay", "Video is playing correctly. Stopping monitor.");
                    clearInterval(interval);
                    video.removeAttribute('data-yeeter-monitoring');
                    if (guesser.active && !fastStepInterval) {
                        startFastStepLoop();
                        sendEventUp('faststep-state', { active: true });
                        sendEventUp('status', { msg: 'FastStep running – video will pause at interactions.', statusType: 'info' });
                    }
                    return;
                }

                attempts++;
                if (attempts > maxAttempts) {
                    logDebug("Autoplay", "Autoplay monitor timed out. Removing monitoring lock.");
                    clearInterval(interval);
                    video.removeAttribute('data-yeeter-monitoring');
                    return;
                }

                const startBtn = findStartButton();
                if (startBtn) {
                    logDebug("Autoplay", "Clicking start button from autoplay monitor", { btn: startBtn.id || startBtn.className });
                    startBtn.click();
                }

                video.play().catch(e => {
                    if (e.name !== 'AbortError') logDebug("Autoplay", "Direct play() failed: " + e.message);
                });

                if (!video.controls) video.controls = true;
                video.style.visibility = 'visible';
                video.style.opacity = '1';

            }, 500);
        }, 1500);
    }

    // ─────────────────────────────────────────────
    //  checkForVideoAndExtras
    // ─────────────────────────────────────────────

    function isVideoInProgress(video) {
        if (!video || !video.isConnected || video.offsetParent === null || isVideoEnded(video)) return false;
        return !video.paused || video.currentTime > 0.5;
    }

    function checkForVideoAndExtras() {
        const video = getVideo();
        const isVideoVisible = video && video.offsetParent !== null;

        if (isVideoVisible) {
            setupPlayer();
            if (isAutomationActive()) {
                ensureVideoPlays(video);
            }

            // Remove blockers / Enable interaction
            const wrappers = document.querySelectorAll('.pp-ui-layer, .pp-ui-click-layer, .pp-ui-standard');
            wrappers.forEach(el => {
                el.style.pointerEvents = 'none';
            });

            const controls = document.querySelectorAll('.noUI-handle, .vjs-control-bar, .playposit-video-controls');
            controls.forEach(el => {
                el.style.display = 'none';
                el.style.pointerEvents = 'none';
            });

            const overlay = document.querySelector('.video-overlay');
            if (overlay) {
                overlay.style.display = 'none';
                overlay.style.pointerEvents = 'none';
            }
        }

        if (detectHost()) {
            setupHost();
        }

        // Only click start buttons if automation is active, video is NOT in progress, NO question is active, and video has not ended
        if (isAutomationActive() && !isVideoInProgress(video) && !hasActiveQuestion() && !isVideoEnded(video)) {
            const startBtn = findStartButton();
            if (startBtn) {
                const now = Date.now();
                const lastClicked = parseInt(startBtn.getAttribute('data-yeeter-clicked') || '0', 10);
                if (now - lastClicked > 4000) {
                    startBtn.setAttribute('data-yeeter-clicked', now.toString());
                    logDebug("StartBtn", "Found Start Button. Clicking in 800ms...", { id: startBtn.id, text: (startBtn.innerText || '').trim() });
                    setTimeout(() => {
                        if (!isAutomationActive() || isVideoInProgress(getVideo()) || hasActiveQuestion()) return;
                        startBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                        setTimeout(() => {
                            startBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                            startBtn.click();
                            setTimeout(() => {
                                const vid = getVideo();
                                if (vid) {
                                    vid.removeAttribute('data-yeeter-monitoring');
                                    if (isAutomationActive()) {
                                        ensureVideoPlays(vid);
                                        vid.play().catch(() => {});
                                    }
                                }
                                if (guesser.active) {
                                    resumeFastStepWhenVideoPlays();
                                }
                            }, 300);
                        }, 50);
                    }, 800);
                }
            }
        }
    }

    // ─────────────────────────────────────────────
    //  Guesser Logic — DO NOT ALTER CORE SOLVE LOGIC
    // ─────────────────────────────────────────────
    class Guesser {
        constructor() {
            this.active = false;
            this.interval = null;
            this.combinations = [];
            this.currentComboIndex = 0;
            this.busy = false;
            this.lastQuestionId = null;
            this.currentLabels = [];
            this.lastAttemptedCombo = null;
            this.lastQuestionKey = null;
            this.awaitingRetakeConfirm = false;

        }

        start() {
            if (this.active) return;
            // Host LMS window should never run Guesser
            if (window === window.top && !isPlaypositDomain) return;

            this.active = true;
            fastStepManuallyStopped = false;

            this.currentComboIndex = 0;
            this.combinations = [];
            this.currentLabels = [];
            this.awaitingRetakeConfirm = false;
            if (this.interval) clearInterval(this.interval);
            this.interval = setInterval(() => this.tick(), 120);
            logDebug("Guesser", "AutoSolve started");

            // Engage video playback if unstarted or paused, or start FastStep if already playing
            const vid = getVideo();
            if (!isVideoInProgress(vid) && !hasActiveQuestion() && !isVideoEnded(vid)) {
                this._tryClickStartButton();
            } else if (vid && !vid.paused && !vid.ended && !fastStepInterval && !hasActiveQuestion()) {
                startFastStepLoop();
                sendEventUp('faststep-state', { active: true });
            }

            sendEventUp('solve-state', { active: true, text: 'Waiting…' });
            sendEventUp('status', { msg: 'AutoSolve active – waiting for question.', statusType: 'ok' });
            reportStateToBackground();
        }

        stop() {
            if (!this.active) return;
            this.active = false;

            if (this.interval) clearInterval(this.interval);
            this.interval = null;
            this.busy = false;
            this.awaitingRetakeConfirm = false;
            logDebug("Guesser", "AutoSolve stopped");

            // Stop FastStep if active
            if (fastStepInterval) {
                stopFastStep();
                sendEventUp('faststep-state', { active: false });
            }

            sendEventUp('solve-state', { active: false });
            sendEventUp('status', { msg: 'AutoSolve stopped.', statusType: '' });
            reportStateToBackground();
        }

        async tick() {
            if (this.busy) return;
            if (window === window.top && !isPlaypositDomain) return;

            const qContainer = getActiveQuestionContainer();

            // Priority 0: Handle 100% Completion (Halt completely!)
            if (isAssignment100Complete()) {
                logDebug("Guesser", "Assignment complete with 100% score! Halting all loops.");
                sendEventUp('status', { msg: 'Assignment Complete! 100% Score achieved.', statusType: 'ok' });
                stopFastStep(true);
                sendEventUp('faststep-state', { active: false });
                const v = getVideo();
                if (v && !v.paused) v.pause();
                if (getSetting('chimeOnComplete', true)) {
                    playCompletionChime();
                }
                this.stop();
                return;
            }

            // Priority 0.2: Handle "Retake" for non-100% scores
            const retakeBtn = this.findButtonByText(['Retake', 'Retake Bulb', 'Reset']);
            if (retakeBtn && this.isVisible(retakeBtn) && !this.awaitingRetakeConfirm) {
                logDebug("Guesser", "Found Retake button. Clicking to restart...");
                if (getSetting('chimeOnRetake', false)) {
                    playRetakeChime();
                }
                sendEventUp('status', { msg: 'Retaking assignment…', statusType: 'info' });
                retakeBtn.click();
                this.awaitingRetakeConfirm = true;
                this.busy = true;
                setTimeout(() => { this.busy = false; }, 1000);
                return;
            }

            // Priority 0.5: Handle Confirmation Dialog (for Retake)
            if (this.awaitingRetakeConfirm) {
                const confirmTexts = ['Confirm', 'Yes, retake', 'Start', 'Retake'];
                const confirmBtn = this.findButtonByText(confirmTexts);
                if (confirmBtn && this.isVisible(confirmBtn)) {
                    logDebug("Guesser", "Found Retake Confirm button. Clicking...");
                    confirmBtn.click();
                    this.awaitingRetakeConfirm = false;
                    currentVideo = null; // Clear old video sticky reference on retake!

                    // Clear monitoring locks
                    document.querySelectorAll('[data-yeeter-monitoring]').forEach(el => el.removeAttribute('data-yeeter-monitoring'));
                    document.querySelectorAll('[data-yeeter-clicked]').forEach(el => el.removeAttribute('data-yeeter-clicked'));

                    this.busy = true;
                    setTimeout(() => { this.busy = false; }, 1500);

                    let checks = 0;
                    const maxChecks = 40; // 20 seconds

                    const checkVideoInterval = setInterval(() => {
                        checks++;
                        checkForVideoAndExtras();

                        const video = getVideo();
                        if (video) {
                            if (video.paused && !hasActiveQuestion()) {
                                video.play().catch(() => {});
                            }
                            if (!video.paused && video.currentTime > 0) {
                                logDebug("Guesser", "Video confirmed playing after retake. Resuming FastStep.");
                                clearInterval(checkVideoInterval);
                                startFastStepLoop();
                                sendEventUp('faststep-state', { active: true });
                                sendEventUp('status', { msg: 'FastStep running – video will pause at interactions.', statusType: 'info' });
                                return;
                            }
                        }

                        if (checks >= maxChecks) {
                            logDebug("Guesser", "Timed out waiting for video to auto-start after retake.");
                            clearInterval(checkVideoInterval);
                        }
                    }, 500);

                    return;
                }
            }

            if (qContainer) {
                // Priority 1: Retry (Only if Retry/Try Again button is visible)
                const retryBtn = this.findButtonByText(['Retry', 'Try Again'], qContainer);
                if (retryBtn && this.isVisible(retryBtn)) {
                    this.busy = true;
                    logDebug("Guesser", "Found Retry button", { btn: retryBtn.innerText });
                    document.querySelectorAll('[data-yeeter-submitted]').forEach(el => el.removeAttribute('data-yeeter-submitted'));

                    const feedback = this.detectFeedback();
                    const pending = this.loadPendingAttempt();
                    const qKey   = (pending && pending.key)   || this.lastQuestionKey || this.getQuestionKey(this.getInputs());
                    const qCombo = (pending && pending.combo) || this.lastAttemptedCombo;

                    sendEventUp('status', { msg: 'Noting Incorrect Answer', statusType: 'warn' });
                    await new Promise(r => setTimeout(r, 200));

                    if (qKey && qCombo) {
                        logDebug("Guesser", "Marking answer as WRONG on retry", { key: qKey, combo: qCombo });
                        this.saveWrongAnswer(qKey, qCombo);

                        // If previously marked as correct, remove it
                        const saved = this.loadAnswer(qKey);
                        if (saved && JSON.stringify([...saved].sort()) === JSON.stringify([...qCombo].sort())) {
                            this.clearAnswer(qKey);
                        }
                    }
                    if (pending) this.clearPendingAttempt();

                    if (feedback.revealedAnswer && qKey) {
                        const revealedStr = JSON.stringify([...feedback.revealedAnswer].sort());
                        const comboStr = qCombo ? JSON.stringify([...qCombo].sort()) : null;
                        if (revealedStr === comboStr) {
                            logDebug("Guesser", "Revealed answer matches wrong guess, ignoring as false positive");
                        } else {
                            logDebug("Guesser", "Correct answer REVEALED during retry", { key: qKey, answer: feedback.revealedAnswer });
                            this.saveAnswer(qKey, feedback.revealedAnswer);
                            sendEventUp('status', { msg: 'Noting Correct Answer', statusType: 'ok' });
                            await new Promise(r => setTimeout(r, 200));
                        }
                    }

                    sendEventUp('status', { msg: 'Pressing Retry', statusType: 'info' });
                    await new Promise(r => setTimeout(r, 200));
                    retryBtn.click();
                    this.combinations = [];
                    setTimeout(() => { this.busy = false; }, 500);
                    return;
                }

                // Priority 2: Submit
                const submitBtn = this.findButtonByText(['Submit'], qContainer);
                if (submitBtn && this.isVisible(submitBtn)) {
                    this.busy = true;
                    this.wasSolving = true;
                    sendEventUp('solve-text', { text: 'Solving…' });

                    const inputs = this.getInputs();
                    if (inputs.length === 0) {
                        this.busy = false;
                        return;
                    }

                    const labelsKey = this.getQuestionKey(inputs);
                    const inputLabels = inputs.map(i => this.getInputLabel(i));

                    const savedAnswer = this.loadAnswer(labelsKey);
                    if (savedAnswer) {
                        logDebug("Guesser", "Found saved correct answer! Applying...", { key: labelsKey, answer: savedAnswer });
                        sendEventUp('status', { msg: 'Known question encountered', statusType: 'info' });
                        await new Promise(r => setTimeout(r, 200));

                        sendEventUp('status', { msg: 'Trying Known Answer', statusType: 'info' });
                        await this.applyCombination(inputs, savedAnswer);

                        this.lastAttemptedCombo = savedAnswer;
                        this.lastQuestionKey    = labelsKey;

                        // Wait up to 300ms for Vue to enable the submit button
                        let waitSubmit = 0;
                        while (submitBtn.disabled && waitSubmit < 6) {
                            await new Promise(r => setTimeout(r, 50));
                            waitSubmit++;
                        }

                        if (!submitBtn.disabled && !submitBtn.hasAttribute('data-yeeter-submitted')) {
                            submitBtn.setAttribute('data-yeeter-submitted', 'true');
                            sendEventUp('status', { msg: 'Submitting', statusType: 'info' });
                            await new Promise(r => setTimeout(r, 200));
                            submitBtn.click();
                        }
                        setTimeout(() => { this.busy = false; }, 500);
                        return;
                    }

                    if (this.combinations.length === 0 || labelsKey !== this.lastQuestionKey) {
                        logDebug("Guesser", "Generating combinations for question", { key: labelsKey, options: inputLabels });
                        this.currentLabels = inputLabels;
                        this.generateCombinations(inputs, inputLabels);

                        const wrongAnswers = this.loadWrongAnswers(labelsKey);
                        if (wrongAnswers.length > 0) {
                            const originalCount = this.combinations.length;
                            this.combinations = this.combinations.filter(combo => {
                                const jsonCombo = JSON.stringify([...combo].sort());
                                return !wrongAnswers.some(wa => JSON.stringify([...wa].sort()) === jsonCombo);
                            });
                            logDebug("Guesser", `Filtered out ${originalCount - this.combinations.length} known wrong combinations`);

                            if (this.combinations.length === 0) {
                                logDebug("Guesser", "All combos were marked wrong; resetting wrong answers for this question");
                                this.clearWrongAnswers(labelsKey);
                                this.generateCombinations(inputs, inputLabels);
                            }
                        }
                        this.currentComboIndex = 0;
                    }

                    if (this.currentComboIndex >= this.combinations.length) {
                        logDebug("Guesser", "All combinations exhausted. Stopping.");
                        sendEventUp('status', { msg: 'All combinations exhausted. Stopping AutoSolve.', statusType: 'error' });
                        this.busy = false;
                        this.stop();
                        return;
                    }

                    const comboLabels = this.combinations[this.currentComboIndex];
                    sendEventUp('status', { msg: `Trying combo ${this.currentComboIndex + 1}/${this.combinations.length}…`, statusType: 'info' });
                    logDebug("Guesser", `Applying combo ${this.currentComboIndex + 1}/${this.combinations.length}`, comboLabels);

                    await this.applyCombination(inputs, comboLabels);

                    this.lastAttemptedCombo = comboLabels;
                    this.lastQuestionKey    = labelsKey;
                    this.savePendingAttempt(labelsKey, comboLabels);

                    let waitSubmit = 0;
                    while (submitBtn.disabled && waitSubmit < 6) {
                        await new Promise(r => setTimeout(r, 50));
                        waitSubmit++;
                    }

                    if (!submitBtn.disabled && !submitBtn.hasAttribute('data-yeeter-submitted')) {
                        submitBtn.setAttribute('data-yeeter-submitted', 'true');
                        sendEventUp('status', { msg: 'Submitting', statusType: 'info' });
                        await new Promise(r => setTimeout(r, 200));
                        submitBtn.click();
                        this.currentComboIndex++;
                    }

                    setTimeout(() => { this.busy = false; }, 500);
                    return;
                }

                // Priority 3: Continue / Next
                const continueBtn = this.findButtonByText(['Continue', 'Next'], qContainer);
                if (continueBtn && this.isVisible(continueBtn)) {
                    this.busy = true;
                    logDebug("Guesser", "Found Continue/Next button", { text: (continueBtn.innerText || '').trim() });
                    document.querySelectorAll('[data-yeeter-submitted]').forEach(el => el.removeAttribute('data-yeeter-submitted'));

                    const feedback = this.detectFeedback();
                    const pending = this.loadPendingAttempt();
                    const qKey   = (pending && pending.key)   || this.lastQuestionKey || this.getQuestionKey(this.getInputs());
                    const qCombo = (pending && pending.combo) || this.lastAttemptedCombo;

                    if (feedback.isCorrect === false) {
                        logDebug("Guesser", "Continue found with INCORRECT answer", { key: qKey, combo: qCombo });
                        sendEventUp('status', { msg: 'Noting Incorrect Answer', statusType: 'warn' });
                        await new Promise(r => setTimeout(r, 200));

                        if (qKey && qCombo) {
                            this.saveWrongAnswer(qKey, qCombo);
                            const saved = this.loadAnswer(qKey);
                            if (saved && JSON.stringify([...saved].sort()) === JSON.stringify([...qCombo].sort())) {
                                this.clearAnswer(qKey);
                            }
                        }
                        if (feedback.revealedAnswer && qKey) {
                            logDebug("Guesser", "Correct answer REVEALED on continue", { key: qKey, answer: feedback.revealedAnswer });
                            this.saveAnswer(qKey, feedback.revealedAnswer);
                            sendEventUp('status', { msg: 'Noting Correct Answer', statusType: 'ok' });
                            await new Promise(r => setTimeout(r, 200));
                        }
                    } else if (feedback.isCorrect === true) {
                        sendEventUp('status', { msg: 'Noting Correct Answer', statusType: 'ok' });
                        await new Promise(r => setTimeout(r, 200));

                        if (qKey && qCombo) {
                            logDebug("Guesser", "Continue found with CORRECT answer", { key: qKey, combo: qCombo });
                            this.saveAnswer(qKey, qCombo);
                        }
                    } else {
                        logDebug("Guesser", "Continue found with inconclusive feedback (neither correct nor incorrect detected)", { key: qKey });
                    }

                    if (pending) this.clearPendingAttempt();
                    this.lastQuestionKey    = null;
                    this.lastAttemptedCombo = null;

                    sendEventUp('status', { msg: 'Pressing Continue', statusType: 'info' });
                    await new Promise(r => setTimeout(r, 200));
                    continueBtn.click();

                    // Resume FastStep
                    resumeFastStepWhenVideoPlays();

                    this.combinations      = [];
                    this.currentComboIndex = 0;
                    this.currentLabels     = [];

                    sendEventUp('status', { msg: 'AutoSolve active – waiting for next question.', statusType: 'ok' });
                    setTimeout(() => { this.busy = false; }, 500);
                    return;
                }
            }

            // Fallback: check if we're stuck on an unstarted video or if FastStep needs auto-engaging
            if (this.active) {
                if (this.wasSolving) {
                    this.wasSolving = false;
                    sendEventUp('solve-text', { text: 'Waiting…' });
                }
                const vid = getVideo();
                if (!isVideoInProgress(vid) && !hasActiveQuestion() && !isVideoEnded(vid)) {
                    this._tryClickStartButton();
                }
                if (!fastStepManuallyStopped && vid && !vid.paused && !vid.ended && !isVideoEnded(vid) && !fastStepInterval && !hasActiveQuestion()) {
                    logDebug("Guesser", "Video playing with no active question; auto-engaging FastStep");
                    startFastStepLoop();
                    sendEventUp('faststep-state', { active: true });
                    sendEventUp('status', { msg: 'FastStep running – video will pause at interactions.', statusType: 'info' });
                }
            }
        }

        _tryClickStartButton() {
            const vid = getVideo();
            if (isVideoInProgress(vid) || hasActiveQuestion() || isVideoEnded(vid)) return;

            const startBtn = findStartButton();
            if (!startBtn) {
                if (vid && vid.paused) {
                    vid.play().catch(() => {});
                }
                return;
            }

            const now = Date.now();
            const lastClicked = parseInt(startBtn.getAttribute('data-yeeter-clicked') || '0', 10);
            if (now - lastClicked > 3000) {
                startBtn.setAttribute('data-yeeter-clicked', now.toString());
                logDebug("Guesser", "Clicking Start Button...", { id: startBtn.id, text: (startBtn.innerText || '').trim() });
                startBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                setTimeout(() => {
                    startBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                    startBtn.click();
                    setTimeout(() => {
                        const v = getVideo();
                        if (v) {
                            v.removeAttribute('data-yeeter-monitoring');
                            ensureVideoPlays(v);
                            v.play().catch(() => {});
                        }
                        if (this.active) {
                            resumeFastStepWhenVideoPlays();
                        }
                    }, 300);
                }, 50);
            }
        }

        // ── Feedback Detection ──────────────────────────────────────────

        detectFeedback() {
            const result = { isCorrect: null, revealedAnswer: null };
            const container = getActiveQuestionContainer() || document.body;

            // 1. Check score tag in container
            const scoreTags = container.querySelectorAll('.score-tag');
            for (const tag of scoreTags) {
                if (!this.isVisible(tag)) continue;
                if (tag.classList.contains('correct')) {
                    result.isCorrect = true;
                    logDebug("Feedback", "Detected CORRECT via score-tag.correct");
                    break;
                }
                if (tag.classList.contains('incorrect')) {
                    result.isCorrect = false;
                    logDebug("Feedback", "Detected INCORRECT via score-tag.incorrect");
                    break;
                }
                const tagText = (tag.innerText || '').toLowerCase();
                if (/0\s*\/\s*[1-9]\d*\s*pts/.test(tagText)) {
                    result.isCorrect = false;
                    logDebug("Feedback", "Detected INCORRECT via score-tag points 0/X");
                    break;
                }
                if (/[1-9]\d*\s*\/\s*[1-9]\d*\s*pts/.test(tagText)) {
                    result.isCorrect = true;
                    logDebug("Feedback", "Detected CORRECT via score-tag full points");
                    break;
                }
            }

            // 2. Check screen reader feedback (.aria-feedback) in container
            if (result.isCorrect === null) {
                const ariaFeedback = container.querySelector('.aria-feedback');
                if (ariaFeedback) {
                    const afText = (ariaFeedback.innerText || '').toLowerCase();
                    if (afText.includes('was incorrect') || afText.includes('was missed')) {
                        result.isCorrect = false;
                        logDebug("Feedback", "Detected INCORRECT via .aria-feedback text");
                    } else if (afText.includes('graded correct') || afText.includes('was correct')) {
                        result.isCorrect = true;
                        logDebug("Feedback", "Detected CORRECT via .aria-feedback text");
                    }
                }
            }

            // 3. Check choice option containers for incorrect or missed markers
            if (result.isCorrect === null) {
                const choiceOptions = container.querySelectorAll('.checkbox-option, .radio-option, .v-radio, .v-checkbox');
                for (const opt of choiceOptions) {
                    if (opt.classList.contains('incorrect') || opt.classList.contains('missed')) {
                        result.isCorrect = false;
                        logDebug("Feedback", "Detected INCORRECT via option class (.incorrect/.missed)");
                        break;
                    }
                    const bq = opt.querySelector('.feedback-blockquote');
                    if (bq) {
                        const bqText = (bq.innerText || '').toLowerCase();
                        if (bqText.includes('incorrect') || bqText.includes('missed') || bqText.includes('wrong')) {
                            result.isCorrect = false;
                            logDebug("Feedback", "Detected INCORRECT via feedback-blockquote");
                            break;
                        }
                    }
                }
            }

            // 4. Text patterns across feedback elements
            if (result.isCorrect === null) {
                const feedbackSelectors = [
                    '.pp-feedback', '.feedback', '.v-alert', '.v-snack',
                    '[class*="feedback"]', '[class*="result"]',
                    '.v-card__text', '.v-dialog'
                ];
                let feedbackText = '';
                for (const sel of feedbackSelectors) {
                    const els = container.querySelectorAll(sel);
                    els.forEach(el => {
                        if (this.isVisible(el)) feedbackText += ' ' + (el.innerText || '').toLowerCase();
                    });
                }

                const incorrectPatterns = [
                    'incorrect', 'not correct', 'that\'s not right', 'not right',
                    'wrong answer', 'not quite', 'try again', 'that is not correct'
                ];
                const correctPatterns = [
                    'correct!', 'that\'s correct', 'that is correct',
                    'you got it', 'well done', 'great job', 'nice work', 'good job'
                ];

                for (const pat of incorrectPatterns) {
                    if (feedbackText.includes(pat)) {
                        result.isCorrect = false;
                        logDebug("Feedback", `Detected INCORRECT via text: "${pat}"`);
                        break;
                    }
                }

                if (result.isCorrect === null) {
                    for (const pat of correctPatterns) {
                        if (feedbackText.includes(pat)) {
                            result.isCorrect = true;
                            logDebug("Feedback", `Detected CORRECT via text: "${pat}"`);
                            break;
                        }
                    }
                }
            }

            // 5. Extract revealed answer
            result.revealedAnswer = this.extractRevealedAnswer();
            if (result.revealedAnswer && result.isCorrect === null) {
                logDebug("Feedback", "Revealed answer found => inferring INCORRECT");
                result.isCorrect = false;
            }

            logDebug("Feedback", "Feedback evaluation", result);
            return result;
        }

        extractRevealedAnswer() {
            const inputs = this.getInputs();
            if (inputs.length === 0) return null;

            const correctLabels = [];
            const container = getActiveQuestionContainer() || document.body;

            for (const input of inputs) {
                const optContainer = input.closest('.checkbox-option, .radio-option, .pp-choice, .choice-wrapper, .v-radio, .v-checkbox, li, [class*="option"]') || input.parentElement;
                if (!optContainer) continue;

                let isMarkedCorrect = false;
                let isMarkedIncorrect = false;

                // Check option container itself and direct slot
                if (optContainer.classList.contains('incorrect') || optContainer.classList.contains('error')) {
                    isMarkedIncorrect = true;
                }
                if (optContainer.classList.contains('correct') || optContainer.classList.contains('missed') || optContainer.classList.contains('success')) {
                    isMarkedCorrect = true;
                }

                // Check PlayPosit feedback blockquotes inside container
                if (!isMarkedIncorrect) {
                    const quotes = optContainer.querySelectorAll('.feedback-blockquote');
                    for (const q of quotes) {
                        const qText = (q.innerText || q.textContent || '').trim().toLowerCase();
                        if (qText.includes('missed') || qText.includes('correct')) {
                            isMarkedCorrect = true;
                        }
                        if (qText.includes('incorrect') || qText.includes('wrong')) {
                            isMarkedIncorrect = true;
                            break;
                        }
                    }
                }

                // Check icons inside container
                if (!isMarkedIncorrect && !isMarkedCorrect) {
                    const icons = optContainer.querySelectorAll('i, .v-icon, svg');
                    for (const icon of icons) {
                        const text = (icon.innerText || icon.textContent || '').trim().toLowerCase();
                        const cls = (typeof icon.className === 'string') ? icon.className : '';
                        if (text === 'close' || text === 'clear' || cls.includes('mdi-close') || cls.includes('fa-times')) {
                            isMarkedIncorrect = true;
                            break;
                        }
                        if (text === 'check' || text === 'check_circle' || text === 'done' || cls.includes('mdi-check') || cls.includes('fa-check')) {
                            isMarkedCorrect = true;
                        }
                    }
                }

                if (isMarkedCorrect && !isMarkedIncorrect) {
                    const lbl = this.getInputLabel(input);
                    if (lbl && !correctLabels.includes(lbl)) {
                        correctLabels.push(lbl);
                    }
                }
            }

            // Fallback: Parse .aria-feedback inside active container
            if (correctLabels.length === 0) {
                const ariaFeedback = container.querySelector('.aria-feedback');
                if (ariaFeedback) {
                    const fbText = (ariaFeedback.innerText || '').toLowerCase();
                    for (const input of inputs) {
                        const label = this.getInputLabel(input);
                        if (label && label.length > 2) {
                            const lowerLbl = label.toLowerCase();
                            if (fbText.includes(`${lowerLbl} was missed`) || fbText.includes(`${lowerLbl} was correct`)) {
                                if (!correctLabels.includes(label)) correctLabels.push(label);
                            }
                        }
                    }
                }
            }

            if (correctLabels.length > 0) {
                logDebug("RevealedAnswer", "Found revealed correct labels", correctLabels);
                return correctLabels;
            }
            return null;
        }

        // ── Input Helpers ───────────────────────────────────────────────

        getInputs() {
            const container = getActiveQuestionContainer();
            if (!container) return [];
            const allInputs = Array.from(container.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
            return allInputs.filter(el => {
                if (!this.isVisible(el) && !this.isVisible(el.parentElement)) return false;
                const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                if (aria.includes('transcript') || aria.includes('captions only')) return false;
                return true;
            });
        }

        getInputLabel(input) {
            let labelText = '';

            // 1. Explicit aria-label on the input itself (PlayPosit checkboxes)
            const ariaLabel = input.getAttribute('aria-label');
            if (ariaLabel && ariaLabel.trim()) {
                labelText = ariaLabel.trim();
            }

            // 2. aria-labelledby pointing to an element (PlayPosit radio buttons)
            if (!labelText) {
                const ariaLabelledBy = input.getAttribute('aria-labelledby');
                if (ariaLabelledBy) {
                    const el = document.getElementById(ariaLabelledBy);
                    if (el) labelText = (el.innerText || el.textContent || '').trim();
                }
            }

            // 3. Search within the choice container (.checkbox-option, .radio-option, etc.)
            if (!labelText) {
                const parent = input.closest('.checkbox-option, .radio-option, .v-radio, .v-checkbox, .pp-choice, .choice-wrapper, li, [class*="option"]');
                if (parent) {
                    const label = parent.querySelector('.pp-interaction-body, label, .v-label, .pp-choice-text, .choice-text, .text');
                    if (label) {
                        labelText = (label.innerText || label.textContent || '').trim();
                    } else {
                        const clone = parent.cloneNode(true);
                        const toRemove = clone.querySelectorAll('input, button, i, .v-icon, .feedback-blockquote');
                        toRemove.forEach(i => i.remove());
                        labelText = (clone.innerText || clone.textContent || '').trim();
                    }
                }
            }

            // 4. Direct <label> wrapper
            if (!labelText && input.parentElement && input.parentElement.tagName === 'LABEL') {
                labelText = input.parentElement.innerText.trim();
            }

            // 5. Associated <label for="...">
            if (!labelText && input.id) {
                const label = document.querySelector(`label[for="${input.id}"]`);
                if (label) labelText = label.innerText.trim();
            }

            if (labelText) {
                // Normalize non-breaking spaces and whitespace
                labelText = labelText.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
                // Strip positional prefixes like "A.", "B)", "a.", "b)", "1.", "2)" to ensure stability if options are shuffled
                labelText = labelText.replace(/^([A-Za-z]|[0-9]+)[\.\)]\s*/, '');
                return labelText;
            }

            // Safe fallback (never return '[object Object]')
            const val = input.value;
            if (val && val !== '[object Object]') return val;
            return "option_" + (input.id || Math.random().toString(36).substring(2, 7));
        }

        getQuestionKey(inputs) {
            const container = getActiveQuestionContainer();
            const titleEl = container ? container.querySelector('.pp-interaction-title, .interaction-title, .q-title, legend, .q-legend') : null;
            const title = titleEl ? titleEl.innerText.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim() : '';
            const interactionId = container ? (container.getAttribute('data-interaction-id') || container.querySelector('[id^="interaction-"]')?.id || '') : '';
            const inputLabels = inputs.map(i => this.getInputLabel(i));
            const sortedLabels = [...inputLabels].sort().join('|');
            const keyParts = [];
            if (interactionId) keyParts.push(interactionId);
            if (title) keyParts.push(title);
            keyParts.push(sortedLabels);
            return keyParts.join('::');
        }

        shuffle(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
            return array;
        }

        generateCombinations(inputs, labels) {
            const type = inputs[0].type;
            this.combinations = [];

            if (type === 'radio') {
                for (let i = 0; i < labels.length; i++) {
                    this.combinations.push([labels[i]]);
                }
                this.shuffle(this.combinations);
            } else {
                const count = labels.length;
                const max   = 1 << count;
                const byLength = {};
                for (let i = 1; i < max; i++) {
                    const combo = [];
                    for (let j = 0; j < count; j++) {
                        if ((i >> j) & 1) {
                            combo.push(labels[j]);
                        }
                    }
                    const len = combo.length;
                    if (!byLength[len]) byLength[len] = [];
                    byLength[len].push(combo);
                }
                // Group by length and shuffle within each group so smaller combos are tried first,
                // but in completely randomized order across options!
                for (let len = 1; len <= count; len++) {
                    if (byLength[len]) {
                        this.shuffle(byLength[len]);
                        this.combinations.push(...byLength[len]);
                    }
                }
            }
        }

        async applyCombination(inputs, targetLabels) {
            const normalizedTargets = targetLabels.map(t => t.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase());

            const currentInputMap = inputs.map(input => ({
                el:    input,
                label: this.getInputLabel(input)
            }));

            for (let item of currentInputMap) {
                const itemNorm = item.label.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
                const shouldBeChecked = normalizedTargets.includes(itemNorm);
                const input = item.el;
                const isChecked = input.checked || input.getAttribute('aria-checked') === 'true';

                if (isChecked !== shouldBeChecked) {
                    if (input.type === 'radio' && !shouldBeChecked) {
                        continue; // Can't uncheck a radio by clicking
                    }

                    const clickTarget = input.parentElement.querySelector('.v-input--selection-controls__ripple') ||
                                      input.parentElement ||
                                      input;

                    clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                    clickTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                    clickTarget.click();

                    await new Promise(r => setTimeout(r, 40));

                    // Verify if checked state changed; fallback to input click if Vuetify didn't register
                    const nowChecked = input.checked || input.getAttribute('aria-checked') === 'true';
                    if (nowChecked !== shouldBeChecked) {
                        input.click();
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    }

                    await new Promise(r => setTimeout(r, 40));
                }
            }
        }

        findButtonByText(texts, container = null) {
            // First search within container or active question container
            const searchScope = container || getActiveQuestionContainer();
            if (searchScope) {
                const scopedButtons = Array.from(searchScope.querySelectorAll('button, .v-btn, input[type="button"], input[type="submit"], [role="button"], a')).reverse();
                const foundScoped = scopedButtons.find(btn => {
                    if (!this.isVisible(btn) || isExcludedControlBtn(btn)) return false;
                    const t = (btn.value || btn.innerText || btn.textContent || '').trim().toLowerCase();
                    return texts.some(text => t.includes(text.toLowerCase()));
                });
                if (foundScoped) return foundScoped;
            }

            // Fallback: search whole document (for confirmation dialogs / retake outside interaction container)
            const allButtons = Array.from(document.querySelectorAll('button, .v-btn, input[type="button"], input[type="submit"], [role="button"], a')).reverse();
            return allButtons.find(btn => {
                if (!this.isVisible(btn) || isExcludedControlBtn(btn)) return false;
                const t = (btn.value || btn.innerText || btn.textContent || '').trim().toLowerCase();
                return texts.some(text => t.includes(text.toLowerCase()));
            });
        }

        isVisible(el) {
            if (!el) return false;
            return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        }

        // ── Persistence Helpers ─────────────────────────────────────────

        saveAnswer(key, answer) { this._saveLocal('pp_yeeter_answers', key, answer); }
        loadAnswer(key) { return this._loadLocal('pp_yeeter_answers', key); }
        clearAnswer(key) {
            try {
                const data = JSON.parse(localStorage.getItem('pp_yeeter_answers') || '{}');
                delete data[key];
                localStorage.setItem('pp_yeeter_answers', JSON.stringify(data));
            } catch (e) { }
        }

        saveWrongAnswer(key, answer) {
            try {
                const storageKey = 'pp_yeeter_wrong_answers';
                const data = JSON.parse(localStorage.getItem(storageKey) || '{}');
                if (!data[key]) data[key] = [];
                const jsonAnswer = JSON.stringify([...answer].sort());
                if (!data[key].some(a => JSON.stringify([...a].sort()) === jsonAnswer)) {
                    data[key].push(answer);
                }
                localStorage.setItem(storageKey, JSON.stringify(data));
            } catch (e) { console.error(e); }
        }

        loadWrongAnswers(key) { return this._loadLocal('pp_yeeter_wrong_answers', key) || []; }
        clearWrongAnswers(key) {
            try {
                const data = JSON.parse(localStorage.getItem('pp_yeeter_wrong_answers') || '{}');
                delete data[key];
                localStorage.setItem('pp_yeeter_wrong_answers', JSON.stringify(data));
            } catch (e) { }
        }

        _saveLocal(storageKey, key, value) {
            try {
                const data = JSON.parse(localStorage.getItem(storageKey) || '{}');
                data[key] = value;
                localStorage.setItem(storageKey, JSON.stringify(data));
            } catch (e) { }
        }

        _loadLocal(storageKey, key) {
            try {
                const data = JSON.parse(localStorage.getItem(storageKey) || '{}');
                return data[key];
            } catch (e) { return null; }
        }

        savePendingAttempt(key, combo) { this._saveLocal('pp_yeeter_pending', 'latest', { key, combo }); }
        loadPendingAttempt() { return this._loadLocal('pp_yeeter_pending', 'latest'); }
        clearPendingAttempt() { localStorage.removeItem('pp_yeeter_pending'); }
    }

    const guesser = new Guesser();

    // ─────────────────────────────────────────────
    //  Shared Utilities
    // ─────────────────────────────────────────────

    function formatTime(secs) {
        secs = Math.floor(secs || 0);
        const m = Math.floor(secs / 60);
        const s = String(secs % 60).padStart(2, '0');
        return `${m}:${s}`;
    }

    // ─────────────────────────────────────────────
    //  MutationObserver
    // ─────────────────────────────────────────────

    function startObserver() {
        const observer = new MutationObserver(() => {
            checkForVideoAndExtras();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ─────────────────────────────────────────────
    //  Init
    // ─────────────────────────────────────────────

    function recheckAll() {
        checkForVideoAndExtras();
    }

    function init() {
        console.log("WeVideo (Playposit) ToolKit initializing...");
        startObserver();
        checkForVideoAndExtras();

        // Notify parent/host that this frame is ready
        if (window.parent !== window) {
            sendEventUp('player-ready');
        }
        
        // Query the background script for active state.
        // This handles iframe reloads (retake) where the script context is lost.
        const queryActiveState = () => {
            try {
                if (guesser.active) return;
                chrome.runtime.sendMessage({ type: 'yeeter-state-query' }, (state) => {
                    if (chrome.runtime.lastError || !state) return;
                    if (state.solveActive && !guesser.active && !(window === window.top && !isPlaypositDomain)) {
                        console.log("[State Query] Re-activating AutoSolve in reloaded frame");
                        guesser.start();
                    }
                });
            } catch (e) { /* extension context invalidated */ }
        };
        queryActiveState();
        setTimeout(queryActiveState, 200);
        setTimeout(queryActiveState, 800);
        setTimeout(queryActiveState, 2000);
        setTimeout(queryActiveState, 4000);
    }

    window.playpositYeeter = {
        recheckAll,
        toggleFastStep
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
