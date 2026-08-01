(function () {
    var TAG = "[AvatarQualityFix]";

    return {
        onLoad: function () {
            var findByProps = vendetta.metro.findByProps;
            var instead     = vendetta.patcher.instead;
            var patched     = 0;

            // Root cause (APK 339.11 analysis):
            //   openImagePickerUnhandled calls RNCImageCropPicker.openCropper with:
            //   { mediaType:'photo', path, width, height, includeBase64, mimeType, ... }
            //   No compressImageQuality is set -> defaults to ~0.8 JPEG compression
            //   Result: avatar gets lossy-compressed before being sent to Discord API
            //
            // Fix: inject compressImageQuality:1 into every openCropper call
            //   This forces lossless (or maximum quality) output from the cropper

            // Primary: patch the RNCImageCropPicker wrapper module
            var cropPicker = findByProps("openCropper", "openPicker");
            if (cropPicker && typeof cropPicker.openCropper === "function") {
                instead("openCropper", cropPicker, function (args, orig) {
                    var opts = args[0];
                    if (!opts) return orig.apply(this, args);

                    var patched_opts = Object.assign({}, opts, {
                        compressImageQuality: 1,   // lossless (1.0 = no compression)
                        compressImageMaxWidth: opts.width   || 10240,
                        compressImageMaxHeight: opts.height || 10240
                    });

                    console.log(TAG, "openCropper: compressImageQuality -> 1.0");
                    return orig.call(this, patched_opts);
                });
                patched++;
            } else {
                console.warn(TAG, "openCropper not found");
            }

            // Secondary: patch getImageCompressionQuality to always return HIGH
            // This affects other image upload flows that use this function
            var uploadUtils = findByProps("openImagePickerUnhandled", "getImageCompressionQuality");
            if (uploadUtils && typeof uploadUtils.getImageCompressionQuality === "function") {
                instead("getImageCompressionQuality", uploadUtils, function (_args, _orig) {
                    // Always return HIGH regardless of data saving mode or network type
                    var qualityConsts = vendetta.metro.findByProps("HIGH", "LOW", "MEDIUM");
                    if (qualityConsts && qualityConsts.HIGH != null) {
                        console.log(TAG, "getImageCompressionQuality -> HIGH");
                        return qualityConsts.HIGH;
                    }
                    // Fallback: return numeric 1 (some libs use 0-1 scale)
                    return 1;
                });
                patched++;
            }

            console.log(TAG, "loaded (" + patched + " patches)");
        },

        onUnload: function () {
            console.log(TAG, "unloaded");
        }
    };
})()
