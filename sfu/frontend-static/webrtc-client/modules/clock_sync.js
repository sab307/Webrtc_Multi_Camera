// clock-sync.js - NTP-style clock synchronization with two-stage offset handling

import {
  CLOCK_SYNC,
  PYTHON_CALIBRATION,
  SYNC_QUALITY_THRESHOLDS
} from './constants.js';

export class ClockSynchronizer {
  constructor() {
    this.samples = [];
    this.rttSamples = [];
    this.pendingPings = new Map();
    this.syncInterval = null;
    
    // Go relay ↔ Browser offset
    this.offset = 0;
    this.synced = false;
    this.lastSyncTime = null;
    
    // Python sender ↔ Browser offset
    this.pythonOffset = 0;
    this.pythonCalibrated = false;
    this.rawLatencySamples = [];
    
    this.sendPingFn = null;
    this.onSync = null;
  }

  start(sendPingFn) {
    this.sendPingFn = sendPingFn;
    this.sendInitialBurst();
    this.startPeriodicSync();
  }

  stop() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  sendInitialBurst() {
    for (let i = 0; i < CLOCK_SYNC.INITIAL_PING_COUNT; i++) {
      setTimeout(() => this.sendPing(), i * CLOCK_SYNC.INITIAL_PING_INTERVAL_MS);
    }
  }

  startPeriodicSync() {
    this.syncInterval = setInterval(
      () => this.sendPing(),
      CLOCK_SYNC.PERIODIC_INTERVAL_MS
    );
  }

  sendPing() {
    if (!this.sendPingFn) return;

    const pingId = this.generatePingId();
    const t1 = Date.now();

    this.pendingPings.set(pingId, { t1 });
    this.sendPingFn({ type: 'ping', ping_id: pingId, client_time: t1 });
    this.schedulePingTimeout(pingId);
  }

  generatePingId() {
    return Math.random().toString(36).substring(2, 10);
  }

  schedulePingTimeout(pingId) {
    setTimeout(() => {
      if (this.pendingPings.has(pingId)) {
        this.pendingPings.delete(pingId);
        console.warn('Ping timeout:', pingId);
      }
    }, CLOCK_SYNC.PING_TIMEOUT_MS);
  }

  handlePong(msg) {
    const t4 = Date.now();
    const pingData = this.pendingPings.get(msg.ping_id);

    if (!pingData) {
      console.warn('Unknown pong:', msg.ping_id);
      return null;
    }

    this.pendingPings.delete(msg.ping_id);

    const { t1 } = pingData;
    const t2 = msg.server_receive;
    const t3 = msg.server_send;

    const rtt = (t4 - t1) - (t3 - t2);
    const oneWayDelay = rtt / 2;
    const offset = (t2 + oneWayDelay) - t4;

    if (!this.isValidRtt(rtt)) {
      console.warn(`Rejected: RTT ${rtt.toFixed(2)}ms out of range`);
      return null;
    }

    this.addSample({ offset, rtt, timestamp: t4 });

    if (this.samples.length >= CLOCK_SYNC.MIN_SAMPLES_FOR_SYNC) {
      return this.calculateOffset();
    }

    console.log(`Collecting samples: ${this.samples.length}/${CLOCK_SYNC.MIN_SAMPLES_FOR_SYNC}`);
    return null;
  }

  isValidRtt(rtt) {
    return rtt >= 0 && rtt <= CLOCK_SYNC.MAX_VALID_RTT_MS;
  }

  addSample(sample) {
    this.samples.push(sample);
    if (this.samples.length > CLOCK_SYNC.MAX_SAMPLES) {
      this.samples.shift();
    }
  }

  calculateOffset() {
    const bestSamples = this.selectBestSamples();
    const medianOffset = this.calculateMedian(bestSamples.map(s => s.offset));

    this.offset = medianOffset;
    this.synced = true;
    this.lastSyncTime = Date.now();
    this.rttSamples = bestSamples.map(s => s.rtt);

    const stats = this.getStats();

    if (this.onSync) {
      this.onSync(stats);
    }

    return stats;
  }

  selectBestSamples() {
    const sortedByRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const halfCount = Math.ceil(sortedByRtt.length / 2);
    return sortedByRtt.slice(0, halfCount);
  }

  calculateMedian(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  compensateLatency(rawLatency) {
    const hasLargeSkew = Math.abs(rawLatency) > PYTHON_CALIBRATION.SKEW_THRESHOLD_MS;

    if (hasLargeSkew) {
      return this.handleLargeSkew(rawLatency);
    }

    return this.handleSmallSkew(rawLatency);
  }

  handleLargeSkew(rawLatency) {
    this.collectPythonSample(rawLatency);

    if (this.pythonCalibrated) {
      const compensated = rawLatency - this.pythonOffset;

      if (this.isValidCompensatedLatency(compensated)) {
        return { latency: compensated, method: 'python-synced' };
      }

      this.resetPythonCalibration();
    }

    return this.useRttEstimate('calibrating');
  }

  handleSmallSkew(rawLatency) {
    this.checkPythonCalibrationReset(rawLatency);

    if (this.synced) {
      const compensated = rawLatency + this.offset;

      if (compensated >= 0 && compensated < 1000) {
        return { latency: compensated, method: 'synced' };
      }
    }

    return { latency: Math.max(0, rawLatency), method: 'raw' };
  }

  collectPythonSample(rawLatency) {
    this.rawLatencySamples.push(rawLatency);

    if (this.rawLatencySamples.length > PYTHON_CALIBRATION.MAX_SAMPLES) {
      this.rawLatencySamples.shift();
    }

    if (this.shouldCalibratePython()) {
      this.calibratePythonOffset();
    }
  }

  shouldCalibratePython() {
    return this.rawLatencySamples.length >= PYTHON_CALIBRATION.MIN_SAMPLES &&
           !this.pythonCalibrated;
  }

  calibratePythonOffset() {
    const medianRaw = this.calculateMedian(this.rawLatencySamples);
    const estimatedNetwork = this.getEstimatedNetworkLatency();

    this.pythonOffset = medianRaw - estimatedNetwork;
    this.pythonCalibrated = true;

    console.log(`Python↔Browser offset calibrated: ${this.pythonOffset.toFixed(1)}ms`);
  }

  getEstimatedNetworkLatency() {
    if (this.rttSamples.length === 0) {
      return PYTHON_CALIBRATION.DEFAULT_NETWORK_LATENCY_MS;
    }

    const avgRtt = this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length;
    return avgRtt / 2;
  }

  isValidCompensatedLatency(latency) {
    return latency >= 0 && latency < PYTHON_CALIBRATION.MAX_COMPENSATED_LATENCY_MS;
  }

  checkPythonCalibrationReset(rawLatency) {
    if (this.pythonCalibrated && Math.abs(rawLatency) < 500) {
      console.log('Clocks appear synced - resetting Python offset');
      this.resetPythonCalibration();
    }
  }

  resetPythonCalibration() {
    this.pythonCalibrated = false;
    this.pythonOffset = 0;
    this.rawLatencySamples = [];
  }

  useRttEstimate(method) {
    const avgRtt = this.rttSamples.length > 0
      ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length
      : 20;

    return { latency: avgRtt / 2, method };
  }

  getStats() {
    const offsets = this.samples.map(s => s.offset);
    const stdDev = this.calculateStdDev(offsets);
    const quality = this.getSyncQuality(stdDev);

    const avgRtt = this.rttSamples.length > 0
      ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length
      : 0;

    const activeOffset = this.pythonCalibrated ? this.pythonOffset : this.offset;

    return {
      offset: activeOffset,
      offsetDirection: this.offset > 0 ? 'Server ahead' : 'Client ahead',
      offsetSource: this.pythonCalibrated ? 'Python↔Browser' : 'Go↔Browser',
      goOffset: this.offset,
      pythonOffset: this.pythonOffset,
      pythonCalibrated: this.pythonCalibrated,
      avgRtt,
      minRtt: this.rttSamples.length > 0 ? Math.min(...this.rttSamples) : 0,
      maxRtt: this.rttSamples.length > 0 ? Math.max(...this.rttSamples) : 0,
      jitter: this.calculateJitter(),
      stdDev,
      syncQuality: quality,
      samples: this.samples.length,
      synced: this.synced || this.pythonCalibrated,
      lastSyncTime: this.lastSyncTime
    };
  }

  calculateStdDev(values) {
    if (values.length === 0) return 0;

    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - avg, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;

    return Math.sqrt(variance);
  }

  calculateJitter() {
    if (this.rttSamples.length === 0) return 0;
    return Math.max(...this.rttSamples) - Math.min(...this.rttSamples);
  }

  getSyncQuality(stdDev) {
    if (stdDev <= SYNC_QUALITY_THRESHOLDS.EXCELLENT) return 'Excellent';
    if (stdDev <= SYNC_QUALITY_THRESHOLDS.GOOD) return 'Good';
    if (stdDev <= SYNC_QUALITY_THRESHOLDS.FAIR) return 'Fair';
    return 'Poor';
  }

  serverToClientTime(serverTime) {
    return serverTime - this.offset;
  }

  clientToServerTime(clientTime) {
    return clientTime + this.offset;
  }

  getSyncedServerTime() {
    return Date.now() + this.offset;
  }

  reset() {
    this.samples = [];
    this.rttSamples = [];
    this.pendingPings.clear();
    this.offset = 0;
    this.synced = false;
    this.lastSyncTime = null;
    this.resetPythonCalibration();
  }
}