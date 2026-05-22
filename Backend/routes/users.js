'use strict';
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../lib/db');

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'patentai_salt_2024').digest('hex');
}

// POST /api/users/register
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, role } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    const result = await db.query(
      "INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, username, email, role",
      [username, email, hashPassword(password), role || 'applicant']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[Users] register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/users/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Missing email or password' });
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || user.password_hash !== hashPassword(password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    res.json({ id: user.id, username: user.username, email: user.email, role: user.role });
  } catch (err) {
    console.error('[Users] login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/users/me
router.get('/me', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const result = await db.query('SELECT id, username, email, role FROM users WHERE id = $1', [parseInt(userId)]);
    if (!result.rows.length) return res.status(401).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// POST /api/users/logout
router.post('/logout', (_req, res) => {
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;
