// src/controllers/item.controller.js
const Item = require("../models/Item");
const { uploadFileToCloudinary } = require("../services/cloudinaryUpload"); // Import hàm upload

function badRequest(res, message) {
    return res.status(400).json({ message });
}

exports.createItem = async (req, res) => {
    try {
        const {
            itemName,
            // itemImageURL, // Bỏ lấy trực tiếp ở đây, xử lý logic bên dưới
            itemType,
            durationType = null,
            durationValue = null,
            isStackable = false,
            effectType,
            effectValue = null,
        } = req.body;

        // 1. Validate các trường bắt buộc cơ bản
        if (!itemName || String(itemName).trim().length === 0) {
            return badRequest(res, "itemName là bắt buộc.");
        }
        if (!itemType) return badRequest(res, "itemType là bắt buộc.");
        if (!effectType) return badRequest(res, "effectType là bắt buộc.");

        // 2. Validate Enum
        const ITEM_TYPES = ["SKIN", "CONSUMABLE"];
        const DURATION_TYPES = ["PERMANENT", "DAYS", null];
        const EFFECT_TYPES = ["XP_MULTIPLIER", "NONE"];

        if (!ITEM_TYPES.includes(itemType)) {
            return badRequest(res, `itemType không hợp lệ. Chỉ nhận: ${ITEM_TYPES.join(", ")}`);
        }
        if (!DURATION_TYPES.includes(durationType)) {
            return badRequest(res, "durationType không hợp lệ. Chỉ nhận: PERMANENT | DAYS | null");
        }
        if (!EFFECT_TYPES.includes(effectType)) {
            return badRequest(res, `effectType không hợp lệ. Chỉ nhận: ${EFFECT_TYPES.join(", ")}`);
        }

        // 3. Logic Duration
        let finalDurationValue = durationValue;
        if (durationType === "PERMANENT" || durationType === null) {
            finalDurationValue = null;
        } else if (durationType === "DAYS") {
            const v = Number(durationValue);
            if (!Number.isFinite(v) || v <= 0) {
                return badRequest(res, "durationValue phải là số > 0 khi durationType = DAYS.");
            }
            finalDurationValue = v;
        }

        // 4. Logic Effect
        let finalEffectValue = effectValue;
        if (effectType === "NONE") {
            finalEffectValue = null;
        } else if (effectType === "XP_MULTIPLIER") {
            const v = Number(effectValue);
            if (!Number.isFinite(v) || v <= 0) {
                return badRequest(res, "effectValue phải là số > 0 khi effectType = XP_MULTIPLIER.");
            }
            finalEffectValue = v;
        }

        // 5. XỬ LÝ UPLOAD ẢNH (CLOUDINARY)
        let finalItemImageURL = req.body.itemImageURL || null; // Mặc định lấy text nếu ko có file

        if (req.file) {
            // Nếu có file, thực hiện upload
            try {
                const uploadResult = await uploadFileToCloudinary(req.file, "items"); // Folder 'items'
                finalItemImageURL = uploadResult.url;
            } catch (uploadError) {
                return res.status(500).json({
                    message: "Lỗi khi upload ảnh lên Cloudinary.",
                    error: uploadError.message
                });
            }
        }

        // 6. Tạo DB Record
        const doc = await Item.create({
            itemName: String(itemName).trim(),
            itemImageURL: finalItemImageURL, // Sử dụng URL đã xử lý
            itemType,
            durationType,
            durationValue: finalDurationValue,
            isStackable: Boolean(isStackable),
            effectType,
            effectValue: finalEffectValue,
        });

        return res.status(201).json({
            message: "Tạo item thành công.",
            data: doc,
        });

    } catch (err) {
        return res.status(500).json({
            message: "Lỗi server khi tạo item.",
            error: err?.message,
        });
    }
};