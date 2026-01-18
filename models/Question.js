const mongoose = require("mongoose");

const QuestionSchema = new mongoose.Schema(
    {
        content: { type: String, required: true, trim: true },

        // 3 dạng câu hỏi
        questionType: {
            type: String,
            required: true,
            trim: true,
            enum: ["MULTIPLE_CHOICE", "FILL_BLANK", "TRUE_FALSE"],
        },

        isActive: { type: Boolean, default: true },

        wordId: { type: mongoose.Schema.Types.ObjectId, ref: "Word", required: true },

        deletedAt: { type: Date, default: null },
    },
    { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

QuestionSchema.index({ wordId: 1, isActive: 1 });

module.exports = mongoose.model("Question", QuestionSchema);
