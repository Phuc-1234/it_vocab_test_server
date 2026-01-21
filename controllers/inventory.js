const Inventory = require("../models/Inventory");
const Item = require("../models/Item");

/**
 * Validates and updates the state of a specific inventory record.
 */
async function validateInventory(inventoryRecord) {
    const now = new Date();
    
    // 1) if itemId không tồn tại, return false
    if (!inventoryRecord.itemId) return false;

    // 2) if expiredAt < date thì quantity--, expiredAt = null, isActive = false
    if (inventoryRecord.expiredAt && inventoryRecord.expiredAt < now) {
        inventoryRecord.quantity -= 1;
        inventoryRecord.expiredAt = null;
        inventoryRecord.isActive = false;
        // Save the update to DB
        await inventoryRecord.save();
    }

    // 3) if quantity <= 0 return false
    if (inventoryRecord.quantity <= 0) return false;

    // 4) check đã đang kích hoạt rồi (If isActive && có DurationValue)
    // Note: We check the populated itemId for duration data
    if (inventoryRecord.isActive && inventoryRecord.itemId.durationValue > 0) {
        // According to requirement: return false if already active with duration

        return false; 
    }

    return true;
}

module.exports = {
    async getInventory(req, res) {
        try {
            // Using userId from auth middleware (standardized to req.userId)
            const userId = req.userId || req.Id;

            // Lấy { inventoryList: [ inventory ] } raw
            const rawInventory = await Inventory.find({ userId })
                .populate("itemId") // Populate to get Item details for validation
                .exec();

            // Gọi validateInventory() lên từng cái, false thì filter bỏ
            const validatedList = [];
            
            for (let item of rawInventory) {
                const isValid = await validateInventory(item);
                if (isValid) {
                    validatedList.push(item);
                }
            }

            // response: { inventoryList: [ inventory ] }
            return res.status(200).json({
                inventoryList: validatedList
            });

        } catch (error) {
            console.error("Inventory Error:", error);
            return res.status(500).json({ message: "Internal Server Error" });
        }
    }
};