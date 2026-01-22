// models/Item.js
const mongoose = require("mongoose");

const ITEM_TYPES = ["SKIN", "CONSUMABLE"];
const DURATION_TYPES = ["PERMANENT", "DAYS"]; // null allowed
const EFFECT_TYPES = ["XP_MULTIPLIER", "NONE"];

const ItemSchema = new mongoose.Schema(
    {
        itemName: { type: String, required: true, trim: true, maxlength: 200 },
        itemImageURL: { type: String, default: null },
        itemType: { type: String, required: true, enum: ITEM_TYPES },
        durationType: { type: String, default: null, enum: [...DURATION_TYPES, null] },
        durationValue: { type: Number, default: null, min: 0 },
        isStackable: { type: Boolean, required: true, default: false },
        effectType: { type: String, required: true, enum: EFFECT_TYPES },
        effectValue: { type: Number, default: null, min: 0 },
    },
    { timestamps: true }
);

// Index
ItemSchema.index({ itemType: 1 });
ItemSchema.index({ effectType: 1 });

/**
 * Data integrity rules:
 * FIX: Bỏ tham số 'next' vì logic ở đây là đồng bộ (synchronous).
 * Mongoose sẽ tự động chạy xong hàm này rồi mới tiếp tục.
 */
ItemSchema.pre("validate", function () {
    // Lưu ý: Không truyền 'next' vào function()

    // duration rules
    if (this.durationType === "PERMANENT" || this.durationType === null) {
        this.durationValue = null;
    } else if (this.durationType === "DAYS") {
        // nếu đã set DAYS mà thiếu durationValue hoặc <=0 => báo lỗi
        if (this.durationValue == null || Number(this.durationValue) <= 0) {
            this.invalidate("durationValue", "durationValue phải > 0 khi durationType = DAYS");
        }
    }

    // effect rules
    if (this.effectType === "NONE") {
        this.effectValue = null;
    } else if (this.effectType === "XP_MULTIPLIER") {
        if (this.effectValue == null || Number(this.effectValue) <= 0) {
            this.invalidate("effectValue", "effectValue phải > 0 khi effectType = XP_MULTIPLIER");
        }
    }

    // Không cần gọi next() ở cuối nữa
});

// ✅ chống OverwriteModelError
module.exports = mongoose.models.Item || mongoose.model("Item", ItemSchema);