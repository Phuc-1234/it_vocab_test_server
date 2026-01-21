const User = require("../models/User");
const { getSkinInfo } = require("./profile");

module.exports = {
  async getLeaderboard(req, res) {
    try {
      const { tab, userId } = req.params;
      let userListRaw = [];
      let myPosition = null;

      // 1. Define the Date Threshold (Start of TODAY)
      // Reset hours to midnight to compare only the date part
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      // --- CASE A: XP LEADERBOARD ---
      if (tab === "xp") {
        userListRaw = await User.find()
          .sort({ currentXP: -1 })
          .limit(10)
          .lean();

        const me = await User.findById(userId).lean();
        if (me) {
          const myRank = await User.countDocuments({
            currentXP: { $gt: me.currentXP },
          });
          myPosition = myRank + 1;
        }
      }

      // --- CASE B: STREAK LEADERBOARD ---
      else if (tab === "streak") {
        // Filter: Only users who have studied TODAY
        const streakFilter = { lastStudyDate: { $gte: todayStart } };

        userListRaw = await User.find(streakFilter)
          .sort({ currentStreak: -1 })
          .limit(10)
          .lean();

        // Check if current user studied today
        const me = await User.findById(userId).lean();
        
        // If user hasn't studied today OR not found, position is null
        if (me && me.lastStudyDate && new Date(me.lastStudyDate) >= todayStart) {
          const myRank = await User.countDocuments({
            ...streakFilter,
            currentStreak: { $gt: me.currentStreak },
          });
          myPosition = myRank + 1;
        } else {
          myPosition = null; 
        }
      } else {
        return res.status(400).json({ message: "Invalid tab parameter" });
      }

      // 2. Attach Skin Info and Formatting
      const userList = await Promise.all(
        userListRaw.map(async (u, index) => {
          const { activeSkin } = await getSkinInfo(u._id);
          return {
            userID: u._id,
            rank: index + 1,
            value: tab === "xp" ? u.currentXP : u.currentStreak,
            activeSkin: activeSkin,
          };
        }),
      );

      return res.status(200).json({ userList, position: myPosition });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Server Error" });
    }
  },
};