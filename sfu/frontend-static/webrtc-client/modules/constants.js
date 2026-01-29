// constants.js - Shared configuration values

export const CLOCK_SYNC = {
  INITIAL_PING_COUNT: 5,
  INITIAL_PING_INTERVAL_MS: 200,
  PERIODIC_INTERVAL_MS: 5000,
  PING_TIMEOUT_MS: 5000,
  MAX_VALID_RTT_MS: 500,
  MAX_SAMPLES: 20,
  MIN_SAMPLES_FOR_SYNC: 3
};

export const PYTHON_CALIBRATION = {
  SKEW_THRESHOLD_MS: 1000,
  MIN_SAMPLES: 3,
  MAX_SAMPLES: 10,
  DEFAULT_NETWORK_LATENCY_MS: 25,
  MAX_COMPENSATED_LATENCY_MS: 5000
};

export const SYNC_QUALITY_THRESHOLDS = {
  EXCELLENT: 20,
  GOOD: 50,
  FAIR: 100
};

export const WEBRTC = {
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],
  BUNDLE_POLICY: 'max-bundle',
  RTCP_MUX_POLICY: 'require'
};

export const DATA_CHANNEL = {
  LABEL: 'metrics',
  ORDERED: false,
  MAX_RETRANSMITS: 0
};

export const LOW_LATENCY = {
  PLAYOUT_DELAY_HINT: 0.0,
  JITTER_BUFFER_TARGET: 0.01
};

export const MONITORING = {
  JITTER_INTERVAL_MS: 1000,
  PROCESSING_DURATION_SAMPLES: 30,
  LOG_FREQUENCY: 30
};