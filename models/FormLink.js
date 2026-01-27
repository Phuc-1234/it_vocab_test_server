// models/FormLink.js
const mongoose = require("mongoose");

const formLinkSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            index: true,
        },
        url: {
            type: String,
            required: true,
            trim: true,
        },
    },
    { timestamps: true },
);

module.exports = mongoose.model("FormLink", formLinkSchema);
