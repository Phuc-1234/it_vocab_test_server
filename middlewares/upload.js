// upload.js
const multer = require("multer");

const storage = multer.memoryStorage();

const ALLOWED_MIME = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
]);

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        if (!ALLOWED_MIME.has(file.mimetype)) {
            const err = new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname);
            err.message = "Unsupported file type";
            return cb(err);
        }
        cb(null, true);
    },
});

module.exports = upload;
