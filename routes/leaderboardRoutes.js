const express = require("express");
const router = express.Router();

const c = require("../controllers/leaderboard");
const optionalAuth = require("../middlewares/optionalAuth"); // path tuỳ project bạn

// ✅ không cần :userId nữa
router.get("/:tab", optionalAuth, c.getLeaderboard);

module.exports = router;
