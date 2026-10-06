// inject.js
(function () {
    console.log("WeVideo (Playposit) ToolKit: Spoofing visibility and focus...");

    // Spoof document properties
    try {
        Object.defineProperty(document, 'hidden', {
            get: function () { return false; },
            configurable: true
        });
        Object.defineProperty(document, 'webkitHidden', {
            get: function () { return false; },
            configurable: true
        });
        Object.defineProperty(document, 'visibilityState', {
            get: function () { return 'visible'; },
            configurable: true
        });
        Object.defineProperty(document, 'webkitVisibilityState', {
            get: function () { return 'visible'; },
            configurable: true
        });
    } catch (e) {
        console.error("WeVideo (Playposit) ToolKit: Failed to spoof document properties", e);
    }

    // Capture and stop propagation of focus/visibility events
    const eventNames = ['visibilitychange', 'webkitvisibilitychange', 'blur', 'focusout', 'pagehide'];

    eventNames.forEach(eventName => {
        window.addEventListener(eventName, function (e) {
            e.stopImmediatePropagation();
            // console.log(`WeVideo (Playposit) ToolKit: Blocked ${eventName}`);
        }, true); // Capture phase!

        document.addEventListener(eventName, function (e) {
            e.stopImmediatePropagation();
        }, true);
    });

    // Also try to keep window 'focused' if queried
    try {
        Object.defineProperty(document, 'hasFocus', {
            value: () => true,
            configurable: true
        });
    } catch (e) { }

})();
