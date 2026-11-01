const now = Date.now;
const start = now();

// A test-only Kit's clock runs two hundred times fast, so the minute between a run's reports passes in 300 ms and no timer changes.
Date.now = () => start + (now() - start) * 200;
