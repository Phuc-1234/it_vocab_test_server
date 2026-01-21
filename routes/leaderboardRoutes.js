const express = require("express");
const router = express.Router();

const c = require("../controllers/leaderboard");

router.get("/:tab/:userId", c.getLeaderboard);
module.exports = router;
 