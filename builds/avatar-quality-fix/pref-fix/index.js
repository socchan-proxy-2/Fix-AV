(function () {
    var TAG = "[PerfFix]";
    var log  = function() { var a = [TAG]; for(var i=0;i<arguments.length;i++) a.push(arguments[i]); console.log.apply(console,a); };
    var warn = function() { var a = [TAG]; for(var i=0;i<arguments.length;i++) a.push(arguments[i]); console.warn.apply(console,a); };

    var patches = [];

    return {
        onLoad: function () {
            var findByProps = vendetta.metro.findByProps;
            var instead     = vendetta.patcher.instead;
            var FluxDispatcher = vendetta.metro.findByStoreName
                ? null
                : findByProps("dispatch", "subscribe", "unsubscribe");
            var patched = 0;

            // ==============================================================
            // [1] Krisp NC + VAD disabled
            // Root cause: noiseCancellation:true + vadUseKrisp:true by default
            // Krisp runs AI inference 50x/sec on every audio frame -> hotplate
            // Fix: dispatch setNoiseCancellation(false) -> auto-enables
            //      WebRTC built-in NS (much lighter), disables Krisp VAD too
            // ==============================================================
            var audioActions = findByProps("setNoiseCancellation", "setEchoCancellation", "setNoiseSuppression");
            if (audioActions && typeof audioActions.setNoiseCancellation === "function") {
                // Intercept setNoiseCancellation: block re-enabling Krisp
                patches.push(instead("setNoiseCancellation", audioActions, function (args, orig) {
                    var enabled = args[0];
                    if (enabled === true) {
                        log("setNoiseCancellation(true) blocked -> forcing false");
                        args[0] = false;
                    }
                    return orig.apply(this, args);
                }));
                patched++;

                // Apply immediately on load
                try {
                    audioActions.setNoiseCancellation(false, "PerfFix");
                    log("Krisp NC disabled");
                } catch(e) { warn("NC disable failed:", e); }
            } else {
                warn("[1] setNoiseCancellation not found");
            }

            // Also disable on VC join (in case it re-enables)
            try {
                var Dispatcher = findByProps("dispatch", "subscribe");
                if (Dispatcher) {
                    var onVcJoin = function(e) {
                        if (e && e.channelId && audioActions && typeof audioActions.setNoiseCancellation === "function") {
                            try { audioActions.setNoiseCancellation(false, "PerfFix"); } catch(e2) {}
                        }
                    };
                    Dispatcher.subscribe("VOICE_CHANNEL_SELECT", onVcJoin);
                    patches.push(function() { Dispatcher.unsubscribe("VOICE_CHANNEL_SELECT", onVcJoin); });
                    patched++;
                }
            } catch(e) { warn("[1b] Dispatcher subscribe failed:", e); }

            // ==============================================================
            // [2] RTC stats polling: STATS_INTERVAL 1000ms -> 5000ms
            // getFilteredStats is called every 1s during VC via setInterval
            // Increasing to 5s reduces native bridge crossings by 80%
            // ==============================================================
            var statsMod = findByProps("STATS_INTERVAL");
            if (statsMod) {
                statsMod.STATS_INTERVAL = 5000;
                log("STATS_INTERVAL: 1000 -> 5000ms");
                patched++;
            } else {
                warn("[2] STATS_INTERVAL not found");
            }

            // ==============================================================
            // [3] Analytics track throttle
            // 3124 track() call sites fire constantly
            // Intercept and drop duplicate events within 10s window
            // ==============================================================
            var analyticsMod = findByProps("track", "AnalyticsContext", "launchSignature");
            if (analyticsMod && typeof analyticsMod.track === "function") {
                var lastSeen = {};
                var THROTTLE_MS = 10000;
                patches.push(instead("track", analyticsMod, function (args, orig) {
                    var eventName = args[0];
                    var now = Date.now();
                    if (eventName && lastSeen[eventName] && (now - lastSeen[eventName]) < THROTTLE_MS) {
                        // Drop duplicate event within throttle window
                        return Promise.resolve();
                    }
                    lastSeen[eventName] = now;
                    return orig.apply(this, args);
                }));
                log("Analytics track: 10s throttle per event type applied");
                patched++;
            } else {
                warn("[3] analytics track not found");
            }

            // ==============================================================
            // [4] Analytics flush storage interval: 5000ms -> 30000ms
            // writeExistingEventStorage fires every 5s via setInterval
            // ==============================================================
            var analyticsStoreMod = findByProps("writeExistingEventStorage", "flushStorageInterval");
            if (!analyticsStoreMod) {
                analyticsStoreMod = findByProps("writeExistingEventStorage");
            }
            if (analyticsStoreMod && typeof analyticsStoreMod.writeExistingEventStorage === "function") {
                patches.push(instead("writeExistingEventStorage", analyticsStoreMod, function (args, orig) {
                    // Batch writes: only allow one per 30s
                    var now = Date.now();
                    if (analyticsStoreMod._lastFlush && (now - analyticsStoreMod._lastFlush) < 30000) {
                        return;
                    }
                    analyticsStoreMod._lastFlush = now;
                    return orig.apply(this, args);
                }));
                log("Analytics storage flush: throttled to 30s");
                patched++;
            } else {
                warn("[4] writeExistingEventStorage not found");
            }

            // ==============================================================
            // [5] Sentry metrics flush: 5000ms -> 60000ms
            // DEFAULT_BROWSER_FLUSH_INTERVAL=5000, DEFAULT_FLUSH_INTERVAL=10000
            // ==============================================================
            var sentryMod = findByProps("DEFAULT_FLUSH_INTERVAL", "DEFAULT_BROWSER_FLUSH_INTERVAL", "COUNTER_METRIC_TYPE");
            if (sentryMod) {
                sentryMod.DEFAULT_BROWSER_FLUSH_INTERVAL = 60000;
                sentryMod.DEFAULT_FLUSH_INTERVAL         = 60000;
                log("Sentry flush: 5/10s -> 60s");
                patched++;
            } else {
                warn("[5] Sentry flush interval not found");
            }

            // ==============================================================
            // [6] Sentry captureException / addBreadcrumb throttle
            // 1182 error tracking call sites; repeated errors waste CPU
            // ==============================================================
            var sentryHub = findByProps("captureException", "captureMessage", "addBreadcrumb");
            if (sentryHub) {
                var lastErrors = {};
                if (typeof sentryHub.captureException === "function") {
                    patches.push(instead("captureException", sentryHub, function (args, orig) {
                        var key = String(args[0]);
                        var now = Date.now();
                        if (lastErrors[key] && (now - lastErrors[key]) < 30000) return;
                        lastErrors[key] = now;
                        return orig.apply(this, args);
                    }));
                }
                // addBreadcrumb fires very frequently; throttle aggressively
                if (typeof sentryHub.addBreadcrumb === "function") {
                    var bcCount = 0;
                    patches.push(instead("addBreadcrumb", sentryHub, function (args, orig) {
                        bcCount++;
                        if (bcCount % 10 !== 0) return; // keep 1 in 10
                        return orig.apply(this, args);
                    }));
                }
                log("Sentry captureException + addBreadcrumb throttled");
                patched++;
            } else {
                warn("[6] Sentry hub not found");
            }

            log("loaded (" + patched + " optimizations applied)");
        },

        onUnload: function () {
            patches.forEach(function(p) { try { p && p(); } catch(e) {} });
            patches = [];
            log("unloaded");
        }
    };
})()
