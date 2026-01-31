require('dotenv').config();
const express = require('express');
const { sendRateLimitAlert } = require('./services/mail');


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
const rateLimit = require('express-rate-limit');


app.set('trust proxy', 1); // để rate-limit bỏ qua proxy của render, nhìn ip của người dùng

// Track rate limit alerts to prevent spam (one alert per IP per time window)
const rateLimitAlerts = new Map();


const recipientEmail = 'vdp.hh.1234@gmail.com, lieuthienhao2006@gmail.com';
const sendRateLimitEmailAlert = async (ip, limiterType, windowMs, maxRequests) => {
    const now = Date.now();
    const alertKey = `${ip}-${limiterType}`;
    const lastAlert = rateLimitAlerts.get(alertKey) || 0;
    
    // Only send email once per 15' per IP per limiter type to avoid spam
    if (now - lastAlert > 15 * 60 * 1000) {
        rateLimitAlerts.set(alertKey, now);



        try {
            await sendRateLimitAlert(
                recipientEmail,
                ip,
                limiterType,
                windowMs,
                maxRequests
            );
            console.log(`[Rate Limit Alert] Email sent for IP: ${ip} (${limiterType})`);
        } catch (err) {
            console.error(`[Rate Limit Alert] Failed to send email for IP ${ip}:`, err.message);
        }
    }
};

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

const authLimiterDurationMinutes = 5;
const authLimiterMaxRequests = 50;

const generalLimiterDurationMinutes = 5;
const generalLimiterMaxRequests = 400;



const generalLimiter = rateLimit({
  windowMs: generalLimiterDurationMinutes * 60 * 1000, // 5 minutes
  max: generalLimiterMaxRequests, 
  message: { message: "Quá nhiều yêu cầu, vui lòng thử lại sau 5 phút." },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    sendRateLimitEmailAlert(req.ip, 'General Limiter', generalLimiterDurationMinutes * 60 * 1000, generalLimiterMaxRequests);
    res.status(429).json({ message: "Quá nhiều yêu cầu, vui lòng thử lại sau 5 phút." });
  },
});


const authLimiter = rateLimit({
  windowMs: authLimiterDurationMinutes * 60 * 1000, // 5'
  max: authLimiterMaxRequests, 
  message: { message: "Thử đăng nhập quá nhiều lần. Tài khoản tạm khóa 5 phut nha." },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    sendRateLimitEmailAlert(req.ip, 'Auth Limiter', authLimiterDurationMinutes * 60 * 1000, authLimiterMaxRequests);
    res.status(429).json({ message: "Thử đăng nhập quá nhiều lần. Tài khoản tạm khóa 5 phut nha." });
  },
});

app.use(cors());
const swaggerDocs = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

app.use(express.json()); // Allows parsing of JSON bodies

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch(err => console.error('Connection error:', err));

// rate limit
app.use(generalLimiter);


// Use the routes
app.use('/auth', authLimiter, authRoutes);
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