// src/routes/admin.routes.js
const express = require("express");
const router = express.Router();
const adminController = require("../controllers/admin"); // Đảm bảo đúng tên file controller của bạn

// SỬA Ở ĐÂY: Import trực tiếp function authMiddleware thay vì dùng { verifyToken }
const authMiddleware = require("../middlewares/authMiddleware");
const authorizeRoles = require("../middlewares/roleMiddleware");

// ==============================================
// MIDDLEWARE TOÀN CỤC CHO ADMIN ROUTES
// ==============================================
// 1. authMiddleware: Kiểm tra token hợp lệ và gắn payload vào req.user
// 2. authorizeRoles("ADMIN"): Kiểm tra req.user.role có phải là ADMIN không
router.use(authMiddleware, authorizeRoles("ADMIN"));

// ==============================================
// ROUTES DASHBOARD
// ==============================================
router.get("/dashboard/stats", adminController.getDashboardStats);

// ==============================================
// ROUTES QUẢN LÝ NGƯỜI DÙNG
// ==============================================
// Lấy danh sách users (hỗ trợ query ?page=1&limit=10&search=abc)
router.get("/users", adminController.getUsers);

// Lấy 4 bảng Leaderboard
router.get("/users/leaderboards", adminController.getLeaderboards);

// Thay đổi trạng thái User (Active/Banned)
router.put("/users/:userId/status", adminController.updateUserStatus);

// GET list
router.get("/feedbacks", adminController.getFeedbacks);

// UPDATE status
router.put("/feedbacks/:id/status", adminController.updateFeedbackStatus);

module.exports = router;