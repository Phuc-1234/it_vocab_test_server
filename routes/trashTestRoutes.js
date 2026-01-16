const express = require('express');
const router = express.Router();
const TrashTest = require('../models/TrashTest.js');


router.get('/all', async (req, res) => {
    try {
        const data = await TrashTest.find();
        res.json({data, ok: "ok"});
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;