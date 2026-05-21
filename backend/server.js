'use strict';
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const aiRouter = require('./routes/ai');

const app  = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve frontend
app.use(express.static(path.join(__dirname, '../Frontend')));

// AI endpoints (only thing the backend does now)
app.use('/api/ai', aiRouter);

// Health check
app.get('/api/health', (_req, res) => {
  const key = process.env.GROQ_API_KEY;
  res.json({
    status: 'ok',
    groq:   key ? 'configured' : 'MISSING — add GROQ_API_KEY to .env',
    timestamp: new Date().toISOString(),
  });
});

// SPA fallback
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '../Frontend/index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  const key = process.env.GROQ_API_KEY;
  console.log('\n  PatentAI Office System');
  console.log(`  Backend running at http://localhost:${PORT}`);
  console.log(`  Frontend served at http://localhost:${PORT}/index.html`);
  console.log(`  Groq AI: ${key ? '✓ configured' : '✗ GROQ_API_KEY missing — add it to .env'}`);
  console.log(`  Storage: localStorage (no database needed)\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ERROR: Port ${PORT} is already in use.`);
    console.error(`  Windows:   taskkill /F /IM node.exe`);
    console.error(`  Mac/Linux: pkill node\n`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

module.exports = app;
