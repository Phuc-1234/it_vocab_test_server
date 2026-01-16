const express = require('express');
const router = express.Router();
const TrashTest = require('../models/TrashTest.js');

/**
 * @openapi
 * /api/trashTest/all:
 *   get:
 *     summary: test đống rác
 *     responses:
 *       200:
 *         description: trần dần
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   _id:
 *                     type: string
 *                   weapon:
 *                     type: string
 *                   owner:
 *                     type: string
 */

router.get('/all', async (req, res) => {
    try {
        const data = await TrashTest.find();
        res.json(data);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;