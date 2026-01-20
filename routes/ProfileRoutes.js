// src/routes/profile.routes.js
const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const upload = require("../middlewares/upload");

const profileController = require("../controllers/profile");

router.get("/", authMiddleware, profileController.getProfile);
router.put("/", authMiddleware, profileController.updateProfile);
router.put("/avatar", authMiddleware, upload.single("file"), profileController.updateAvatar);

module.exports = router;
