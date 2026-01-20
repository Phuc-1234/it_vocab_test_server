// src/models/Rank.model.js
const mongoose = require("mongoose");

const RankSchema = new mongoose.Schema(
    {
        // _id = RankID

        rankLevel: { type: Number, required: true, min: 1, index: true },

        neededEXP: { type: Number, required: true, min: 0 },

        rankName: { type: String, required: true, trim: true, maxlength: 100 },

        rewardItemId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Item",
            default: null,
        },
    },
    { timestamps: true }
);

RankSchema.index({ rankLevel: 1 }, { unique: true });

module.exports = mongoose.model("Rank", RankSchema);
