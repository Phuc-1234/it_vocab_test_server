// src/controllers/inventory.controller.js
const mongoose = require("mongoose");

const Inventory = require("../models/Inventory"); // Inventory.model.js
const Item = require("../models/Item"); // Item.js
const UserEffect = require("../models/UserEffect"); // UserEffect.model.js
const UserEquipped = require("../models/UserEquipped"); // UserEquipped.model.js

const DEFAULT_LIMIT = 15;
const SKIN_SLOT = "SKIN"; // đổi nếu bạn muốn: "AVATAR_FRAME"

function isValidObjectId(id) {
    return mongoose.Types.ObjectId.isValid(String(id));
}

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + Number(days || 0));
    return d;
}

/**
 * Decide if an effect is active "now"
 * - isActive true
 * - endAt null OR endAt > now
 */
function isEffectCurrentlyActive(effect) {
    if (!effect) return false;
    if (!effect.isActive) return false;
    if (!effect.endAt) return true;
    return new Date(effect.endAt).getTime() > Date.now();
}

module.exports = {
    /**
     * GET /inventory?page=1&limit=15
     * Return inventory list with pagination + "isActive" status per item.
     */
    async getInventory(req, res) {
        try {
            const userId = req.user?.userId;
            if (!isValidObjectId(userId)) {
                return res.status(401).json({ message: "Vui lòng đăng nhập." });
            }

            const page = Math.max(1, Number(req.query.page || 1));
            const limit = Math.max(1, Number(req.query.limit || DEFAULT_LIMIT));
            const skip = (page - 1) * limit;

            // 1) equipped skin
            const equippedSkin = await UserEquipped.findOne({ userId, slotType: SKIN_SLOT }).lean();
            const equippedItemId = equippedSkin?.itemId ? String(equippedSkin.itemId) : null;

            // 2) inventory rows + total
            const [total, rows] = await Promise.all([
                Inventory.countDocuments({ userId }),
                Inventory.find({ userId })
                    .sort({ updatedAt: -1, createdAt: -1 })
                    .skip(skip)
                    .limit(limit)
                    .populate("itemId")
                    .lean(),
            ]);

            // 3) effects for consumables on this page
            const itemIds = rows
                .map((x) => x.itemId?._id)
                .filter(Boolean)
                .map((id) => String(id));

            const effects = await UserEffect.find({
                userId,
                sourceItemId: { $in: itemIds },
                isActive: true,
            }).lean();

            const effectByItemId = new Map();
            for (const ef of effects) {
                const key = String(ef.sourceItemId);
                const prev = effectByItemId.get(key);
                if (!prev) effectByItemId.set(key, ef);
                else {
                    const prevEnd = prev.endAt ? new Date(prev.endAt).getTime() : Infinity;
                    const curEnd = ef.endAt ? new Date(ef.endAt).getTime() : Infinity;
                    if (curEnd > prevEnd) effectByItemId.set(key, ef);
                }
            }

            // 4) Build minimal payload for UI
            const items = rows.map((inv) => {
                const item = inv.itemId || null;
                const itemId = item?._id ? String(item._id) : null;

                let isActive = false;
                let active = null;

                if (item?.itemType === "SKIN") {
                    isActive = !!(itemId && equippedItemId && itemId === equippedItemId);
                    if (isActive) {
                        active = {
                            slotType: SKIN_SLOT,
                            equippedAt: equippedSkin?.equippedAt || null,
                        };
                    }
                }

                if (item?.itemType === "CONSUMABLE") {
                    const ef = itemId ? effectByItemId.get(itemId) : null;
                    isActive = isEffectCurrentlyActive(ef);
                    if (isActive) {
                        active = {
                            endAt: ef?.endAt || null,
                            startAt: ef?.startAt || null,
                        };
                    }
                }

                return {
                    itemId,
                    itemName: item?.itemName ?? null,
                    itemImageURL: item?.itemImageURL ?? null,
                    itemType: item?.itemType ?? null,

                    // badge số lượng trên grid
                    quantity: Number(inv.quantity || 0),

                    // dấu tick xanh
                    isActive,

                    // để FE show detail (duration/effect)
                    durationType: item?.durationType ?? null,
                    durationValue: item?.durationValue ?? null,
                    effectType: item?.effectType ?? null,
                    effectValue: item?.effectValue ?? null,

                    // chỉ có khi active
                    active,
                };
            });

            const totalPages = Math.max(1, Math.ceil(total / limit));

            return res.json({
                message: "Lấy inventory thành công.",
                items,
                pagination: { page, limit, total, totalPages },
                // nếu FE cần highlight skin đang equip
                equippedSkinItemId: equippedItemId,
                serverTime: new Date().toISOString(), // optional: giúp FE tính remaining time chuẩn
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },


    /**
     * POST /inventory/use
     * body: { itemId: string }
     *
     * - If CONSUMABLE:
     *   - decrement inventory quantity by 1
     *   - upsert UserEffect:
     *       - if existing active effect => extend endAt by durationValue days
     *       - else create new effect with endAt = now + durationValue days (or null if PERMANENT)
     *
     * - If SKIN:
     *   - upsert UserEquipped for slotType SKIN_SLOT (equip)
     */
    async useItem(req, res) {
        const session = await mongoose.startSession();

        try {
            const userId = req.user?.userId;
            const { itemId } = req.body || {};

            if (!isValidObjectId(userId)) {
                return res.status(401).json({ message: "Vui lòng đăng nhập." });
            }
            if (!isValidObjectId(itemId)) {
                return res.status(400).json({ message: "itemId không hợp lệ." });
            }

            session.startTransaction();

            // must own it in inventory (for both SKIN/CONSUMABLE)
            const inv = await Inventory.findOne({ userId, itemId }).session(session);
            if (!inv) {
                await session.abortTransaction();
                return res.status(400).json({ message: "Bạn không có item này trong kho." });
            }

            const item = await Item.findById(itemId).session(session).lean();
            if (!item) {
                await session.abortTransaction();
                return res.status(404).json({ message: "Item không tồn tại." });
            }

            const now = new Date();

            // ===== SKIN: equip (KHÔNG trừ quantity) =====
            if (item.itemType === "SKIN") {
                // nếu bạn muốn vẫn bắt quantity>0 cho skin thì bật đoạn này:
                // if (Number(inv.quantity || 0) <= 0) {
                //   await session.abortTransaction();
                //   return res.status(400).json({ message: "Số lượng không đủ." });
                // }

                const equipped = await UserEquipped.findOneAndUpdate(
                    { userId, slotType: SKIN_SLOT },
                    { $set: { itemId, slotType: SKIN_SLOT, userId, equippedAt: now } },
                    { upsert: true, new: true, session }
                ).lean();

                await session.commitTransaction();
                return res.json({
                    message: "Đã sử dụng skin (equip) thành công.",
                    result: {
                        type: "SKIN",
                        equipped: {
                            userEquippedId: equipped?._id,
                            slotType: SKIN_SLOT,
                            itemId: String(itemId),
                            equippedAt: equipped?.equippedAt || null,
                        },
                        inventory: { itemId: String(itemId), quantity: Number(inv.quantity || 0) },
                    },
                });
            }

            // ===== CONSUMABLE: apply/extend effect =====
            if (item.itemType === "CONSUMABLE") {
                const durationType = item.durationType ?? null; // PERMANENT | DAYS | null
                const durationValue = Number(item.durationValue || 0);

                const isPermanent = durationType === "PERMANENT" || durationType === null;
                const isDays = durationType === "DAYS";

                // ✅ Chỉ yêu cầu quantity>0 nếu là DAYS (vì dùng là tiêu hao)
                if (isDays && Number(inv.quantity || 0) <= 0) {
                    await session.abortTransaction();
                    return res.status(400).json({ message: "Bạn không có item này hoặc số lượng không đủ." });
                }

                // ===== quantity handling =====
                // ✅ DAYS: trừ 1
                // ✅ PERMANENT/null: không trừ
                if (isDays) {
                    inv.quantity = Math.max(0, Number(inv.quantity || 0) - 1);
                    await inv.save({ session });
                }

                // find existing active effect for this item
                const existing = await UserEffect.findOne({
                    userId,
                    sourceItemId: itemId,
                    isActive: true,
                })
                    .sort({ createdAt: -1 })
                    .session(session);

                let nextStartAt = now;
                let nextEndAt = null;

                if (isDays) {
                    // stacking: nếu existing đang active và có endAt ở tương lai => extend từ endAt
                    // else extend từ now
                    const base =
                        existing && isEffectCurrentlyActive(existing) && existing.endAt
                            ? new Date(existing.endAt)
                            : now;

                    nextEndAt = addDays(base, durationValue);
                } else {
                    // PERMANENT / null => endAt null
                    nextEndAt = null;
                }

                let savedEffect = null;

                if (existing && isEffectCurrentlyActive(existing)) {
                    const update = {
                        startAt: existing.startAt || nextStartAt,
                        endAt: nextEndAt,
                        isActive: true,
                        effectType: item.effectType,
                        effectValue: item.effectValue ?? null,
                    };

                    savedEffect = await UserEffect.findByIdAndUpdate(existing._id, update, {
                        new: true,
                        session,
                    }).lean();
                } else {
                    // nếu có record cũ nhưng hết hạn, mark inactive (cleanup)
                    if (existing && !isEffectCurrentlyActive(existing)) {
                        await UserEffect.findByIdAndUpdate(
                            existing._id,
                            { $set: { isActive: false } },
                            { session }
                        );
                    }

                    const doc = await UserEffect.create(
                        [
                            {
                                userId,
                                sourceItemId: itemId,
                                effectType: item.effectType,
                                effectValue: item.effectValue ?? null,
                                startAt: nextStartAt,
                                endAt: nextEndAt,
                                isActive: true,
                            },
                        ],
                        { session }
                    );

                    savedEffect = doc?.[0] ? doc[0].toObject() : null;
                }

                await session.commitTransaction();

                return res.json({
                    message: "Đã sử dụng consumable thành công.",
                    result: {
                        type: "CONSUMABLE",
                        userEffect: savedEffect
                            ? {
                                userEffectId: savedEffect._id,
                                effectType: savedEffect.effectType,
                                effectValue: savedEffect.effectValue,
                                startAt: savedEffect.startAt,
                                endAt: savedEffect.endAt,
                                isActive: savedEffect.isActive,
                            }
                            : null,
                        inventory: { itemId: String(itemId), quantity: Number(inv.quantity || 0) },
                        meta: {
                            durationType,
                            isPermanent,
                            consumed: isDays ? 1 : 0,
                        },
                    },
                });
            }

            await session.abortTransaction();
            return res.status(400).json({ message: "ItemType không hỗ trợ." });
        } catch (e) {
            try {
                await session.abortTransaction();
            } catch { }
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        } finally {
            session.endSession();
        }
    },


    /**
     * POST /inventory/unequip-skin
     * remove currently equipped skin (slotType SKIN_SLOT)
     */
    async unequipSkin(req, res) {
        try {
            const userId = req.user?.userId;
            if (!isValidObjectId(userId)) {
                return res.status(401).json({ message: "Vui lòng đăng nhập." });
            }

            const removed = await UserEquipped.findOneAndDelete({
                userId,
                slotType: SKIN_SLOT,
            }).lean();

            return res.json({
                message: "Đã bỏ sử dụng skin.",
                removed: removed
                    ? {
                        userEquippedId: removed._id,
                        itemId: String(removed.itemId),
                        slotType: removed.slotType,
                    }
                    : null,
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },
};
