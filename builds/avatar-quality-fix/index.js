(function () {
    var TAG = "[AvatarQualityFix]";

    // Target crop size: 1024x1024
    // Web uploads original size (626x626 observed), Discord serves up to 1024
    // Mobile was cropping to AVATAR_MAX_SIZE=256 -> boosting to 1024
    var TARGET_SIZE = 1024;

    return {
        onLoad: function () {
            var findByProps = vendetta.metro.findByProps;
            var instead     = vendetta.patcher.instead;
            var patched     = 0;

            // Root cause (APK 339.11 + PNG comparison analysis):
            //   openCropper is called with { width: 256, height: 256 } (AVATAR_MAX_SIZE=256)
            //   This crops and downscales the avatar to 256x256 before upload.
            //   Web client sends original resolution (~626x626 observed).
            //
            // Fix:
            //   1. Override width/height to 1024x1024 (max Discord serves)
            //   2. Set compressImageQuality:1 to prevent additional lossy compression

            var cropPicker = findByProps("openCropper", "openPicker");
            if (cropPicker && typeof cropPicker.openCropper === "function") {
                instead("openCropper", cropPicker, function (args, orig) {
                    var opts = args[0];
                    if (!opts) return orig.apply(this, args);

                    // Only boost square crops (avatar/icon context)
                    // Non-avatar picks usually have freeStyleCropEnabled:true or non-square dims
                    var w = opts.width  || 0;
                    var h = opts.height || 0;
                    var isSquareCrop = (w === h) && w > 0 && w <= 512;

                    if (isSquareCrop) {
                        var new_opts = Object.assign({}, opts, {
                            width:                TARGET_SIZE,
                            height:               TARGET_SIZE,
                            compressImageQuality: 1,
                            compressImageMaxWidth:  TARGET_SIZE,
                            compressImageMaxHeight: TARGET_SIZE
                        });
                        console.log(TAG, "openCropper: " + w + "x" + h + " -> " + TARGET_SIZE + "x" + TARGET_SIZE + ", quality=1.0");
                        return orig.call(this, new_opts);
                    }

                    return orig.apply(this, args);
                });
                patched++;
            } else {
                console.warn(TAG, "openCropper not found");
            }

            // Secondary: force HIGH quality in all other image upload flows
            var uploadUtils = findByProps("openImagePickerUnhandled", "getImageCompressionQuality");
            if (uploadUtils && typeof uploadUtils.getImageCompressionQuality === "function") {
                instead("getImageCompressionQuality", uploadUtils, function (_args, orig) {
                    var result = orig.apply(this, _args);
                    // Return HIGH variant regardless of data saving mode / network type
                    // HIGH is the non-cellular quality level
                    if (result && typeof result === "object" && result.LOW != null) {
                        return result.HIGH != null ? result.HIGH : result;
                    }
                    return result;
                });
                patched++;
            }

            console.log(TAG, "loaded (" + patched + " patches) - avatar crop: 256 -> " + TARGET_SIZE);
        },

        onUnload: function () {
            console.log(TAG, "unloaded");
        }
    };
})()
