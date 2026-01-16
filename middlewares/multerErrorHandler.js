// multerErrorHandler.js
const multer = require("multer");

function multerErrorHandler(err, req, res, next) {
    if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({ message: "File quá lớn (tối đa 5MB)." });
        }
        return res.status(400).json({ message: "File upload không hợp lệ." });
    }
    if (err) {
        return res.status(400).json({ message: err.message || "Upload lỗi." });
    }
    next();
}

module.exports = multerErrorHandler;
