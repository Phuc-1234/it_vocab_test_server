const express = require("express");
const router = express.Router();

const dictionaryController = require("../controllers/dictionary");

const authMiddleware = require("../middlewares/authMiddleware"); // theo file bạn upload :contentReference[oaicite:3]{index=3}
const optionalAuth = require("../middlewares/optionalAuth"); // theo file bạn upload :contentReference[oaicite:4]{index=4}

// Words list + filter + include topics (guest OK, login thì trả isPinned/note)
router.get("/words", optionalAuth, dictionaryController.listWords);

// Word detail (guest OK, login thì trả isPinned/note)
router.get("/words/:wordId", optionalAuth, dictionaryController.getWordDetail);

// Pin / Unpin (JWT required)
router.put("/words/:wordId/pin", authMiddleware, dictionaryController.pinWord);
router.delete("/words/:wordId/pin", authMiddleware, dictionaryController.unpinWord);

// Pinned list (JWT required)
router.get("/pinned", authMiddleware, dictionaryController.listPinnedWords);

// Note create/update/delete (JWT required)
router.put("/words/:wordId/note", authMiddleware, dictionaryController.upsertNote);

module.exports = router;
