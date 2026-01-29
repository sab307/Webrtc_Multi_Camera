// constants.js - App configuration constants

export const CHART = {
  DURATION_SECONDS: 25,
  UPDATE_INTERVAL_MS: 100,
  MAX_HISTORY_POINTS: 250  // 25 seconds * 10 points/second
};

export const COLORS = {
  EXCELLENT: '#48bb78',
  GOOD: '#68d391',
  WARNING: '#ecc94b',
  ERROR: '#f56565',
  PYTHON_SYNC: '#9f7aea'
};

export const THRESHOLDS = {
  OFFSET_EXCELLENT: 10,
  OFFSET_ACCEPTABLE: 50,
  JITTER_BUFFER_GOOD: 20,
  JITTER_BUFFER_WARNING: 50,
  DECODE_GOOD: 10,
  DECODE_WARNING: 20
};

export const CONNECTION_STATES = {
  connecting: 'Connecting...',
  connected: 'Connected',
  disconnected: 'Disconnected',
  failed: 'Connection Failed'
};