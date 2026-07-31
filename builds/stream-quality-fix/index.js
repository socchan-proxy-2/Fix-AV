(function () {
    var TAG = "[StreamQualityFix]";

    return {
        onLoad: function () {
            var findByProps = vendetta.metro.findByProps;
            var instead     = vendetta.patcher.instead;
            var patched     = 0;

            // Root cause (APK 339.11 analysis):
            //   setGoliveQuality(a0) merges incoming quality into goliveMaxQuality
            //   using "extend" (minimum-value merge). Once degraded, quality never
            //   recovers because each call further constrains the previous minimum.
            //   Manually changing quality works because setQualityOverwrite()
            //   sets qualityOverwrite which takes priority over goliveMaxQuality.
            //
            // Fix: make setGoliveQuality a no-op so server-imposed constraints
            //   never touch goliveMaxQuality. The initial value ({}) means no
            //   constraints, which is what we want.

            var qMgr = findByProps("setGoliveQuality", "setQualityOverwrite", "getGoliveQuality");
            if (qMgr && typeof qMgr.setGoliveQuality === "function") {
                instead("setGoliveQuality", qMgr, function (_args, _orig) {
                    console.log(TAG, "setGoliveQuality blocked (quality downgrade prevented)");
                    // no-op: discard server-imposed quality constraints
                });
                patched++;
            } else {
                console.warn(TAG, "setGoliveQuality not found");
            }

            console.log(TAG, "loaded (" + patched + " patches)");
        },

        onUnload: function () {
            console.log(TAG, "unloaded");
        }
    };
})()
