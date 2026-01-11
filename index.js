const express = require('express');
const cors = require('cors');
require('dotenv').config();
const app = express();
const helmet = require('helmet');
const port = process.env.PORT || 5000;

app.use(helmet({
  contentSecurityPolicy: false,
}));
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)



// Middlewares
// CORS Configuration
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'https://loanlink-bd.netlify.app',
  process.env.CLIENT_URL,
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin 
    if (!origin) return callback(null, true);

    // Allow if origin is in allowedOrigins
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Allow all Vercel preview deployments (*.vercel.app)
    if (origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());


// MongoDB Connection
const uri = process.env.MongoURI;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

// Global variables for collections
let database, usersCollection, loansCollection, applicationsCollection, paymentsCollection, notificationsCollection;

// Connection function with caching for serverless
async function connectDB() {
  if (!database) {
    try {
      await client.connect();
      database = client.db("LoanLinkDB");
      usersCollection = database.collection("users");
      loansCollection = database.collection("loans");
      applicationsCollection = database.collection("applications");
      paymentsCollection = database.collection("payments");
      notificationsCollection = database.collection("notifications");
      console.log("Successfully connected to MongoDB!");
    } catch (error) {
      console.error("MongoDB connection error:", error);
      throw error;
    }
  }
  return { database, usersCollection, loansCollection, applicationsCollection, paymentsCollection, notificationsCollection };
}

// Initialize connection
connectDB();

// Middleware to ensure DB connection
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error('Database connection error:', error);
    res.status(500).send({ message: 'Database connection failed' });
  }
});


// Auth Related APIs
app.post('/jwt', async (req, res) => {
  const user = req.body;
  const token = jwt.sign(user, process.env.JWT_SECRET, {
    expiresIn: '7d' // 7 days instead of 1 hour
  });

  // Detect if we're in production (Vercel)
  const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';

  const cookieOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
    path: '/'
  };

  // console.log('Setting cookie with options:', cookieOptions);

  res.cookie('token', token, cookieOptions)
    .send({ success: true, token });
});

// Logout API
app.post('/logout', (req, res) => {
  const user = req.body;
  // console.log("logging out", user);

  // Detect if we're in production (Vercel)
  const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';

  const cookieOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/'
  };

  res.clearCookie('token', cookieOptions).send({ success: true });
});

// Verify JWT Middleware
const verifyJWT = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) {
    return res.status(401).send({ message: 'Unauthorized access' });
  }
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).send({ message: 'Unauthorized access' });
    }
    req.user = decoded;
    next();
  });
};

// User Related APIs
// Create a user 
app.post('/users', async (req, res) => {
  const user = req.body;
  const query = { email: user.email };
  const existingUser = await usersCollection.findOne(query);
  if (existingUser) {
    return res.send({ message: 'User already exists' });
  }
  const result = await usersCollection.insertOne(user);
  res.send(result);
});

// Get all users (Admin only)
app.get('/users', verifyJWT, async (req, res) => {
  const query = {};
  const users = await usersCollection.find(query).toArray();
  res.send(users);
});

// Get a single user by email for role verification
app.get('/user/:email', async (req, res) => {
  const email = req.params.email;
  const query = { email: email };
  const result = await usersCollection.findOne(query);
  res.send(result || null);
});

// Update User (Role/Status) - Admin only
app.patch('/users/:id', verifyJWT, async (req, res) => {
  const id = req.params.id;
  const updates = req.body;
  const filter = { _id: new ObjectId(id) };
  const updatedDoc = { $set: updates };
  const result = await usersCollection.updateOne(filter, updatedDoc);
  res.send(result);
});

// Delete User API
app.delete('/users/:id', verifyJWT, async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await usersCollection.deleteOne(query);
  res.send(result);
});

//Loan Related APIs
// Get All Loans (With Search, Filter & Sort)
app.get('/all-loans', async (req, res) => {
  const search = req.query.search;
  const category = req.query.category;
  const sort = req.query.sort;
  const limit = parseInt(req.query.limit) || 0;

  let query = {};

  // Search Logic
  if (search) {
    query.$or = [
      { title: { $regex: search, $options: 'i' } },
      { category: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } }
    ];
  }

  // Filter Logic
  if (category && category !== 'All') {
    query.category = category;
  }

  // Sort Options
  let sortOptions = { createdAt: -1 };
  if (sort === 'asc') sortOptions = { interestRate: 1 };
  if (sort === 'desc') sortOptions = { interestRate: -1 };

  const result = await loansCollection.find(query).limit(limit).sort(sortOptions).toArray();
  res.send(result);
});

//  Get Single Loan Details (View Details)
app.get('/loans/:id', verifyJWT, async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await loansCollection.findOne(query);
  res.send(result);
});

// Create Loan (Manager)
app.post('/loans', verifyJWT, async (req, res) => {
  const loan = req.body;
  const result = await loansCollection.insertOne(loan);

  // Broadcast Notification to ALL users
  if (result.insertedId) {
    try {
      const allUsers = await usersCollection.find({}, { projection: { email: 1 } }).toArray();
      if (allUsers.length > 0) {
        const notifications = allUsers.map(u => ({
          userEmail: u.email,
          message: `New Loan Available: ${loan.title || 'Check it out!'}`,
          type: 'info',
          path: `/loans/${result.insertedId}`, // Direct link to details
          timestamp: new Date(),
          read: false
        }));
        await notificationsCollection.insertMany(notifications);
      }
    } catch (error) {
      console.error("Failed to broadcast notifications:", error);
    }
  }

  res.send(result);
});

//  Get Loans Added by specific Manager (My Added Loans)
app.get('/my-added-loans/:email', verifyJWT, async (req, res) => {
  const email = req.params.email;
  const query = { addedBy: email };
  const result = await loansCollection.find(query).toArray();
  res.send(result);
});

// Update Loan (Admin/Manager)
app.patch('/loans/:id', verifyJWT, async (req, res) => {
  const id = req.params.id;
  const updates = req.body;
  const filter = { _id: new ObjectId(id) };
  const updatedDoc = { $set: updates };
  const result = await loansCollection.updateOne(filter, updatedDoc);
  res.send(result);
});

// Delete Loan (Admin)
app.delete('/loans/:id', verifyJWT, async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await loansCollection.deleteOne(query);
  res.send(result);
});

// Application Related APIs
// Get All Applications (Admin/Manager with filter)
app.get('/applications', verifyJWT, async (req, res) => {
  const status = req.query.status;
  const query = status ? { status } : {};
  const result = await applicationsCollection.find(query).toArray();
  res.send(result);
});

// Update Application Status & Notify User
app.patch('/applications/:id', verifyJWT, async (req, res) => {
  const id = req.params.id;
  const updates = req.body;
  const filter = { _id: new ObjectId(id) };
  const updatedDoc = { $set: updates };
  const result = await applicationsCollection.updateOne(filter, updatedDoc);

  // Send Notification if status changed
  if (result.modifiedCount > 0 && updates.status) {
    // Find application to get user email
    const application = await applicationsCollection.findOne(filter);
    if (application) {
      const notification = {
        userEmail: application.userEmail,
        message: `Your loan application for ${application.loanTitle} has been ${updates.status}.`,
        type: updates.status === 'approved' ? 'success' : 'error',
        timestamp: new Date(),
        read: false
      };
      await notificationsCollection.insertOne(notification);
    }
  }

  res.send(result);
});

// Get User's Loan Applications
app.get('/my-applications/:email', verifyJWT, async (req, res) => {
  const email = req.params.email;
  const query = { userEmail: email };
  const result = await applicationsCollection.find(query).toArray();
  res.send(result);
});

// Create Loan Application
app.post('/applications', verifyJWT, async (req, res) => {
  const application = req.body;
  const result = await applicationsCollection.insertOne(application);
  res.send(result);
});

// Cancel/Delete Application
app.delete('/applications/:id', verifyJWT, async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await applicationsCollection.deleteOne(query);
  res.send(result);
});


// Payment Related APIs

app.post('/create-checkout-session', verifyJWT, async (req, res) => {
  const { loanId, loanTitle, loanAmount, loanCategory, loanImage, userName, userEmail } = req.body;
  const amount = 10; // Fixed amount of $10

  const priceInCents = amount * 100;

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Application Fee: ${loanTitle}`,
            description: `Applicant: ${userName} | Loan Amount: ${loanAmount} | Category: ${loanCategory}`,
            images: loanImage ? [loanImage] : [],
          },
          unit_amount: priceInCents,
        },
        quantity: 1,
      },
    ],
    mode: 'payment',
    success_url: `${process.env.CLIENT_URL}/dashboard/payment/success?session_id={CHECKOUT_SESSION_ID}&loanId=${loanId}`,
    cancel_url: `${process.env.CLIENT_URL}/dashboard/my-loans`,
    customer_email: userEmail,
    metadata: {
      loanId: loanId,
      userName: userName,
      amount: amount
    }
  });

  res.send({ url: session.url });
});

// 2. Payment Success & Status Update API

app.patch('/payments/success/:loanId', verifyJWT, async (req, res) => {
  const loanId = req.params.loanId;
  const { transactionId } = req.body;

  const filter = { _id: new ObjectId(loanId) };
  const updateDoc = {
    $set: {
      feeStatus: 'paid',
      transactionId: transactionId,
      paidAt: new Date()
    }
  };
  const result = await applicationsCollection.updateOne(filter, updateDoc);
  res.send(result);
});


// Get notifications for a specific user
app.get('/notifications/:email', verifyJWT, async (req, res) => {
  const email = req.params.email;
  const query = { userEmail: email };
  const result = await notificationsCollection.find(query).sort({ timestamp: -1 }).toArray();
  res.send(result);
});

// Mark single notification as read
app.patch('/notifications/mark-read/:id', verifyJWT, async (req, res) => {
  const id = req.params.id;
  const filter = { _id: new ObjectId(id) };
  const updateDoc = {
    $set: { read: true }
  };
  const result = await notificationsCollection.updateOne(filter, updateDoc);
  res.send(result);
});

// Mark ALL notifications as read for a user
app.patch('/notifications/mark-all-read/:email', verifyJWT, async (req, res) => {
  const email = req.params.email;
  const filter = { userEmail: email, read: false };
  const updateDoc = {
    $set: { read: true }
  };
  const result = await notificationsCollection.updateMany(filter, updateDoc);
  res.send(result);
});

// Delete a notification
app.delete('/notifications/:id', verifyJWT, async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await notificationsCollection.deleteOne(query);
  res.send(result);
});








// Debug endpoint to check environment
app.get('/debug', (req, res) => {
  res.json({
    NODE_ENV: process.env.NODE_ENV,
    VERCEL: process.env.VERCEL,
    isProduction: process.env.NODE_ENV === 'production' || process.env.VERCEL === '1',
    cookieSettings: {
      secure: process.env.NODE_ENV === 'production' || process.env.VERCEL === '1',
      sameSite: (process.env.NODE_ENV === 'production' || process.env.VERCEL === '1') ? 'none' : 'lax'
    }
  });
});

// Routes
app.get('/', (req, res) => {
  res.send('LoanLink Server is Running');
});

// Start server only in local development (not on Vercel)
if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`LoanLink is running on port: ${port}`);
  });
}

// Export for Vercel serverless
module.exports = app;

