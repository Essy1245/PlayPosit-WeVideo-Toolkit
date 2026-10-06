# WeVideo (Playposit) ToolKit

A browser extension designed to provide playback control, acceleration, and intelligent question solving for PlayPosit and WeVideo interactive video assignments embedded within Learning Management Systems (Canvas, Blackboard, Brightspace).

---

## AI Transparency:
- This project was AI-driven. Gemini 3.8 Flash, Claude Opus 5.5, and Gemini 3.1 Pro produced all of the code and architecture. I cannot guarantee the stability nor the security of the code. 

---

## To install: 
- Go to Releases, use the packaged .crx file (recommended) or download source code, unzip, and load as unpacked extension.
- Developer Mode must be enabled in `chrome://extension`

## Important Disclaimers

- **Multiple Attempts Required:** On the initial run, the automated solver utilizes a discovery approach that will submit trial answers to identify correct choices. **Do not use this tool on assignments that permit only a single attempt.** Your LMS assignment must allow multiple attempts to achieve a full score on subsequent runs.
- **Folder Preservation:** When loaded as an unpacked extension in Developer Mode, Chrome runs the tool directly from its disk location. Do not move or delete the extension folder after installation.

---

## Key Features

### 1. FastStep Playback Accelerator
Overcomes streaming bottlenecks and player restrictions with calibrated pacing options:
- **Legacy Mode:** 5-second skip intervals every 90ms. Maximizes stability on slower network connections or high-bitrate video streams.
- **Balanced Mode (Recommended):** 10-second skip intervals every 45ms with hardware-accelerated timeline synchronization. Fast progression while maintaining stream buffer integrity.
- **Super Mode (Experimental):** Direct timeline advancement toward the video finish. PlayPosit's internal listeners automatically halt playback at the upcoming interaction milestone.
- **Playback Speed Selector:** Native playback rate adjustment (1x, 1.5x, 2x, 3x, 5x, 16x) with a dedicated +10s forward skip button.

### 2. Intelligent AutoSolve Engine
Operates in a structured two-phase cycle:
- **Phase 1 (Discovery Run):** Systematically tests answer combinations on multiple-choice and multi-select questions. Observes live DOM validation, records feedback, extracts revealed correct answers, and catalogs incorrect combinations to prevent repeated errors.
- **Phase 2 (Full-Score Run):** Automatically detects assignment retakes, re-initializes player sessions, applies stored correct answers, and submits with 100% precision.
- **Automatic Retake Handling:** Detects completion screens, initiates retakes for scores below 100%, confirms prompt dialogs, and monitors subframe reloads without requiring manual intervention.

### 3. Autoplay Prevention & Safety
- **No Autoplay on Load:** Video playback never starts automatically upon opening assignment tabs or refreshing the browser (F5).
- **Responsive Pause Controls:** Manually pausing the video with player controls is respected immediately. The extension will not fight the user or force playback to resume.
- **Subframe vs. Main-Frame Isolation:** Full browser refreshes reset active tasks to idle, while subframe reloads during retakes preserve automated workflows.

### 4. Background Playback & Visibility Spoofing
- Injects `inject.js` into the main execution context to spoof `document.hidden`, `document.visibilityState`, and `document.hasFocus()`.
- Neutralizes `blur`, `focusout`, and `visibilitychange` events, preventing PlayPosit from pausing when switching tabs or window focus.

### 5. Audio Notifications & Status Logging
- **100% Victory Chime:** Synthesizes an audible confirmation tone upon reaching a complete score and halting playback.
- **Retake Reset Chime:** Alerts when an attempt is reset for another run.
- **Interaction Chime:** Alerts when playback pauses at an interaction point, equipped with rate-limiting to prevent repetitive ringing during back-to-back questions.
- **4-Line Rolling Status History:** Displays the last four actions with timestamps in the control panel.

---

## Installation (Chrome Developer Mode)

1. Download or clone this repository to your local drive.
2. In Google Chrome, navigate to `chrome://extensions`.
3. Enable **Developer mode** using the toggle switch in the upper-right corner.
4. Click **Load unpacked** in the upper-left corner.
5. Select the `Playposit_yeeter_v3` folder.
6. Click the puzzle icon in your Chrome toolbar and pin **WeVideo (Playposit) ToolKit** for convenient access.

---

## Usage Guide

1. Navigate to your LMS assignment page containing an embedded PlayPosit or WeVideo player.
2. If **Auto-Initialize** is disabled (default), click the **WeVideo (Playposit) ToolKit** toolbar icon to inject controls into the page and embedded frames. The toolbar badge will illuminate to **ON**.
3. Use the unified control panel mounted below the video player:
   - Click **FastStep** to accelerate through video content until an interaction point is reached.
   - Click **AutoSolve** to activate automated question detection, answering, and retake progression.
   - Click **Settings** to adjust FastStep modes, chime preferences, or configure auto-initialization URLs.

---

## Configuration & URL Safety

To prevent accidental interference with standard video players (e.g. Panopto, Zoom recordings, Studio embeds):

- **Auto-Initialize is OFF by default:** The extension only runs when explicitly activated via the toolbar icon.
- **Avoid Generic Canvas Domains:** Do not enter broad domains such as `canvas.example.edu` as activation URLs.
- **Recommended URL Scoping:** Include the specific course ID where interactive assignments are located:
  ```
  canvas.example.edu/676767
  ```
  Multiple course URLs can be separated with commas in the Settings panel.

---

## System Architecture

```
Host Window (Canvas LMS / Top Frame)
   │
   ├── [content.js (Host Controller)] ── Manages unified UI panel & settings
   │         ▲
   │         │ postMessage (solve-sync, faststep-state, time-update)
   │         ▼
   └── <iframe> (PlayPosit / WeVideo Player Frame)
             │
             ├── [content.js (Player Driver)] ── FastStep engine & Guesser state machine
             │
             └── [inject.js (Main World)] ── Overrides visibility & blur event propagation
```

### Core Components

| File | Context | Description |
| :--- | :--- | :--- |
| `manifest.json` | Manifest V3 | Declares permissions, background service worker, and web-accessible resources. |
| `background.js` | Service Worker | Manages active tab state, handles auto-initialization URL matching, and re-injects on subframe retakes. |
| `content.js` | Isolated World | Primary engine containing host panel rendering, iframe communication, FastStep acceleration, and the Guesser solving machine. |
| `inject.js` | Main World | Overrides native document visibility getters and intercepts focus/blur events. |
| `styles.css` | Isolated World | Native PlayPosit styling (blue `#2563eb`, green `#10b981`, red `#ef4444`) with 4px border radii. |
| `onboarding.html` | Options Page | Interactive user guide and configuration documentation. |
| `icons/` | Static Assets | Application icons in 16x16, 32x32, 48x48, and 128x128 formats. |

---

## Privacy & Local Storage

- **100% Client-Side:** All logic executes locally within your browser.
- **No External Telemetry:** The extension makes zero outbound network requests to third-party tracking services or external APIs.
- **Local Persistence:** Learned answer states, wrong combinations, and user preferences are stored in the browser's `localStorage` and `chrome.storage.local`.
- **Data Clearing:** Saved answers can be wiped at any time using the **Clear Saved Answers** button in the Settings panel.

---

## License

Distributed under the [MIT License](LICENSE).
