const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware"); // JWT required
const optionalAuth = require("../middlewares/optionalAuth");

// ✅ đổi sang controller mới (file bạn vừa xuất)
const c = require("../controllers/quiz");

// ========== QUIZZES (list) ==========
/**
 * GET /quiz/quizzes?page=&pageSize=
 */
router.get("/quizzes", c.quizzesByTopicsPaginated);

// ========== ATTEMPTS ==========
/**
 * POST /quiz/attempts
 * Start quiz: user (JWT) hoặc guest (x-guest-key)
 */
router.post("/attempts", optionalAuth, c.start);

/**
 * GET /quiz/attempts/:attemptId/questions/:cursor
 * Get 1 question by cursor (1 câu 1 màn)
 */
router.get("/attempts/:attemptId/questions/:cursor", optionalAuth, c.getQuestionByCursor);

/**
 * POST /quiz/attempts/:attemptId/submit
 * Submit current answer + trả luôn đúng/sai + câu kế tiếp
 * (INFINITE: auto next-batch)
 */
router.post("/attempts/:attemptId/submit", optionalAuth, c.submitAndNext);

/**
 * GET /quiz/attempts/:attemptId?page=&pageSize=
 * Resume attempt: user/guest (paged questions) - compatibility
 */
router.get("/attempts/:attemptId", optionalAuth, c.getAttempt);

/**
 * POST /quiz/attempts/:attemptId/next-batch
 * Next batch: chỉ user + INFINITE (compatibility)
 */
router.post("/attempts/:attemptId/next-batch", authMiddleware, c.nextBatch);

/**
 * POST /quiz/attempts/:attemptId/finish
 * Finish: user/guest
 */
router.post("/attempts/:attemptId/finish", optionalAuth, c.finish);

/**
 * GET /quiz/attempts?mode=&topicId=&from=&to=&page=&pageSize=
 * History: user only
 */
router.get("/attempts", authMiddleware, c.history);

/**
 * GET /quiz/attempts/:attemptId/review
 * Review: user/guest
 */
router.get("/attempts/:attemptId/review", optionalAuth, c.review);

/**
 * POST /quiz/attempts/:attemptId/abandon
 * Abandon: user/guest
 */
router.post("/attempts/:attemptId/abandon", optionalAuth, c.abandon);

// ========== ANSWERS ==========
/**
 * PUT /quiz/attempt-answers/:attemptAnswerId
 * Update answer: user/guest (ownership check trong controller)
 */
router.put("/attempt-answers/:attemptAnswerId", optionalAuth, c.updateAnswer);

module.exports = router;
