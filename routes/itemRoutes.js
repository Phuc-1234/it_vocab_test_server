const express = require("express");
const router = express.Router();
const itemController = require("../controllers/item");

// Middleware upload (cấu hình memoryStorage để lấy buffer)
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

// Middleware auth (nếu cần admin mới tạo được item)
// const { verifyToken, isAdmin } = require("../middleware/auth");

// Route POST /items
// Sử dụng upload.single("image") -> Client phải gửi field tên là "image"
router.post(
    "/",
    // verifyToken, isAdmin, // Uncomment nếu cần bảo mật
    upload.single("image"), // <--- QUAN TRỌNG
    itemController.createItem
);

module.exports = router;