const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
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

// Mock database (in-memory for demo)
const users = [];
const lists = [];
const campaigns = [];
const smtpConfigs = {};
const emailEvents = []; // Track opens and clicks

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'Backend is running!', abstractApiConfigured: !!ABSTRACT_API_KEY });
});

// ============ ULTRA-ROBUST CSV PARSER ============
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

// ============ EMAIL VALIDATION WITH ABSTRACT API ============
async function validateEmailWithAbstract(email) {
  try {
    if (!ABSTRACT_API_KEY) {
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

// ============ NODEMAILER SETUP ============
function createTransporter(smtpConfig) {
  return nodemailer.createTransport({
    host: smtpConfig.smtpHost,
    port: smtpConfig.smtpPort,
    secure: smtpConfig.smtpPort === 465,
    auth: {
      user: smtpConfig.smtpUser,
      pass: smtpConfig.smtpPassword
    }
  });
}

// ============ AUTH ROUTES ============
app.post('/auth/register', async (req, res) => {
  const { email, password, company } = req.body;

  if (!email || !password || !company) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  if (users.find(u => u.email === email)) {
    return res.status(400).json({ error: 'User already exists' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const userId = users.length + 1;
  
  users.push({
    id: userId,
    email,
    password: hashedPassword,
    company,
    createdAt: new Date()
  });

  res.json({ message: 'User registered successfully', email });
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
  res.json({
    token,
    user: { id: user.id, email, company: user.company }
  });
});

// ============ DASHBOARD ============
app.get('/api/dashboard', (req, res) => {
  const totalValidEmails = lists.reduce((sum, list) => sum + (list.valid_emails || 0), 0);
  const totalEmails = lists.reduce((sum, list) => sum + (list.total_emails || 0), 0);
  const totalEmailsSent = campaigns.reduce((sum, camp) => sum + (camp.total_sent || 0), 0);

  res.json({
    totalLists: lists.length,
    totalContacts: totalEmails,
    totalCampaigns: campaigns.length,
    emailsSent: totalEmailsSent,
    validEmails: totalValidEmails,
    openRate: 0,
    validityRate: totalEmails > 0 ? Math.round((totalValidEmails / totalEmails) * 100) : 0
  });
});

// ============ LISTS ============
app.get('/api/lists', (req, res) => {
  res.json(lists);
});

app.post('/api/lists/upload', async (req, res) => {
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

    const newList = {
      id: lists.length + 1,
      name: listName,
      status: 'completed',
      total_emails: emailsToValidate.length,
      valid_emails: validCount,
      invalid_emails: invalidCount,
      validity_rate: emailsToValidate.length > 0 ? Math.round((validCount / emailsToValidate.length) * 100) : 0,
      validationDetails: validationResults,
      createdAt: new Date()
    };

    lists.push(newList);

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

// ============ SENDER CONFIG (ESP SETUP) ============
app.get('/api/sender-config', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const config = smtpConfigs[decoded.id] || {
      smtpHost: '',
      smtpPort: 587,
      smtpUser: '',
      smtpPassword: '',
      fromEmail: '',
      fromName: ''
    };
    res.json(config);
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.post('/api/sender-config', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { smtpHost, smtpPort, smtpUser, smtpPassword, fromEmail, fromName } = req.body;

    if (!smtpHost || !smtpUser || !smtpPassword || !fromEmail) {
      return res.status(400).json({ error: 'Missing required SMTP fields' });
    }

    smtpConfigs[decoded.id] = {
      smtpHost,
      smtpPort: parseInt(smtpPort),
      smtpUser,
      smtpPassword,
      fromEmail,
      fromName
    };

    res.json({
      message: 'Config saved successfully',
      config: smtpConfigs[decoded.id]
    });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ============ CAMPAIGNS ============
app.get('/api/campaigns', (req, res) => {
  res.json(campaigns);
});

app.post('/api/campaigns', (req, res) => {
  const { name, subject, htmlContent, listId, fromEmail, fromName } = req.body;

  if (!name || !subject || !listId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const trackingId = uuidv4();
  const newCampaign = {
    id: campaigns.length + 1,
    name,
    subject,
    listId,
    htmlContent,
    fromEmail,
    fromName,
    status: 'draft',
    total_sent: 0,
    opened: 0,
    clicked: 0,
    trackingId,
    createdAt: new Date()
  };

  campaigns.push(newCampaign);
  res.json({
    campaignId: newCampaign.id,
    message: 'Campaign created',
    campaign: newCampaign
  });
});

app.post('/api/campaigns/:id/send', async (req, res) => {
  const campaignId = parseInt(req.params.id);
  const campaign = campaigns.find(c => c.id === campaignId);

  if (!campaign) {
    return res.status(404).json({ error: 'Campaign not found' });
  }

  const list = lists.find(l => l.id === campaign.listId);
  if (!list) {
    return res.status(404).json({ error: 'List not found' });
  }

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const smtpConfig = smtpConfigs[decoded.id];

    if (!smtpConfig) {
      return res.status(400).json({ error: 'SMTP not configured. Setup ESP first.' });
    }

    const transporter = createTransporter(smtpConfig);

    // Get valid emails from list
    const validEmails = list.validationDetails
      ?.filter(v => v.status === 'valid')
      .map(v => v.email) || [];

    if (validEmails.length === 0) {
      return res.status(400).json({ error: 'No valid emails in list' });
    }

    let sentCount = 0;
    const errors = [];

    // Send emails
    for (const email of validEmails) {
      try {
        // Add tracking pixel
        const trackingPixel = `<img src="${BASE_URL}/api/track/open/${campaign.trackingId}/${Buffer.from(email).toString('base64')}" width="1" height="1" />`;
        const htmlWithTracking = campaign.htmlContent + trackingPixel;

        await transporter.sendMail({
          from: `${smtpConfig.fromName} <${smtpConfig.fromEmail}>`,
          to: email,
          subject: campaign.subject,
          html: htmlWithTracking
        });

        sentCount++;
      } catch (err) {
        console.error(`Failed to send to ${email}:`, err.message);
        errors.push(email);
      }
    }

    campaign.status = 'sent';
    campaign.total_sent = sentCount;

    res.json({
      message: `Campaign sent to ${sentCount} emails`,
      sentCount,
      failedCount: errors.length,
      campaign: campaign
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send campaign', details: err.message });
  }
});

// ============ TRACKING ============
// Track email opens
app.get('/api/track/open/:campaignId/:emailEncoded', (req, res) => {
  try {
    const { campaignId, emailEncoded } = req.params;
    const email = Buffer.from(emailEncoded, 'base64').toString('utf-8');
    const campaign = campaigns.find(c => c.id === parseInt(campaignId));

    if (campaign) {
      campaign.opened = (campaign.opened || 0) + 1;
      emailEvents.push({
        campaignId,
        email,
        event: 'open',
        timestamp: new Date()
      });
    }

    // Return transparent pixel
    const pixel = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x21, 0xF9, 0x04, 0x01, 0x0A, 0x00, 0x01, 0x00, 0x2C, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x4C, 0x01, 0x00, 0x3B]);
    res.contentType('image/gif');
    res.send(pixel);
  } catch (err) {
    console.error('Tracking error:', err);
    res.status(500).send('');
  }
});

app.get('/api/campaigns/:id/analytics', (req, res) => {
  const campaignId = parseInt(req.params.id);
  const campaign = campaigns.find(c => c.id === campaignId);

  if (!campaign) {
    return res.status(404).json({ error: 'Campaign not found' });
  }

  res.json({
    sent: campaign.total_sent || 0,
    opened: campaign.opened || 0,
    clicked: campaign.clicked || 0,
    bounced: 0,
    openRate: campaign.total_sent > 0 ? Math.round((campaign.opened / campaign.total_sent) * 100) : 0,
    clickRate: campaign.total_sent > 0 ? Math.round((campaign.clicked / campaign.total_sent) * 100) : 0
  });
});

// ============ ERROR HANDLING ============
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`📧 Abstract API: ${ABSTRACT_API_KEY ? 'Connected ✅' : 'Not configured ⚠️'}`);
  console.log(`📨 Email Sending: Nodemailer Ready ✅`);
});