require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const authRoutes = require("./routes/authRoutes")
const quizRoutes = require("./routes/quizRoutes")
const topicRoutes = require("./routes/topicRoutes")
const profileRoutes = require("./routes/profileRoutes")
const dictionaryRoutes = require("./routes/dictionaryRoutes")
const feedbackRoutes = require("./routes/feedbackRoutes")
const itemRoutes = require("./routes/itemRoutes")
const rewardRoutes = require("./routes/rewardRoutes")
const inventoryRoutes = require("./routes/inventoryRoutes")
const leaderboardRoutes = require("./routes/leaderboardRoutes")
const app = express();
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'IT Vocab Test Api',
      version: '1.0.0',
      description: 'Ok',
    },
    servers: [
      {
        url: 'http://localhost:5000',
      },
    ],
  },
  // Path to the API docs (where you will write your comments)
  apis: ['./routes/*.js'],
};
app.use(cors());
const swaggerDocs = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

app.use(express.json()); // Allows parsing of JSON bodies

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch(err => console.error('Connection error:', err));


// Use the routes
app.use('/auth', authRoutes);
app.use('/quiz', quizRoutes);
app.use('/topic', topicRoutes);
app.use('/profile', profileRoutes);
app.use('/dictionary', dictionaryRoutes);
app.use('/feedback', feedbackRoutes);
app.use('/item', itemRoutes);
app.use('/reward', rewardRoutes);
app.use('/inventory', inventoryRoutes);
app.use('/leaderboard', leaderboardRoutes);


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));