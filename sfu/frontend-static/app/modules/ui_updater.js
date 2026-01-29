// ui-updater.js - DOM update utilities

import { COLORS, THRESHOLDS, CONNECTION_STATES } from './constants.js';

export class UIUpdater {
  static setTextContent(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  static setStyle(id, property, value) {
    const el = document.getElementById(id);
    if (el) el.style[property] = value;
  }

  static setClassName(id, className) {
    const el = document.getElementById(id);
    if (el) el.className = className;
  }

  static getColorForValue(value, goodThreshold, warningThreshold) {
    if (value < goodThreshold) return COLORS.EXCELLENT;
    if (value < warningThreshold) return COLORS.WARNING;
    return COLORS.ERROR;
  }

  static formatOffset(offset) {
    const absOffset = Math.abs(offset);
    if (absOffset > 1000) {
      return (absOffset / 1000).toFixed(1) + 's';
    }
    return absOffset.toFixed(2) + 'ms';
  }

  static getOffsetColor(offset) {
    const absOffset = Math.abs(offset);
    if (absOffset < THRESHOLDS.OFFSET_EXCELLENT) return COLORS.EXCELLENT;
    if (absOffset < THRESHOLDS.OFFSET_ACCEPTABLE) return COLORS.WARNING;
    return COLORS.ERROR;
  }

  static updateConnectionStatus(state) {
    const indicator = document.getElementById('statusIndicator');
    const text = document.getElementById('statusText');

    if (indicator) indicator.className = 'status-indicator ' + state;
    if (text) text.textContent = CONNECTION_STATES[state] || state;
  }

  static updateClockSyncCompact(syncStats) {
    const offsetValue = document.getElementById('clockOffset');
    
    if (offsetValue) {
      offsetValue.textContent = this.formatOffset(syncStats.offset);
      offsetValue.style.color = this.getOffsetColor(syncStats.offset);
    }

    this.updateOffsetDirection(syncStats);
    this.updateSyncIndicator(syncStats);
  }

  static updateOffsetDirection(syncStats) {
    const el = document.getElementById('offsetDirection');
    if (!el) return;

    const source = syncStats.offsetSource || 'Go↔Browser';
    const direction = syncStats.offset > 0 ? 'Server ahead' : 'Client ahead';
    
    el.textContent = `(${direction}) [${source}]`;
    el.className = `offset-direction ${syncStats.offset > 0 ? 'server-ahead' : 'client-ahead'}`;
  }

  static updateSyncIndicator(syncStats) {
    const indicator = document.getElementById('clockSyncIndicator');
    if (!indicator) return;

    indicator.className = 'sync-indicator synced';
    indicator.title = `Clock synchronized (${syncStats.offsetSource || 'Go↔Browser'})`;
  }

  static updateClockSyncPanel(syncStats) {
    this.setTextContent('clockOffset', this.formatOffset(syncStats.offset));
    this.setTextContent('clockRtt', syncStats.avgRtt.toFixed(2) + 'ms');
    this.setTextContent('clockJitter', syncStats.jitter.toFixed(2) + 'ms');
    this.setTextContent('clockSamples', syncStats.samples);

    this.updateSyncQuality(syncStats);
  }

  static updateSyncQuality(syncStats) {
    const el = document.getElementById('syncQuality');
    if (!el) return;

    if (syncStats.pythonCalibrated) {
      el.textContent = 'Python Synced';
      el.style.color = COLORS.PYTHON_SYNC;
      return;
    }

    el.textContent = syncStats.syncQuality || 'Syncing...';
    el.style.color = this.getQualityColor(syncStats.syncQuality);
  }

  static getQualityColor(quality) {
    const colorMap = {
      'Excellent': COLORS.EXCELLENT,
      'Good': COLORS.GOOD,
      'Fair': COLORS.WARNING
    };
    return colorMap[quality] || COLORS.ERROR;
  }

  static updateDetailClockDisplay(syncStats) {
    const absOffset = Math.abs(syncStats.offset);
    const offsetText = this.formatOffset(syncStats.offset);
    const direction = syncStats.offset > 0 ? 'Server ahead' : 'Client ahead';

    const detailOffset = document.getElementById('detailClockOffset');
    if (detailOffset) {
      detailOffset.textContent = `${offsetText} (${direction})`;
      detailOffset.title = `Source: ${syncStats.offsetSource || 'Go↔Browser'}`;
      detailOffset.style.color = syncStats.pythonCalibrated ? COLORS.PYTHON_SYNC : '';
    }

    this.setTextContent('detailClockRtt', syncStats.avgRtt.toFixed(2) + 'ms');
    this.setTextContent('detailMinRtt', syncStats.minRtt.toFixed(2) + 'ms');
    this.setTextContent('detailMaxRtt', syncStats.maxRtt.toFixed(2) + 'ms');
    this.setTextContent('detailStdDev', syncStats.stdDev.toFixed(2) + 'ms');
  }

  static updateLatencyStats(stats) {
    const values = stats.toDisplayValues();

    this.setTextContent('latencyCurrentValue', values.current);
    this.setTextContent('latencyMinValue', values.min);
    this.setTextContent('latencyAvgValue', values.avg);
    this.setTextContent('latencyMaxValue', values.max);

    const methodEl = document.getElementById('latencyMethodValue');
    if (methodEl) {
      methodEl.textContent = values.method;
      methodEl.className = `value method-badge method-${values.method}`;
    }
  }

  static updateDetailMetrics(metrics) {
    this.setTextContent('totalLatency', Math.round(metrics.totalLatency || 0) + 'ms');
    this.setTextContent('frameCount', metrics.frameCount || 0);

    if (metrics.width && metrics.height) {
      this.setTextContent('resolution', `${metrics.width}x${metrics.height}`);
    }

    this.updateClockSyncStatus(metrics);
    this.updateLatencyComponents(metrics);
  }

  static updateClockSyncStatus(metrics) {
    const el = document.getElementById('clockSyncStatus');
    if (!el) return;

    let statusText = metrics.clockSynced ? '✓ Synced' : '○ Syncing...';
    if (metrics.latencyMethod) {
      statusText += ` (${metrics.latencyMethod})`;
    }

    el.textContent = statusText;
    el.style.color = metrics.clockSynced ? COLORS.EXCELLENT : COLORS.WARNING;
  }

  static updateLatencyComponents(metrics) {
    this.setTextContent('rosLatency', Math.round(metrics.rosLatency || 0) + 'ms');
    this.setTextContent('processingLatency', Math.round(metrics.processingLatency || 0) + 'ms');
    this.setTextContent('networkLatency', Math.round(metrics.networkLatency || 0) + 'ms');
    this.setTextContent('renderLatency', Math.round(metrics.renderLatency || 0) + 'ms');

    this.updateJitterBuffer(metrics.jitterBufferDelay || 0);
    this.updateDecodeTime(metrics.decodeTime || 0);
  }

  static updateJitterBuffer(value) {
    const el = document.getElementById('jitterBufferLatency');
    if (!el) return;

    el.textContent = value.toFixed(1) + 'ms';
    el.style.color = this.getColorForValue(
      value,
      THRESHOLDS.JITTER_BUFFER_GOOD,
      THRESHOLDS.JITTER_BUFFER_WARNING
    );
  }

  static updateDecodeTime(value) {
    const el = document.getElementById('decodeLatency');
    if (!el) return;

    el.textContent = value.toFixed(1) + 'ms';
    el.style.color = this.getColorForValue(
      value,
      THRESHOLDS.DECODE_GOOD,
      THRESHOLDS.DECODE_WARNING
    );
  }

  static updateStreamCount(count) {
    this.setTextContent('streamCount', count);
  }
}