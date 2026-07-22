function simpleMovingAverage(values, window) {
  if (!values || values.length === 0 || window < 1) return [];
  const result = [];
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    const avg = slice.reduce((s, v) => s + v, 0) / slice.length;
    result.push(avg);
  }
  return result;
}

function exponentialMovingAverage(values, alpha) {
  if (!values || values.length === 0) return [];
  if (alpha <= 0 || alpha > 1) alpha = 0.3;
  const result = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(alpha * values[i] + (1 - alpha) * result[i - 1]);
  }
  return result;
}

function linearRegression(points) {
  if (!points || points.length < 2) {
    return { slope: 0, intercept: 0, r2: 0, next: () => 0 };
  }
  const n = points.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
    sumY2 += y * y;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX || 1);
  const intercept = (sumY - slope * sumX) / n;
  const ssRes = points.reduce((s, [x, y]) => s + (y - (slope * x + intercept)) ** 2, 0);
  const ssTot = points.reduce((s, [, y]) => s + (y - sumY / n) ** 2, 0);
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);
  const residualStd = n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0;

  return {
    slope,
    intercept,
    r2,
    residualStd,
    next: (pointsAhead = 1) => {
      const lastX = points[points.length - 1][0];
      return slope * (lastX + pointsAhead) + intercept;
    },
    predict: (x) => slope * x + intercept,
    confidenceInterval: (x, confidenceFactor = 1.96) => {
      const y = slope * x + intercept;
      const xMean = sumX / n;
      const xVariance = points.reduce((s, [xv]) => s + (xv - xMean) ** 2, 0);
      const se = residualStd * Math.sqrt(1 + 1 / n + (x - xMean) ** 2 / (xVariance || 1));
      return { lower: y - confidenceFactor * se, upper: y + confidenceFactor * se };
    },
  };
}

function growthRate(values) {
  if (!values || values.length < 2) return 0;
  const first = values[0];
  const last = values[values.length - 1];
  if (first === 0) return values.every((v) => v === 0) ? 0 : Infinity;
  const periods = values.length - 1;
  return Math.pow(last / first, 1 / periods) - 1;
}

function seasonalDecomposition(values, period) {
  if (!values || values.length < period * 2) {
    return { trend: values, seasonal: null, residual: null };
  }
  const trend = simpleMovingAverage(values, period);
  const detrended = values.map((v, i) => (trend[i] != null ? v - trend[i] : 0));
  const seasonal = [];
  for (let i = 0; i < period; i++) {
    let sum = 0, count = 0;
    for (let j = i; j < detrended.length; j += period) {
      sum += detrended[j];
      count++;
    }
    seasonal.push(count > 0 ? sum / count : 0);
  }
  const seasonalFull = values.map((_, i) => seasonal[i % period]);
  const residual = values.map((v, i) => v - (trend[i] || 0) - seasonalFull[i]);
  return { trend, seasonal: seasonalFull, residual };
}

function detectAnomalies(values, model, stddevThreshold) {
  if (!values || !model || stddevThreshold == null) stddevThreshold = 3;
  const residuals = values.map((v, i) => Math.abs(v - (model[i] != null ? model[i] : v)));
  const meanResidual = residuals.reduce((s, r) => s + r, 0) / residuals.length;
  const stdResidual = Math.sqrt(
    residuals.reduce((s, r) => s + (r - meanResidual) ** 2, 0) / residuals.length
  );
  const threshold = stdResidual * stddevThreshold;
  return values.map((v, i) => ({
    index: i,
    value: v,
    expected: model[i] != null ? model[i] : v,
    residual: residuals[i],
    isAnomaly: residuals[i] > threshold,
  }));
}

function projectFromTimeSeries(timestamps, values, daysAhead) {
  if (!timestamps || timestamps.length < 2 || !daysAhead || daysAhead < 1) return null;
  const baseSeconds = timestamps[0] instanceof Date ? timestamps[0].getTime() / 1000 : timestamps[0];
  const points = timestamps.map((t, i) => {
    const secs = t instanceof Date ? t.getTime() / 1000 : t;
    return [secs - baseSeconds, values[i]];
  });
  const model = linearRegression(points);
  const lastSec = points[points.length - 1][0];
  const dayInSeconds = 86400;
  const projections = [];
  for (let d = 1; d <= daysAhead; d++) {
    const x = lastSec + d * dayInSeconds;
    const interval = model.confidenceInterval(x);
    projections.push({
      day: d,
      value: model.predict(x),
      lowerBound: interval.lower,
      upperBound: interval.upper,
    });
  }
  return {
    model: { slope: model.slope, intercept: model.intercept, r2: model.r2 },
    projections,
    daysUntilExhaustion: (limit) => {
      if (model.slope <= 0) return null;
      const xTarget = (limit - model.intercept) / model.slope;
      const xLast = points[points.length - 1][0];
      const days = (xTarget - xLast) / dayInSeconds;
      return days > 0 ? days : 0;
    },
  };
}

module.exports = {
  simpleMovingAverage,
  exponentialMovingAverage,
  linearRegression,
  growthRate,
  seasonalDecomposition,
  detectAnomalies,
  projectFromTimeSeries,
};
