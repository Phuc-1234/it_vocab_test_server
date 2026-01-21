const mongoose = require("mongoose");

const PinnedWordSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        wordId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Word",
            required: true,
            index: true,
        },
    },
    {
        timestamps: true, // createdAt ~ ERD
        versionKey: false,
    }
);

// 1 user chỉ pin 1 word 1 lần
PinnedWordSchema.index({ userId: 1, wordId: 1 }, { unique: true });

module.exports = mongoose.model("PinnedWord", PinnedWordSchema);
