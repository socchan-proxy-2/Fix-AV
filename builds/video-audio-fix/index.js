(function () {
    var TAG = "[VideoAudioFix]";
    var patches = [];
    var VIDEO_EXTS = /\.(mp4|mov|avi|mkv|webm|m4v|3gp|ts|mts|m2ts)$/i;
    var H264_FMT   = /(avc1|hvc1|avc|hevc|h\.?264|h\.?265|mp4)/i;

    function isVideoUri(s) {
        return typeof s === "string" && VIDEO_EXTS.test(s);
    }

    return {
        onLoad: function () {
            var findByProps = vendetta.metro.findByProps;
            var instead     = vendetta.patcher.instead;
            var patched     = 0;

            // Layer 1: canSkipVideoTranscode
            // Force true when format is null (L-SMASH malformed metadata) or H264/HEVC
            // This prevents compressVideo from being called and corrupting audio
            var videoUtils = findByProps("canSkipVideoTranscode", "calculateTargetDimensions");
            if (videoUtils && typeof videoUtils.canSkipVideoTranscode === "function") {
                patches.push(instead("canSkipVideoTranscode", videoUtils, function (args, orig) {
                    var meta = args[1];
                    if (!meta) return orig.apply(this, args);
                    var fmt = meta.format != null ? meta.format : "";
                    if (H264_FMT.test(fmt) || fmt === "") {
                        console.log(TAG, "canSkipVideoTranscode -> true (format=" + fmt + ")");
                        return true;
                    }
                    return orig.apply(this, args);
                }));
                patched++;
            }

            // Layer 2: Raise VideoQualityTarget bitrate limits
            // APK analysis: MEDIUM target = 1,800,000 bps
            // Video bitrate = 3,850,506 bps -> exceeds limit -> triggers compressVideo
            // Setting to 99Mbps prevents the bitrate check from failing
            var configMod = findByProps("DEFAULT_VIDEO_ENCODING_CONFIG", "VideoQualityTarget");
            if (configMod) {
                try {
                    if (configMod.DEFAULT_VIDEO_ENCODING_CONFIG) {
                        configMod.DEFAULT_VIDEO_ENCODING_CONFIG.targetBitrate = 99000000;
                        patched++;
                    }
                    var VQT = configMod.VideoQualityTarget;
                    if (VQT) {
                        ["VERY_LOW", "LOW", "MEDIUM", "HIGH", "VERY_HIGH"].forEach(function (lv) {
                            if (VQT[lv] != null && "targetBitrate" in VQT[lv]) {
                                VQT[lv].targetBitrate = 99000000;
                                patched++;
                            }
                        });
                    }
                } catch (e) {
                    console.warn(TAG, "Layer2 failed:", e);
                }
            }

            // Layer 3: convertVideo - force skipVideoTranscode flag
            var convertMod = findByProps("convertVideo") || videoUtils;
            if (convertMod && typeof convertMod.convertVideo === "function") {
                patches.push(instead("convertVideo", convertMod, function (args, orig) {
                    var opts = args[0];
                    if (!opts) return orig.apply(this, args);
                    var uri = opts.uri || opts.filePath || opts.path || "";
                    if (isVideoUri(uri)) {
                        console.log(TAG, "convertVideo: forcing skipVideoTranscode=true");
                        return orig.call(this, Object.assign({}, opts, { skipVideoTranscode: true }));
                    }
                    return orig.apply(this, args);
                }));
                patched++;
            }

            // Layer 4: MediaManager native bridge fallback
            var mm = findByProps("callNativeFunction", "uploadLocalFile");
            if (mm && typeof mm.callNativeFunction === "function") {
                patches.push(instead("callNativeFunction", mm, function (args, orig) {
                    var method = args[0];
                    var uri    = args[1];
                    var config = args[2];
                    if (method === "compressVideo" && isVideoUri(uri || "")) {
                        console.log(TAG, "MediaManager.compressVideo: injecting skipVideoTranscode");
                        return orig.call(this, method, uri, Object.assign({}, config || {}, { skipVideoTranscode: true }));
                    }
                    return orig.apply(this, args);
                }));
                patched++;
            }

            console.log(TAG, "loaded (" + patched + " patches)");
        },

        onUnload: function () {
            patches.forEach(function (p) { try { p && p(); } catch (e) {} });
            patches = [];
            console.log(TAG, "unloaded");
        }
    };
})()
