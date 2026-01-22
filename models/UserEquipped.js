// src/models/UserEquipped.model.js
const mongoose = require("mongoose");

const UserEquippedSchema = new mongoose.Schema(
    {
        // _id = UserEquippedID
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },
        slotType: { type: String, required: true, trim: true },
        equippedAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

// ERD: UNIQUE(UserID, ItemID) và UNIQUE(UserID, SlotType)
UserEquippedSchema.index({ userId: 1, itemId: 1 }, { unique: true });
UserEquippedSchema.index({ userId: 1, slotType: 1 }, { unique: true });

module.exports = mongoose.model("UserEquipped", UserEquippedSchema);
