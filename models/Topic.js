const mongoose = require("mongoose");

const TopicSchema = new mongoose.Schema(
    {
        topicName: { type: String, required: true, trim: true },
        description: { type: String, default: null },
        maxLevel: { type: Number, default: 1 }, // theo hình "MaxLevel"
        isActive: { type: Boolean, default: true },
        deletedAt: { type: Date, default: null },
    },
    { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

// Gợi ý index (tùy bạn muốn unique hay không)
TopicSchema.index({ topicName: 1 }, { unique: true });

module.exports = mongoose.model("Topic", TopicSchema);
