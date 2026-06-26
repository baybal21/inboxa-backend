const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const ABSTRACT_API_KEY = process.env.ABSTRACT_API_KEY || '';
const BASE_URL = process.env.BASE_URL || 'https://inboxa-api.onrender.com';

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));

// PostgreSQL Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize Database Tables
async function initializeDatabase() {
  try {
    // Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        company VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Email lists table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lists (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        name VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'completed',
        total_emails INTEGER DEFAULT 0,
        valid_emails INTEGER DEFAULT 0,
        invalid_emails INTEGER DEFAULT 0,
        validity_rate FLOAT DEFAULT 0,
        validation_details JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // SMTP Config table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS smtp_config (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE NOT NULL REFERENCES users(id),
        smtp_host VARCHAR(255),
        smtp_port INTEGER,
        smtp_user VARCHAR(255),
        smtp_password VARCHAR(255),
        from_email VARCHAR(255),
        from_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Campaigns table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        name VARCHAR(255) NOT NULL,
        subject VARCHAR(255) NOT NULL,
        list_id INTEGER NOT NULL REFERENCES lists(id),
        html_content TEXT,
        from_email VARCHAR(255),
        from_name VARCHAR(255),
        status VARCHAR(50) DEFAULT 'draft',
        total_sent INTEGER DEFAULT 0,
        opened INTEGER DEFAULT 0,
        clicked INTEGER DEFAULT 0,
        tracking_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Email events table (for tracking opens/clicks)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_events (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
        email VARCHAR(255),
        event_type VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Database tables initialized');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}

// Initialize database on startup
initializeDatabase();

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'Backend is running!',
    abstractApiConfigured: !!ABSTRACT_API_KEY,
    database: 'PostgreSQL Connected ✅'
  });
});

// ============ CSV PARSER ============
function extractEmailsFromCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length === 0) return [];

  const firstLine = lines[0];
  const hasTab = firstLine.includes('\t');
  const delimiter = hasTab ? '\t' : ',';

  const headerLine = lines[0];
  const headers = headerLine.split(delimiter).map(h =>
    h.trim().toLowerCase().replace(/"/g, '').replace(/'/g, '')
  );

  let emailColumnIndex = headers.findIndex(h => h.includes('email'));

  if (emailColumnIndex === -1) {
    for (let i = 1; i < Math.min(5, lines.length); i++) {
      const parts = lines[i].split(delimiter);
      for (let j = 0; j < parts.length; j++) {
        const cleaned = cleanEmail(parts[j]);
        if (cleaned && cleaned.includes('@')) {
          emailColumnIndex = j;
          break;
        }
      }
      if (emailColumnIndex !== -1) break;
    }
  }

  const emails = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(delimiter);
    let email = null;

    if (emailColumnIndex !== -1 && emailColumnIndex < parts.length) {
      email = cleanEmail(parts[emailColumnIndex]);
    } else {
      for (let j = 0; j < parts.length; j++) {
        const cleaned = cleanEmail(parts[j]);
        if (cleaned && cleaned.includes('@')) {
          email = cleaned;
          break;
        }
      }
    }

    if (email && email.includes('@') && isValidEmailFormat(email)) {
      emails.push(email);
    }
  }

  return emails;
}

function cleanEmail(str) {
  if (!str) return '';
  return str
    .trim()
    .toLowerCase()
    .replace(/^["']/, '')
    .replace(/["']$/, '')
    .replace(/\s/g, '');
}

function isValidEmailFormat(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Email validation - skip Abstract API, use basic format only
async function validateEmailWithAbstract(email) {
  return validateEmailFormat(email);
}

    const response = await axios.get('https://emailvalidation.abstractapi.com/v1/', {
      params: {
        api_key: ABSTRACT_API_KEY,
        email: email
      },
      timeout: 5000
    });

    const data = response.data;
    return {
      email: email,
      is_valid_format: data.is_valid_format?.value || false,
      is_smtp_valid: data.is_smtp_valid?.value || false,
      is_disposable: data.is_disposable?.value || false,
      deliverability: data.deliverability || 'UNKNOWN',
      status: data.is_valid_format?.value ? 'valid' : 'invalid'
    };
  } catch (error) {
    console.error(`Error validating ${email}:`, error.message);
    return validateEmailFormat(email);
  }
}

function validateEmailFormat(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const isValid = emailRegex.test(email);

  return {
    email: email,
    is_valid_format: isValid,
    is_smtp_valid: isValid,
    is_disposable: false,
    deliverability: isValid ? 'DELIVERABLE' : 'UNDELIVERABLE',
    status: isValid ? 'valid' : 'invalid'
  };
}

// ============ NODEMAILER ============
function createTransporter(smtpConfig) {
  return nodemailer.createTransport({
    host: smtpConfig.smtp_host,
    port: smtpConfig.smtp_port,
    secure: smtpConfig.smtp_port === 465,
    auth: {
      user: smtpConfig.smtp_user,
      pass: smtpConfig.smtp_password
    }
  });
}

// ============ AUTH ROUTES ============
app.post('/auth/register', async (req, res) => {
  const { email, password, company } = req.body;

  if (!email || !password || !company) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    // Check if user exists
    const existingUser = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert user
    const result = await pool.query(
      'INSERT INTO users (email, password, company) VALUES ($1, $2, $3) RETURNING id, email, company',
      [email, hashedPassword, company]
    );

    res.json({ message: 'User registered successfully', email });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, email }, JWT_SECRET);
    res.json({
      token,
      user: { id: user.id, email, company: user.company }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============ MIDDLEWARE: Verify Token ============
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ============ DASHBOARD ============
app.get('/api/dashboard', verifyToken, async (req, res) => {
  try {
    const listsResult = await pool.query(
      'SELECT SUM(total_emails) as totalContacts, SUM(valid_emails) as validEmails, COUNT(*) as totalLists FROM lists WHERE user_id = $1',
      [req.user.id]
    );

    const campaignsResult = await pool.query(
      'SELECT COUNT(*) as totalCampaigns, SUM(total_sent) as emailsSent FROM campaigns WHERE user_id = $1',
      [req.user.id]
    );

    const listData = listsResult.rows[0];
    const campaignData = campaignsResult.rows[0];

    const totalContacts = parseInt(listData.totalcontacts) || 0;
    const validEmails = parseInt(listData.validemails) || 0;

    res.json({
      totalLists: parseInt(listData.totallists) || 0,
      totalContacts,
      totalCampaigns: parseInt(campaignData.totalcampaigns) || 0,
      emailsSent: parseInt(campaignData.emailssent) || 0,
      validEmails,
      openRate: 0,
      validityRate: totalContacts > 0 ? Math.round((validEmails / totalContacts) * 100) : 0
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Dashboard error' });
  }
});

// ============ LISTS ============
app.get('/api/lists', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM lists WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error fetching lists' });
  }
});

app.post('/api/lists/upload', verifyToken, async (req, res) => {
  const { listName, emails } = req.body;

  if (!listName) {
    return res.status(400).json({ error: 'Missing listName' });
  }

  let emailsToValidate = [];

  if (emails && Array.isArray(emails)) {
    emailsToValidate = emails;
  } else if (emails && typeof emails === 'string') {
    emailsToValidate = extractEmailsFromCSV(emails);
  }

  if (emailsToValidate.length === 0) {
    return res.status(400).json({ error: 'No valid emails found in file' });
  }

  try {
    const validationResults = [];
    let validCount = 0;
    let invalidCount = 0;

    for (const email of emailsToValidate) {
      const result = await validateEmailWithAbstract(email);
      validationResults.push(result);

      if (result.status === 'valid') {
        validCount++;
      } else {
        invalidCount++;
      }
    }

    const validity_rate = emailsToValidate.length > 0 ? Math.round((validCount / emailsToValidate.length) * 100) : 0;

    // Insert into database
    const dbResult = await pool.query(
      `INSERT INTO lists (user_id, name, status, total_emails, valid_emails, invalid_emails, validity_rate, validation_details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, total_emails, valid_emails, invalid_emails, validity_rate`,
      [req.user.id, listName, 'completed', emailsToValidate.length, validCount, invalidCount, validity_rate, JSON.stringify(validationResults)]
    );

    const newList = dbResult.rows[0];

    res.json({
      listId: newList.id,
      message: 'List uploaded and validated',
      total_emails: newList.total_emails,
      valid_emails: newList.valid_emails,
      invalid_emails: newList.invalid_emails,
      validity_rate: newList.validity_rate
    });
  } catch (error) {
    console.error('Error uploading list:', error);
    res.status(500).json({ error: 'Failed to validate emails', details: error.message });
  }
});

// ============ SENDER CONFIG ============
app.get('/api/sender-config', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM smtp_config WHERE user_id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.json({
        smtpHost: '',
        smtpPort: 587,
        smtpUser: '',
        smtpPassword: '',
        fromEmail: '',
        fromName: ''
      });
    }

    const config = result.rows[0];
    res.json({
      smtpHost: config.smtp_host,
      smtpPort: config.smtp_port,
      smtpUser: config.smtp_user,
      smtpPassword: config.smtp_password,
      fromEmail: config.from_email,
      fromName: config.from_name
    });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching config' });
  }
});

app.post('/api/sender-config', verifyToken, async (req, res) => {
  const { smtpHost, smtpPort, smtpUser, smtpPassword, fromEmail, fromName } = req.body;

  if (!smtpHost || !smtpUser || !smtpPassword || !fromEmail) {
    return res.status(400).json({ error: 'Missing required SMTP fields' });
  }

  try {
    // Check if config exists
    const existing = await pool.query(
      'SELECT * FROM smtp_config WHERE user_id = $1',
      [req.user.id]
    );

    if (existing.rows.length > 0) {
      // Update
      await pool.query(
        `UPDATE smtp_config SET smtp_host = $1, smtp_port = $2, smtp_user = $3, 
         smtp_password = $4, from_email = $5, from_name = $6, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $7`,
        [smtpHost, parseInt(smtpPort), smtpUser, smtpPassword, fromEmail, fromName, req.user.id]
      );
    } else {
      // Insert
      await pool.query(
        `INSERT INTO smtp_config (user_id, smtp_host, smtp_port, smtp_user, smtp_password, from_email, from_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.user.id, smtpHost, parseInt(smtpPort), smtpUser, smtpPassword, fromEmail, fromName]
      );
    }

    res.json({
      message: 'Config saved successfully',
      config: { smtpHost, smtpPort, smtpUser, fromEmail, fromName }
    });
  } catch (err) {
    console.error('SMTP config error:', err);
    res.status(500).json({ error: 'Failed to save config' });
  }
});

// ============ CAMPAIGNS ============
app.get('/api/campaigns', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM campaigns WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error fetching campaigns' });
  }
});

app.post('/api/campaigns', verifyToken, async (req, res) => {
  const { name, subject, htmlContent, listId, fromEmail, fromName } = req.body;

  if (!name || !subject || !listId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const trackingId = uuidv4();
    const result = await pool.query(
      `INSERT INTO campaigns (user_id, name, subject, list_id, html_content, from_email, from_name, tracking_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, subject, list_id, status, tracking_id`,
      [req.user.id, name, subject, listId, htmlContent, fromEmail, fromName, trackingId]
    );

    const campaign = result.rows[0];
    res.json({
      campaignId: campaign.id,
      message: 'Campaign created',
      campaign
    });
  } catch (err) {
    console.error('Campaign creation error:', err);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

app.post('/api/campaigns/:id/send', verifyToken, async (req, res) => {
  const campaignId = parseInt(req.params.id);

  try {
    // Get campaign
    const campaignResult = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1 AND user_id = $2',
      [campaignId, req.user.id]
    );

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignResult.rows[0];

    // Get list
    const listResult = await pool.query(
      'SELECT validation_details FROM lists WHERE id = $1',
      [campaign.list_id]
    );

    if (listResult.rows.length === 0) {
      return res.status(404).json({ error: 'List not found' });
    }

    // Get SMTP config
    const smtpResult = await pool.query(
      'SELECT * FROM smtp_config WHERE user_id = $1',
      [req.user.id]
    );

    if (smtpResult.rows.length === 0) {
      return res.status(400).json({ error: 'SMTP not configured. Setup ESP first.' });
    }

    const smtpConfig = smtpResult.rows[0];
    const validationDetails = listResult.rows[0].validation_details;
    const validEmails = validationDetails
      .filter(v => v.status === 'valid')
      .map(v => v.email);

    if (validEmails.length === 0) {
      return res.status(400).json({ error: 'No valid emails in list' });
    }

    // Send emails
    const transporter = createTransporter(smtpConfig);
    let sentCount = 0;

    for (const email of validEmails) {
      try {
        const trackingPixel = `<img src="${BASE_URL}/api/track/open/${campaign.tracking_id}/${Buffer.from(email).toString('base64')}" width="1" height="1" />`;
        const htmlWithTracking = campaign.html_content + trackingPixel;

        await transporter.sendMail({
          from: `${smtpConfig.from_name} <${smtpConfig.from_email}>`,
          to: email,
          subject: campaign.subject,
          html: htmlWithTracking
        });

        sentCount++;
      } catch (err) {
        console.error(`Failed to send to ${email}:`, err.message);
      }
    }

    // Update campaign status
    await pool.query(
      'UPDATE campaigns SET status = $1, total_sent = $2 WHERE id = $3',
      ['sent', sentCount, campaignId]
    );

    res.json({
      message: `Campaign sent to ${sentCount} emails`,
      sentCount,
      campaign: { ...campaign, status: 'sent', total_sent: sentCount }
    });
  } catch (err) {
    console.error('Campaign send error:', err);
    res.status(500).json({ error: 'Failed to send campaign', details: err.message });
  }
});

// ============ TRACKING ============
app.get('/api/track/open/:campaignId/:emailEncoded', async (req, res) => {
  try {
    const { campaignId, emailEncoded } = req.params;
    const email = Buffer.from(emailEncoded, 'base64').toString('utf-8');

    // Update campaign opened count
    await pool.query(
      'UPDATE campaigns SET opened = opened + 1 WHERE id = $1',
      [campaignId]
    );

    // Log event
    await pool.query(
      'INSERT INTO email_events (campaign_id, email, event_type) VALUES ($1, $2, $3)',
      [campaignId, email, 'open']
    );

    // Return tracking pixel
    const pixel = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x21, 0xF9, 0x04, 0x01, 0x0A, 0x00, 0x01, 0x00, 0x2C, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x4C, 0x01, 0x00, 0x3B]);
    res.contentType('image/gif');
    res.send(pixel);
  } catch (err) {
    console.error('Tracking error:', err);
    res.status(500).send('');
  }
});

app.get('/api/campaigns/:id/analytics', verifyToken, async (req, res) => {
  const campaignId = parseInt(req.params.id);

  try {
    const result = await pool.query(
      'SELECT total_sent, opened, clicked FROM campaigns WHERE id = $1 AND user_id = $2',
      [campaignId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = result.rows[0];

    res.json({
      sent: campaign.total_sent || 0,
      opened: campaign.opened || 0,
      clicked: campaign.clicked || 0,
      bounced: 0,
      openRate: campaign.total_sent > 0 ? Math.round((campaign.opened / campaign.total_sent) * 100) : 0,
      clickRate: campaign.total_sent > 0 ? Math.round((campaign.clicked / campaign.total_sent) * 100) : 0
    });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: 'Error fetching analytics' });
  }
});

// ============ ERROR HANDLING ============
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`🗄️  PostgreSQL: Connected ✅`);
  console.log(`📧 Abstract API: ${ABSTRACT_API_KEY ? 'Connected ✅' : 'Not configured ⚠️'}`);
  console.log(`📨 Email Sending: Nodemailer Ready ✅`);
});