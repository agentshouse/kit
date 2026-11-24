// An idle tick each minute keeps the held command alive past any spec that watches it, never letting its own code run.
setInterval(() => undefined, 60_000);
await new Promise(() => undefined);
