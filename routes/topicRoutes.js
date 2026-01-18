const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware"); // JWT required
const c = require("../controllers/topic");

// Create topic
router.post("/topics", authMiddleware, c.create);

// List topics (pagination + filter)
router.get("/topics", c.list);

// Topic detail
router.get("/topics/:topicId", c.detail);

// Update topic (không sửa isActive)
router.put("/topics/:topicId", authMiddleware, c.update);

// Soft delete topic
router.delete("/topics/:topicId", authMiddleware, c.remove);

// Restore topic
router.put("/topics/:topicId/restore", authMiddleware, c.restore);

// ✅ Quizzes by topic (Web 1..maxLevel)
router.get("/topics/:topicId/quizzes", c.quizzes);

module.exports = router;
