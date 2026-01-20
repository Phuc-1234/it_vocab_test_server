// src/routes/auth.routes.js
const express = require("express");
const router = express.Router();

// GỢI Ý: thay dòng trên bằng:
const auth = require("../middlewares/authMiddleware.js");

const c = require("../controllers/auth.js");

router.post("/login", c.login);
router.post("/register", c.register);

router.post("/send-code", c.sendCode);
router.post("/verify-code", c.verifyCode);
router.post("/new-password", c.newPassword);

router.post("/refresh", c.refresh);
router.post("/logout", auth, c.logout);

router.post("/google", c.google);
router.post("/facebook", c.facebook);
router.put("/change-password", auth, c.changePassword);
module.exports = router;
