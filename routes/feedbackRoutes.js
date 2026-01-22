const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const authorizeRoles = require("../middlewares/roleMiddleware");
const feedbackController = require("../controllers/feedback");

// ADMIN
router.get("/admin", authMiddleware, authorizeRoles("ADMIN"), feedbackController.adminListFeedback);
router.delete("/admin", authMiddleware, authorizeRoles("ADMIN"), feedbackController.adminDeleteAll);

// USER
router.get("/my", authMiddleware, feedbackController.getMyFeedback);
router.post("/", authMiddleware, feedbackController.createFeedback);

// chung: admin/user đều gọi được, controller tự kiểm tra quyền theo role + owner
router.put("/:feedbackId", authMiddleware, feedbackController.updateFeedback);
router.delete("/:feedbackId", authMiddleware, feedbackController.deleteFeedback);

module.exports = router;
