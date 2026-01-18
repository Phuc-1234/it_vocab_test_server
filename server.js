require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const authRoutes = require("./routes/authRoutes")
const quizRoutes = require("./routes/quizRoutes")
const topicRoutes = require("./routes/topicRoutes")
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));