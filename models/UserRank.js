// src/models/UserRank.model.js
const mongoose = require("mongoose");

const UserRankSchema = new mongoose.Schema(
    {
        // _id = UserRankID

        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },

        rankId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Rank",
            required: true,
            index: true,
        },

        achievedDate: { type: Date, required: true, default: Date.now },
    },
    { timestamps: true }
);

// Tránh trùng rank cho cùng user
UserRankSchema.index({ userId: 1, rankId: 1 }, { unique: true });
// Truy vấn rank mới nhất: sort achievedDate desc
UserRankSchema.index({ userId: 1, achievedDate: -1 });

module.exports = mongoose.model("UserRank", UserRankSchema);
