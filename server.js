require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const trashTestRoutes = require('./routes/trashTestRoutes.js');

const app = express();
app.use(express.json()); // Allows parsing of JSON bodies

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Connected to MongoDB Atlas'))
    .catch(err => console.error('Connection error:', err));

// Use the routes
app.use('/api/trashTest', trashTestRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));