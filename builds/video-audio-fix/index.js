/**
 * VideoAudioFix v2.1 - Revenge Plugin
 * APK 339.11 解析済み精密版
 *
 * 原因: 動画 3,850,506bps > MEDIUM target 1,800,000bps かつ
 *       L-SMASH 不正 metadata で format=null になり compressVideo 発動 → 砂嵐
 *
 * API: bunny.metro.findByProps / bunny.api.patcher.instead
 *      (unpatcerはshimDisposableFnで自動管理)
 */

const TAG = "[VideoAudioFix]";
const log  = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);
const err  = (...a) => console.error(TAG, ...a);

const VIDEO_EXTS = /\.(mp4|mov|avi|mkv|webm|m4v|3gp|ts|mts|m2ts)$/i;
const H264_FMT   = /(avc1|hvc1|avc|hevc|h\.?264|h\.?265|mp4)/i;

function isVideoUri(s) {
    return typeof s === "string" && VIDEO_EXTS.test(s);
}

definePlugin({
    start() {
        log("起動 v2.1");

        const { findByProps } = bunny.metro;
        const { instead }     = bunny.api.patcher;
        let patched = 0;

        // ── Layer 1: canSkipVideoTranscode ──────────────────────────────────
        // APK解析で確認済み: format=null or avc1 なら強制 true にして
        // compressVideo を呼ばせない
        const videoUtils = findByProps("canSkipVideoTranscode", "calculateTargetDimensions");
        if (videoUtils?.canSkipVideoTranscode) {
            instead("canSkipVideoTranscode", videoUtils, (args, orig) => {
                const meta = args[1];
                if (!meta) return orig(...args);
                const fmt = meta.format ?? "";
                if (H264_FMT.test(fmt) || fmt === "") {
                    log(`canSkipVideoTranscode → true (format="${fmt}")`);
                    return true;
                }
                return orig(...args);
            });
            patched++;
        } else {
            warn("canSkipVideoTranscode 未発見");
        }

        // ── Layer 2: VideoQualityTarget の targetBitrate 引き上げ ───────────
        // APK実値 MEDIUM=1,800,000bps → 動画の3,850,506bpsが超えて圧縮発動
        // 99Mbps にすれば bitrateOK=true になりスキップ判定を通過しやすくなる
        const configMod = findByProps("DEFAULT_VIDEO_ENCODING_CONFIG", "VideoQualityTarget");
        if (configMod) {
            try {
                if (configMod.DEFAULT_VIDEO_ENCODING_CONFIG) {
                    configMod.DEFAULT_VIDEO_ENCODING_CONFIG.targetBitrate = 99_000_000;
                    log("DEFAULT_VIDEO_ENCODING_CONFIG.targetBitrate → 99Mbps");
                    patched++;
                }
                const VQT = configMod.VideoQualityTarget;
                if (VQT) {
                    ["VERY_LOW", "LOW", "MEDIUM", "HIGH", "VERY_HIGH"].forEach(lv => {
                        if (VQT[lv] != null && "targetBitrate" in VQT[lv]) {
                            VQT[lv].targetBitrate = 99_000_000;
                            log(`VideoQualityTarget.${lv}.targetBitrate → 99Mbps`);
                            patched++;
                        }
                    });
                }
            } catch (e) { warn("Layer2 失敗:", e); }
        }

        // ── Layer 3: convertVideo → skipVideoTranscode 強制 ─────────────────
        const convertMod = findByProps("convertVideo") ?? videoUtils;
        if (convertMod?.convertVideo) {
            instead("convertVideo", convertMod, async (args, orig) => {
                const [opts] = args;
                if (!opts) return orig(...args);
                const uri = opts.uri ?? opts.filePath ?? opts.path ?? "";
                if (isVideoUri(uri)) {
                    log("convertVideo: skipVideoTranscode → true");
                    return orig({ ...opts, skipVideoTranscode: true });
                }
                return orig(...args);
            });
            patched++;
        }

        // ── Layer 4: MediaManager native bridge ─────────────────────────────
        const mm = findByProps("callNativeFunction", "uploadLocalFile");
        if (mm?.callNativeFunction) {
            instead("callNativeFunction", mm, (args, orig) => {
                const [method, uri, config] = args;
                if (method === "compressVideo" && isVideoUri(uri ?? "")) {
                    log("MediaManager.callNativeFunction(compressVideo): skipVideoTranscode 注入");
                    return orig(method, uri, { ...(config ?? {}), skipVideoTranscode: true });
                }
                return orig(...args);
            });
            patched++;
        }

        log(`✓ 起動完了 (${patched} パッチ)`);
    },

    stop() {
        // unpatcerはbunny.api.patcher (shimDisposableFn) が自動管理
        log("停止。");
    }
});
