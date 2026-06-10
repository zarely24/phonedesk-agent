'use strict';
// BACKEND is where the agent phones home. Replaced with your Render URL when we build the installer.
// Dev default points at the local backend.
module.exports = {
  // Production default: the owner's app phones home to the Render backend over wss (core.js derives
  // wss:// from this https URL). For local dev, override with the BACKEND env var, e.g.
  // BACKEND=http://127.0.0.1:8080 - use 127.0.0.1 not "localhost" (Node resolves localhost to IPv6
  // ::1 intermittently, which hangs against the IPv4-only local backend).
  BACKEND: process.env.BACKEND || 'https://phonedesk-backend.onrender.com',
};
