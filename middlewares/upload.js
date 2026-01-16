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
            return cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "file"));
        }
        return cb(null, true);
    },
});

module.exports = upload;
