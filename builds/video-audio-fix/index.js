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
            // format=null (L-SMASH不正metadata) でも強制 true にして compressVideo を呼ばせない
            var videoUtils = findByProps("canSkipVideoTranscode", "calculateTargetDimensions");
            if (videoUtils && typeof videoUtils.canSkipVideoTranscode === "function") {
                patches.push(instead("canSkipVideoTranscode", videoUtils, function (args, orig) {
                    var meta = args[1];
                    if (!meta) return orig.apply(this, args);
                    var fmt = meta.format != null ? meta.format : "";
                    if (H264_FMT.test(fmt) || fmt === "") {
                        console.log(TAG, "canSkipVideoTranscode → true (format=\"" + fmt + "\")");
                        return true;
                    }
                    return orig.apply(this, args);
                }));
                patched++;
            }

            // Layer 2: VideoQualityTarget の targetBitrate 引き上げ
            // APK実値 MEDIUM=1,800,000bps → 動画3,850,506bpsが超えて圧縮発動するのを防ぐ
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
                    console.warn(TAG, "Layer2 失敗:", e);
                }
            }

            // Layer 3: convertVideo → skipVideoTranscode 強制
            var convertMod = findByProps("convertVideo") || videoUtils;
            if (convertMod && typeof convertMod.convertVideo === "function") {
                patches.push(instead("convertVideo", convertMod, function (args, orig) {
                    var opts = args[0];
                    if (!opts) return orig.apply(this, args);
                    var uri = opts.uri || opts.filePath || opts.path || "";
                    if (isVideoUri(uri)) {
                        console.log(TAG, "convertVideo: skipVideoTranscode → true");
                        return orig.call(this, Object.assign({}, opts, { skipVideoTranscode: true }));
                    }
                    return orig.apply(this, args);
                }));
                patched++;
            }

            // Layer 4: MediaManager native bridge
            var mm = findByProps("callNativeFunction", "uploadLocalFile");
            if (mm && typeof mm.callNativeFunction === "function") {
                patches.push(instead("callNativeFunction", mm, function (args, orig) {
                    var method = args[0], uri = args[1], config = args[2];
                    if (method === "compressVideo" && isVideoUri(uri || "")) {
                        console.log(TAG, "MediaManager.compressVideo: skipVideoTranscode 注入");
                        return orig.call(this, method, uri, Object.assign({}, config || {}, { skipVideoTranscode: true }));
                    }
                    return orig.apply(this, args);
                }));
                patched++;
            }

            console.log(TAG, "起動完了 (" + patched + " パッチ)");
        },

        onUnload: function () {
            patches.forEach(function (p) { try { p && p(); } catch (e) {} });
            patches = [];
            console.log(TAG, "停止。");
        }
    };
})()
