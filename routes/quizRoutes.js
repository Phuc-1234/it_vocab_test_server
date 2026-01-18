const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware"); // JWT required :contentReference[oaicite:2]{index=2}
const optionalAuth = require("../middlewares/optionalAuth");
const c = require("../controllers/quiz");

// Lấy danh sách quiz theo từng topic (pagination)
router.get("/quizzes/topics", c.quizzesByTopicsPaginated);

// Start quiz: user (JWT) hoặc guest (x-guest-key)
router.post("/quiz-attempts", optionalAuth, c.start);

// Resume attempt: user/guest
router.get("/quiz-attempts/:attemptId", optionalAuth, c.getAttempt);

// Next batch: chỉ user + INFINITE
router.post("/quiz-attempts/:attemptId/next-batch", authMiddleware, c.nextBatch);

// Update answer: user/guest (ownership check trong controller)
router.put("/attempt-answers/:attemptAnswerId", optionalAuth, c.updateAnswer);

// Finish: user/guest (user => update SR + XP, guest => chỉ tổng kết)
router.post("/quiz-attempts/:attemptId/finish", optionalAuth, c.finish);

// History: user only
router.get("/quiz-attempts", authMiddleware, c.history);

// Review
router.get("/quiz-attempts/:attemptId/review", optionalAuth, c.review);

// Abandon: user/guest
router.post("/quiz-attempts/:attemptId/abandon", optionalAuth, c.abandon);

module.exports = router;
