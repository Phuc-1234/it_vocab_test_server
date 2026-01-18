const mongoose = require("mongoose");

const WordSchema = new mongoose.Schema(
    {
        word: { type: String, required: true, trim: true },
        pronunciation: { type: String, default: null },
        meaningEN: { type: String, default: null },
        meaningVN: { type: String, default: null },
        standFor: { type: String, default: null },
        example: { type: String, default: null },

        level: { type: Number, default: 1 },
        isActive: { type: Boolean, default: true },

        topicId: { type: mongoose.Schema.Types.ObjectId, ref: "Topic", required: true },

        deletedAt: { type: Date, default: null },
    },
    { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

// 1 topic có thể có nhiều word, tránh trùng word trong cùng topic (tùy bạn)
WordSchema.index({ topicId: 1, word: 1 }, { unique: true });

module.exports = mongoose.model("Word", WordSchema);
