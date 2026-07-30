/**
 * VideoAudioFix - Revenge Plugin  v2.1 (APK 339.11 精密解析版)
 * =================================================================
 *
 * 【確定した原因 - APK 339.11 解析結果】
 *
 *  Discord の動画圧縮判定フロー (VideoUploadUtils.tsx):
 *
 *  1. convertVideo() が呼ばれる (デフォルトクオリティ: MEDIUM)
 *  2. canSkipVideoTranscode(qualityTarget, videoMetadata, fileSize, ...) で判定:
 *
 *       targetDims = calculateTargetDimensions(meta, 480)  ← MEDIUM = 480p
 *       dimensionOK = (roundedW <= targetDims.w) AND (roundedH <= targetDims.h)
 *       bitrateOK   = meta.bitRate <= 1_800_000  ← MEDIUM targetBitrate
 *
 *       if NOT (dimensionOK AND bitrateOK):
 *           if format == null  → return false (圧縮する)
 *           if format.match(/(avc1|hvc1|video\/(avc|hevc))/i) == null
 *                              → return false (圧縮する)
 *           return true  (スキップ可)
 *
 *  3. 問題の動画: 1920×1080, 3,850,506 bps, L-SMASH mux
 *       → 1920 > 854 (640×480スケール) → dimensionOK = false
 *       → 3,850,506 > 1,800,000        → bitrateOK   = false
 *       → L-SMASHの非標準metadataで format = null の可能性大
 *       → canSkipVideoTranscode が false を返す
 *       → NativeModules.MediaManager.compressVideo() 発動
 *       → ネイティブエンコーダーが254kbps AACの処理に失敗 → 砂嵐
 *
 *  4. VideoQualityTarget レベル (APK実値):
 *       VERY_LOW  360p  800,000 bps
 *       LOW       360p  1,200,000 bps
 *       MEDIUM    480p  1,800,000 bps  ← デフォルト
 *       HIGH      720p  2,250,000 bps
 *       VERY_HIGH 1080p 7,000,000 bps
 *
 * 【対策 - 3層防御】
 *
 *  Layer 1: canSkipVideoTranscode をフック
 *    → format が null/不明でも H.264 相当なら true を返す
 *    → これにより compressVideo が呼ばれなくなる
 *
 *  Layer 2: VideoQualityTarget.VERY_HIGH を強制使用
 *    → DEFAULT_VIDEO_ENCODING_CONFIG の targetBitrate を 99Mbps に
 *    → bitrateOK が常に true になるため compressVideo に到達しにくくなる
 *
 *  Layer 3: convertVideo で skipVideoTranscode: true を強制
 *    → Layer 1/2 をすり抜けた場合の最終防衛
 */

const TAG = '[VideoAudioFix]';
const log  = (...a) => console.log(TAG,  ...a);
const warn = (...a) => console.warn(TAG, ...a);
const err  = (...a) => console.error(TAG, ...a);

const patches = [];

// ─── ユーティリティ ──────────────────────────────────────────────────────────

function safePatch(label, mod, method, fn) {
  if (!mod || typeof mod[method] !== 'function') {
    warn(`スキップ (未発見): ${label}.${method}`);
    return false;
  }
  try {
    patches.push(vendetta.patcher.instead(method, mod, fn));
    log(`✓ ${label}.${method}`);
    return true;
  } catch (e) {
    err(`パッチ失敗: ${label}.${method}`, e);
    return false;
  }
}

const VIDEO_EXTS = /\.(mp4|mov|avi|mkv|webm|m4v|3gp|ts|mts|m2ts)$/i;
const VIDEO_MIME = /^video\//i;
const H264_FMT   = /(avc1|hvc1|avc|hevc|h\.?264|h\.?265|mp4)/i;

function isVideoUri(s) {
  return typeof s === 'string' && (VIDEO_EXTS.test(s) || VIDEO_MIME.test(s));
}

function isVideoFile(f) {
  if (!f) return false;
  if (typeof f === 'string') return isVideoUri(f);
  return (
    VIDEO_MIME.test(f.type  || '') ||
    VIDEO_MIME.test(f.mime  || '') ||
    VIDEO_EXTS.test(f.name  || '') ||
    VIDEO_EXTS.test(f.uri   || '') ||
    VIDEO_EXTS.test(f.path  || '')
  );
}

// ─── プラグイン本体 ──────────────────────────────────────────────────────────

export default {
  onLoad() {
    log('起動 v2.1 (APK 339.11 精密解析版)');
    const { findByProps } = vendetta.metro;
    let patched = 0;

    // ══════════════════════════════════════════════════════════════════════════
    // Layer 1: canSkipVideoTranscode フック
    //
    //   APK解析でこの関数が圧縮ゲートと確認済み。
    //   format が null/不明でも H.264/HEVC コンテナなら true を返す。
    //   → compressVideo が呼ばれなくなり砂嵐が発生しない。
    // ══════════════════════════════════════════════════════════════════════════
    const videoUtils = findByProps('canSkipVideoTranscode', 'calculateTargetDimensions');

    if (safePatch('VideoUploadUtils', videoUtils, 'canSkipVideoTranscode',
      (args, orig) => {
        // args: [qualityTarget, videoMetadata, fileSize, maxFileSize, vqt]
        const meta = args[1];
        if (!meta) return orig(...args);

        const fmt    = (meta.format ?? '');
        const isH264 = H264_FMT.test(fmt);

        if (isH264 || fmt === '') {
          // format が avc1/H.264 相当、または null/空 (L-SMASH不正metadata)
          // → 圧縮をスキップして音声劣化を防ぐ
          log(`canSkipVideoTranscode → true (format="${fmt}", bitRate=${meta.bitRate ?? 'N/A'})`);
          return true;
        }

        return orig(...args);
      }
    )) patched++;

    // ══════════════════════════════════════════════════════════════════════════
    // Layer 2: DEFAULT_VIDEO_ENCODING_CONFIG の targetBitrate を引き上げ
    //
    //   APK解析で DEFAULT_VIDEO_ENCODING_CONFIG.targetBitrate = MEDIUM.targetBitrate
    //   = 1,800,000 bps と確認。動画のbitRate 3,850,506 bps が超えて圧縮発動する。
    //   targetBitrate を 99Mbps にすることで bitrateOK = true になる。
    // ══════════════════════════════════════════════════════════════════════════
    const configMod = findByProps('DEFAULT_VIDEO_ENCODING_CONFIG', 'VideoQualityTarget');
    if (configMod) {
      try {
        // DEFAULT_VIDEO_ENCODING_CONFIG のビットレート上限を引き上げ
        if (configMod.DEFAULT_VIDEO_ENCODING_CONFIG) {
          configMod.DEFAULT_VIDEO_ENCODING_CONFIG.targetBitrate = 99_000_000;
          log('DEFAULT_VIDEO_ENCODING_CONFIG.targetBitrate → 99,000,000');
          patched++;
        }

        // 各 VideoQualityTarget レベルのビットレートも引き上げ
        // (APK実値: VERY_LOW=800k, LOW=1.2M, MEDIUM=1.8M, HIGH=2.25M, VERY_HIGH=7M)
        const VQT = configMod.VideoQualityTarget;
        if (VQT) {
          ['VERY_LOW', 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'].forEach(level => {
            if (VQT[level] != null && 'targetBitrate' in VQT[level]) {
              VQT[level].targetBitrate = 99_000_000;
              log(`VideoQualityTarget.${level}.targetBitrate → 99,000,000`);
              patched++;
            }
          });
        }
      } catch (e) {
        warn('Layer 2 パッチ失敗:', e);
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Layer 3: convertVideo フック (skipVideoTranscode 強制注入)
    //
    //   Layer 1/2 をすり抜けた場合のフォールバック。
    //   encodingConfig に skipVideoTranscode: true を直接注入する。
    // ══════════════════════════════════════════════════════════════════════════
    const convertMod = findByProps('convertVideo') ?? videoUtils;

    if (safePatch('VideoUploadUtils', convertMod, 'convertVideo',
      async (args, orig) => {
        const [opts] = args;
        if (!opts) return orig(...args);

        const uri = opts.uri ?? opts.filePath ?? opts.path ?? '';
        if (isVideoUri(uri)) {
          log('convertVideo: skipVideoTranscode → true');
          return orig({ ...opts, skipVideoTranscode: true });
        }
        return orig(...args);
      }
    )) patched++;

    // ══════════════════════════════════════════════════════════════════════════
    // Layer 4: MediaManager native bridge フック (最終手段)
    //
    //   上記すべてが失敗した場合、ネイティブ呼び出しレベルで
    //   compressVideo の options に skipVideoTranscode を注入する。
    // ══════════════════════════════════════════════════════════════════════════
    const mmProps = ['callNativeFunction', 'compressVideo'];
    for (const prop of mmProps) {
      const mm = findByProps(prop, 'uploadLocalFile') ??
                 findByProps('MediaManager')?.[prop != 'compressVideo' ? 'MediaManager' : prop];
      if (!mm) continue;

      if (safePatch('MediaManager', mm, prop === 'callNativeFunction' ? prop : prop,
        prop === 'callNativeFunction'
          ? (args, orig) => {
              const [method, uri, config] = args;
              if (method === 'compressVideo' && isVideoFile(uri)) {
                log('MediaManager.callNativeFunction(compressVideo): skipVideoTranscode 注入');
                return orig(method, uri, { ...(config ?? {}), skipVideoTranscode: true });
              }
              return orig(...args);
            }
          : (args, orig) => {
              const [uri, config] = args;
              if (isVideoFile(uri ?? '')) {
                log('MediaManager.compressVideo: skipVideoTranscode 注入');
                return orig(uri, { ...(config ?? {}), skipVideoTranscode: true });
              }
              return orig(...args);
            }
      )) patched++;
    }

    // ─── 結果 ─────────────────────────────────────────────────────────────────
    if (patched === 0) {
      warn('パッチ対象が見つかりませんでした。Discordのバージョンを確認してください。');
      try { vendetta.ui.toasts.showToast(TAG + ' モジュール未発見'); } catch (_) {}
    } else {
      log(`✓ 起動完了 (${patched} パッチ適用)`);
    }
  },

  onUnload() {
    patches.forEach(up => { try { up?.(); } catch (e) { err('アンパッチ失敗:', e); } });
    patches.length = 0;
    log('停止。');
  },
};
