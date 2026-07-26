'use strict';

const path = require('path');

/**
 * Build a stable identifier for the current OS boot. Date.now() advances with
 * uptime, so subtracting uptime yields the boot timestamp. Minute precision
 * absorbs the small scheduling differences between separate app launches.
 */
function bootIdFrom(nowMs, uptimeSeconds) {
  const now = Number(nowMs);
  const uptime = Number(uptimeSeconds);
  if (!Number.isFinite(now) || !Number.isFinite(uptime) || uptime < 0) {
    throw new Error('Invalid system clock data');
  }
  return Math.round((now - uptime * 1000) / 60000);
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function shouldClearLegacyAutostart(value) {
  return String(value == null ? '' : value).trim() === '1';
}

function isDatabaseCorruptionError(error) {
  const message = String(error && error.message ? error.message : error || '');
  return /database disk image is malformed|file is not a database|not a database|database malformed/i.test(message);
}

module.exports = {
  bootIdFrom,
  isPathInside,
  shouldClearLegacyAutostart,
  isDatabaseCorruptionError,
};
