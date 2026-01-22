const express = require("express");
const router = express.Router();

// Controller
const rewardController = require("../controllers/reward");

// Middlewares
const authMiddleware = require("../middlewares/authMiddleware");
const optionalAuth = require("../middlewares/optionalAuth");

// ==========================================
// ROADMAP ROUTE (Guest xem được, Login thì enrich status)
// ==========================================

/**
 * @route   GET /api/rewards/roadmap
 * @desc    Lấy roadmap rewards (Rank/Streak) + status nếu có token
 * @query   ?type=ALL|RANK|STREAK
 * @query   ?status=ALL|LOCKED|CLAIMABLE|CLAIMED
 * @query   ?page=1&limit=20
 * @access  Public (optional auth)
 */
router.get("/roadmap", optionalAuth, rewardController.getRoadmap);

// (Tuỳ bạn) Nếu muốn giữ endpoint cũ /milestones cho guest (deprecated)
// router.get("/milestones", rewardController.getMilestones);

// ==========================================
// PROTECTED ROUTES (Cần JWT Token)
// ==========================================

/**
 * @route   POST /api/rewards/inbox/:inboxId/claim
 * @desc    Claim reward theo inboxId (chuyển item vào Inventory)
 * @access  Private
 */
router.post("/inbox/:inboxId/claim", authMiddleware, rewardController.claimReward);

module.exports = router;
