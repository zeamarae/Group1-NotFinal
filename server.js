// server.js
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT; // In production, use env var

// Middleware
app.use(cors({ origin: '*', credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files like HTML, images

// HTTP Server
const server = http.createServer(app);

// Socket.io
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

const userSockets = new Map();

// Socket Auth Middleware
io.use((socket, next) => {
  const cookies = socket.handshake.headers.cookie || '';
  const tokenMatch = cookies.match(/authToken=([^;]+)/);
  const token = tokenMatch ? tokenMatch[1] : null;

  if (!token) {
    return next(new Error('Authentication error: No token'));
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return next(new Error('Invalid token'));
    socket.user = user;
    next();
  });
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.user.idNumber);
  userSockets.set(socket.user.id, socket.id);

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.user.idNumber);
    userSockets.delete(socket.user.id);
  });
});

// MongoDB Connection
mongoose.connect(process.env.MONGO_DB, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.log(err));

// Schemas
const studentSchema = new mongoose.Schema({
  idNumber: { type: String, unique: true, required: true },
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  program: { type: String, required: true },
  birthdate: { type: Date, required: true },
  imageUrl: { type: String, default: null }
});

const userSchema = new mongoose.Schema({
  idNumber: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  points: { type: Number, default: 0 },
  memberSince: { type: Date, default: Date.now },
  validUntil: { type: Number, default: 2027 }
});

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  item: { type: String, required: true },
  amount: { type: Number, required: true },
  date: { type: Date, default: Date.now },
  pointsEarned: { type: Number, default: 0 }
});

const Student = mongoose.model('Student', studentSchema);
const User = mongoose.model('User', userSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

// Middleware to verify JWT from cookie
const authenticateToken = (req, res, next) => {
  const token = req.cookies.authToken;
  if (!token) {
    return res.status(401).json({ message: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid token' });
    req.user = user;
    next();
  });
};

// Helper function
function calculateAge(birthdate) {
  const today = new Date();
  let age = today.getFullYear() - birthdate.getFullYear();
  const monthDiff = today.getMonth() - birthdate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthdate.getDate())) {
    age--;
  }
  return age;
}

// Routes

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'public/uploads/profiles';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, req.user.idNumber + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only images allowed'), false);
    }
  }
});

// Add route for upload
app.post('/api/upload-profile-pic', authenticateToken, upload.single('profilePic'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const imageUrl = `/uploads/profiles/${req.file.filename}`;
    const student = await Student.findOneAndUpdate(
      { idNumber: req.user.idNumber },
      { imageUrl },
      { new: true }
    );

    res.json({ message: 'Profile picture updated', imageUrl });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update /api/profile to include imageUrl
app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const student = await Student.findOne({ idNumber: req.user.idNumber });

    res.json({
      idNumber: user.idNumber,
      points: user.points,
      validUntil: user.validUntil,
      firstName: student.firstName,
      lastName: student.lastName,
      program: student.program,
      birthdate: student.birthdate,
      age: calculateAge(student.birthdate),
      imageUrl: student.imageUrl
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Register - Create account
app.post('/api/register', async (req, res) => {
  try {
    const { idNumber, firstName, lastName, program, birthdate, password } = req.body;

    // Validate inputs
    if (!idNumber || !firstName || !lastName || !program || !birthdate || !password) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // Check if user already registered
    const existingUser = await User.findOne({ idNumber });
    if (existingUser) {
      return res.status(400).json({ message: 'Account already exists for this ID' });
    }

    // Check if student already exists (to prevent duplicates)
    const existingStudent = await Student.findOne({ idNumber });
    if (existingStudent) {
      return res.status(400).json({ message: 'Student ID already registered. Contact admin.' });
    }

    // Create student
    const student = new Student({
      idNumber,
      firstName,
      lastName,
      program,
      birthdate: new Date(birthdate)
    });
    await student.save();

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = new User({
      idNumber,
      password: hashedPassword,
    });
    await user.save();

    res.status(201).json({ message: 'Account created successfully' });
  } catch (err) {
    if (err.code === 11000) { // MongoDB duplicate key
      return res.status(400).json({ message: 'Student ID already exists. Contact admin.' });
    }
    res.status(500).json({ message: err.message });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { idNumber, password } = req.body;

    const user = await User.findOne({ idNumber });
    const student = await Student.findOne({ idNumber });

    if (!user || !student) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Check birthday bonus
    const today = new Date();
    const birthDate = new Date(student.birthdate);
    if (today.getMonth() === birthDate.getMonth() && today.getDate() === birthDate.getDate()) {
      user.points += 10;
      await user.save();
    }

    // Generate JWT
    const token = jwt.sign({ id: user._id, idNumber: user.idNumber }, JWT_SECRET, { expiresIn: '1h' });

    // Set httpOnly cookie
    res.cookie('authToken', token, {
      httpOnly: true,
      secure: false, // Set to true in production with HTTPS
      maxAge: 3600000 // 1 hour
    });

    res.json({
      user: {
        idNumber: user.idNumber,
        points: user.points,
        memberSince: user.memberSince,
        firstName: student.firstName,
        lastName: student.lastName,
        program: student.program,
        birthdate: student.birthdate,
        age: calculateAge(student.birthdate),
        validUntil: user.validUntil
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('authToken');
  res.json({ message: 'Logged out successfully' });
});

// Get Profile (protected)
app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const student = await Student.findOne({ idNumber: req.user.idNumber });

    res.json({
      idNumber: user.idNumber,
      points: user.points,
      validUntil: user.validUntil,
      firstName: student.firstName,
      lastName: student.lastName,
      program: student.program,
      birthdate: student.birthdate,
      age: calculateAge(student.birthdate)
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update Profile (protected)
app.put('/api/profile', authenticateToken, async (req, res) => {
  try {
    const { firstName, lastName, program, birthdate } = req.body;
    const student = await Student.findOneAndUpdate(
      { idNumber: req.user.idNumber },
      { firstName, lastName, program, birthdate: new Date(birthdate) },
      { new: true }
    );

    // Emit update to socket if connected
    const socketId = userSockets.get(req.user.id);
    if (socketId) {
      io.to(socketId).emit('profileUpdated', { student });
    }

    res.json({ message: 'Profile updated', student });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get Purchases (protected)
app.get('/api/purchases', authenticateToken, async (req, res) => {
  try {
    const transactions = await Transaction.find({ userId: req.user.id })
      .sort({ date: -1 })
      .limit(10);

    // Calculate monthly total
    const thisMonth = new Date();
    thisMonth.setDate(1);
    const monthly = await Transaction.aggregate([
      { $match: { userId: req.user.id, date: { $gte: thisMonth } } },
      { $group: { _id: null, totalSpent: { $sum: '$amount' }, totalPoints: { $sum: '$pointsEarned' } } }
    ]);

    res.json({
      transactions,
      monthly: monthly[0] || { totalSpent: 0, totalPoints: 0 }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Add Purchase (protected) - For demo; in production, canteen staff endpoint
app.post('/api/purchases', authenticateToken, async (req, res) => {
  try {
    const { item, amount } = req.body;
    const pointsEarned = Math.floor(amount / 50);

    const user = await User.findById(req.user.id);
    user.points += pointsEarned;
    await user.save();

    const transaction = new Transaction({
      userId: req.user.id,
      item,
      amount,
      pointsEarned
    });
    await transaction.save();

    // Emit real-time update
    const socketId = userSockets.get(req.user.id);
    if (socketId) {
      io.to(socketId).emit('purchaseAdded', { 
        transaction: transaction.toObject(), 
        points: user.points 
      });
    }

    res.status(201).json({ message: 'Purchase added', pointsEarned, points: user.points });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Convert Points (protected)
app.post('/api/points/convert', authenticateToken, async (req, res) => {
  try {
    const { pointsRequired, discountAmount } = req.body;

    const user = await User.findById(req.user.id);
    if (user.points < pointsRequired) {
      return res.status(400).json({ message: `Not enough points. Need ${pointsRequired}, have ${user.points}` });
    }

    user.points -= pointsRequired;
    await user.save();

    // Emit real-time update
    const socketId = userSockets.get(req.user.id);
    if (socketId) {
      io.to(socketId).emit('pointsUpdated', { points: user.points });
    }

    // In real app, generate voucher code here
    const voucher = `VCH-${Date.now()}-${discountAmount}`;

    res.json({ message: 'Points converted', voucher, remainingPoints: user.points });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Serve frontend - Protected dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  const token = req.cookies.authToken;
  if (!token) {
    return res.redirect('/');
  }

  jwt.verify(token, JWT_SECRET, (err) => {
    if (err) {
      res.clearCookie('authToken');
      return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'public', 'profile.html'));
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});