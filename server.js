const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Middleware
app.use(cors());
app.use(express.json());

// Mock database (in-memory for demo)
const users = [];
const lists = [];
const campaigns = [];

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'Backend is running!' });
});

// ============ AUTH ROUTES ============
app.post('/auth/register', async (req, res) => {
  const { email, password, company } = req.body;
  
  if (!email || !password || !company) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  
  const hashedPassword = await bcrypt.hash(password, 10);
  users.push({ id: users.length + 1, email, password: hashedPassword, company });
  
  res.json({ message: 'User registered' });
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  
  const user = users.find(u => u.email === email);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  const token = jwt.sign({ id: user.id, email }, JWT_SECRET);
  res.json({ token, user: { id: user.id, email, company: user.company } });
});

// ============ DASHBOARD ============
app.get('/api/dashboard', (req, res) => {
  res.json({
    totalLists: lists.length,
    totalContacts: 0,
    totalCampaigns: campaigns.length,
    emailsSent: 0,
    openRate: 0
  });
});

// ============ LISTS ============
app.get('/api/lists', (req, res) => {
  res.json(lists);
});

app.post('/api/lists/upload', (req, res) => {
  const { listName } = req.body;
  const newList = {
    id: lists.length + 1,
    name: listName,
    status: 'completed',
    total_emails: 100,
    valid_emails: 95,
    invalid_emails: 5
  };
  lists.push(newList);
  res.json({ listId: newList.id, message: 'List uploaded' });
});

// ============ SENDER CONFIG ============
app.get('/api/sender-config', (req, res) => {
  res.json({
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
    smtpUser: '',
    smtpPassword: '',
    fromEmail: '',
    fromName: ''
  });
});

app.post('/api/sender-config', (req, res) => {
  res.json({ message: 'Config saved' });
});

// ============ CAMPAIGNS ============
app.get('/api/campaigns', (req, res) => {
  res.json(campaigns);
});

app.post('/api/campaigns', (req, res) => {
  const { name, subject, htmlContent, listId, fromEmail, fromName } = req.body;
  const newCampaign = {
    id: campaigns.length + 1,
    name,
    subject,
    status: 'draft',
    total_sent: 0,
    opened: 0,
    clicked: 0
  };
  campaigns.push(newCampaign);
  res.json({ campaignId: newCampaign.id });
});

app.post('/api/campaigns/:id/send', (req, res) => {
  res.json({ message: 'Campaign sent', sentCount: 95 });
});

app.get('/api/campaigns/:id/analytics', (req, res) => {
  res.json({
    sent: 100,
    opened: 45,
    clicked: 12,
    bounced: 2
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});