// chart-manager.js - Chart.js latency chart management

export class ChartManager {
  constructor(canvasId) {
    this.canvasId = canvasId;
    this.chart = null;
  }

  initialize() {
    const ctx = document.getElementById(this.canvasId);

    if (!ctx) {
      console.error('Chart canvas not found:', this.canvasId);
      return false;
    }

    this.destroy();
    this.chart = new Chart(ctx, this.createConfig());
    console.log('Latency chart initialized');
    return true;
  }

  createConfig() {
    return {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          this.createDataset('Total Latency', '#9C27B0', 2, true),
          this.createDataset('Network', '#4facfe', 1.5, false, [5, 5]),
          this.createDataset('ROS + Encoding', '#43e97b', 1.5, false, [2, 2])
        ]
      },
      options: this.createOptions()
    };
  }

  createDataset(label, color, width, fill, dash = []) {
    return {
      label,
      data: [],
      borderColor: color,
      backgroundColor: this.hexToRgba(color, 0.1),
      borderWidth: width,
      fill,
      tension: 0.3,
      pointRadius: 0,
      pointHitRadius: 10,
      borderDash: dash
    };
  }

  hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  createOptions() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: this.createLegendConfig(),
        tooltip: this.createTooltipConfig()
      },
      scales: {
        x: this.createXAxisConfig(),
        y: this.createYAxisConfig()
      }
    };
  }

  createLegendConfig() {
    return {
      display: true,
      position: 'top',
      labels: {
        color: '#4a5568',
        usePointStyle: true,
        padding: 15,
        font: { size: 11 }
      }
    };
  }

  createTooltipConfig() {
    return {
      enabled: true,
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      titleColor: 'white',
      bodyColor: 'white',
      callbacks: {
        label: (context) => `${context.dataset.label}: ${context.parsed.y.toFixed(1)}ms`
      }
    };
  }

  createXAxisConfig() {
    return {
      display: true,
      grid: { color: 'rgba(0, 0, 0, 0.05)', drawBorder: false },
      ticks: { color: '#718096', maxTicksLimit: 10, font: { size: 10 } },
      title: { display: true, text: 'Time', color: '#718096', font: { size: 11 } }
    };
  }

  createYAxisConfig() {
    return {
      display: true,
      grid: { color: 'rgba(0, 0, 0, 0.05)', drawBorder: false },
      ticks: {
        color: '#718096',
        font: { size: 10 },
        callback: (value) => value + 'ms'
      },
      title: { display: true, text: 'Latency (ms)', color: '#718096', font: { size: 11 } },
      beginAtZero: true,
      suggestedMax: 150
    };
  }

  update(history) {
    if (!this.chart) return;

    this.chart.data.labels = history.getLabels();
    this.chart.data.datasets[0].data = history.getTotalLatencies();
    this.chart.data.datasets[1].data = history.getNetworkLatencies();
    this.chart.data.datasets[2].data = history.getProcessingLatencies();

    const maxVal = history.getMaxTotal();
    this.chart.options.scales.y.suggestedMax = Math.ceil(maxVal * 1.2 / 10) * 10;

    this.chart.update('none');
  }

  destroy() {
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
  }

  isInitialized() {
    return this.chart !== null;
  }
}