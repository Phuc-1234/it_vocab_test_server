// src/routes/inventory.routes.js
const router = require("express").Router();
const inv = require("../controllers/inventory");
const authMiddleware = require("../middlewares/authMiddleware");

router.get("/", authMiddleware, inv.getInventory);
router.post("/use", authMiddleware, inv.useItem);
router.post("/unequip-skin", authMiddleware, inv.unequipSkin);

module.exports = router;
