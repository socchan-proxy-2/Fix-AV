(function () {
    var TAG = "[AvatarQualityFix]";
    var TARGET_SIZE = 1024;

    return {
        onLoad: function () {
            var findByProps = vendetta.metro.findByProps;
            var instead     = vendetta.patcher.instead;
            var patched     = 0;

            // Layer 1: Upload constants module -
            // UPLOAD_MEDIUM_SIZE=256, UPLOAD_SMALL_SIZE=128 -> 1024
            var uploadConsts = findByProps("UPLOAD_MEDIUM_SIZE", "UPLOAD_SMALL_SIZE", "UPLOAD_BANNER_SIZE");
            if (uploadConsts) {
                uploadConsts.UPLOAD_MEDIUM_SIZE = TARGET_SIZE;
                uploadConsts.UPLOAD_SMALL_SIZE  = TARGET_SIZE;
                console.log(TAG, "UPLOAD_MEDIUM_SIZE/SMALL_SIZE -> " + TARGET_SIZE);
                patched++;
            } else {
                console.warn(TAG, "upload constants module not found");
            }

            // Layer 2: Main constants module
            // AVATAR_MAX_SIZE, AVATAR_SIZE -> 1024
            var mainConsts = findByProps("AVATAR_MAX_SIZE", "BITRATE_MIN", "BITRATE_DEFAULT");
            if (mainConsts) {
                mainConsts.AVATAR_MAX_SIZE = TARGET_SIZE;
                console.log(TAG, "AVATAR_MAX_SIZE -> " + TARGET_SIZE);
                patched++;
            } else {
                console.warn(TAG, "main constants module not found");
            }

            // Layer 3: openImagePicker call intercept -
            // useUploadAvatar calls openImagePicker({size: UPLOAD_MEDIUM_SIZE})
            // Layer 1 changes the constant, but closure-captured values won't update.
            // Patch the function too as fallback.
            var pickerMod = findByProps("openImagePicker", "openImagePickerUnhandled");
            if (pickerMod && typeof pickerMod.openImagePicker === "function") {
                instead("openImagePicker", pickerMod, function (args, orig) {
                    var opts = args[0];
                    if (opts && opts.size != null) {
                        console.log(TAG, "openImagePicker: size " + opts.size + " -> " + TARGET_SIZE);
                        args[0] = Object.assign({}, opts, { size: TARGET_SIZE });
                    }
                    return orig.apply(this, args);
                });
                patched++;
            }

            // Layer 4: launchCropper (on openCropper function object) -
            if (pickerMod && pickerMod.openCropper &&
                typeof pickerMod.openCropper.launchCropper === "function") {
                instead("launchCropper", pickerMod.openCropper, function (args, orig) {
                    var opts = args[0];
                    if (opts && opts.width != null) {
                        console.log(TAG, "launchCropper: " + opts.width + "x" + opts.height + " -> " + TARGET_SIZE + "x" + TARGET_SIZE);
                        args[0] = Object.assign({}, opts, { width: TARGET_SIZE, height: TARGET_SIZE });
                    }
                    return orig.apply(this, args);
                });
                patched++;
            }

            // Layer 5: openCropper (RNCImageCropPicker) -
            if (pickerMod && typeof pickerMod.openCropper === "function") {
                instead("openCropper", pickerMod, function (args, orig) {
                    var opts = args[0];
                    if (opts && opts.width != null) {
                        console.log(TAG, "openCropper: " + opts.width + "x" + opts.height + " -> " + TARGET_SIZE + "x" + TARGET_SIZE);
                        args[0] = Object.assign({}, opts, {
                            width:                TARGET_SIZE,
                            height:               TARGET_SIZE,
                            compressImageQuality: 1,
                            compressImageMaxWidth:  TARGET_SIZE,
                            compressImageMaxHeight: TARGET_SIZE
                        });
                    }
                    return orig.apply(this, args);
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
