'use strict';

const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error('JWT_SECRET env var is required');

/**
 * Sign a JWT for a user.
 * @param {{ id: string, username: string }} user
 * @returns {string} signed token (expires 7d)
 */
function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, SECRET, { expiresIn: '7d' });
}

/**
 * Express middleware — verifies Bearer JWT.
 * On success, sets req.user = { id, username }.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, SECRET);
    req.user = { id: payload.sub, username: payload.username };
    next();
  } catch (err) {
    const message = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
    return res.status(401).json({ error: message });
  }
}

module.exports = { signToken, requireAuth };
