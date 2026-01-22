const mongoose = require("mongoose");

const WordNoteSchema = new mongoose.Schema(
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
        note: {
            type: String,
            required: true,
            trim: true,
            maxlength: 300,
        },
    },
    {
        timestamps: true, // createdAt ~ ERD (+updatedAt tiện cho edit)
        versionKey: false,
    }
);

// 1 user chỉ có 1 note cho 1 word
WordNoteSchema.index({ userId: 1, wordId: 1 }, { unique: true });

module.exports = mongoose.model("WordNote", WordNoteSchema);
