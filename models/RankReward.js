// src/models/RankReward.model.js
const mongoose = require("mongoose");

const RankRewardSchema = new mongoose.Schema(
    {
        // _id = (Mongo ObjectId). ERD dùng PK kép (RankID, ItemID) => ta dùng unique index
        rankId: { type: mongoose.Schema.Types.ObjectId, ref: "Rank", required: true },
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },
        quantity: { type: Number, required: true, min: 1, default: 1 },
    },
    { timestamps: true }
);

// ERD: UNIQUE(RankID, ItemID)
RankRewardSchema.index({ rankId: 1, itemId: 1 }, { unique: true });

module.exports = mongoose.model("RankReward", RankRewardSchema);

