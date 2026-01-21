const express = require("express");
const router = express.Router();

const c = require("../controllers/inventory");
const authMiddleware = require("../middlewares/authMiddleware");


router.get("/", authMiddleware, c.getInventory);

module.exports = router;