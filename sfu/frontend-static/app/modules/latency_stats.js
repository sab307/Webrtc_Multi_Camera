// latency-stats.js - Latency statistics tracking

export class LatencyStats {
  constructor() {
    this.reset();
  }

  reset() {
    this.min = Infinity;
    this.max = 0;
    this.sum = 0;
    this.count = 0;
    this.current = 0;
    this.method = '--';
  }

  update(latency, method) {
    if (latency <= 0) return;

    this.current = latency;
    this.min = Math.min(this.min, latency);
    this.max = Math.max(this.max, latency);
    this.sum += latency;
    this.count++;
    this.method = method || '--';
  }

  getAverage() {
    if (this.count === 0) return 0;
    return this.sum / this.count;
  }

  getMin() {
    return this.min === Infinity ? null : this.min;
  }

  getMax() {
    return this.max === 0 ? null : this.max;
  }

  toDisplayValues() {
    return {
      current: this.formatValue(this.current),
      min: this.formatValue(this.getMin()),
      avg: this.formatValue(this.getAverage()),
      max: this.formatValue(this.getMax()),
      method: this.method
    };
  }

  formatValue(value) {
    if (value === null || value === 0) return '--';
    return value.toFixed(1) + 'ms';
  }
}