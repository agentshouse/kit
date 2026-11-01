const collect = (globalThis as unknown as { gc: () => void }).gc;

// A test-only Kit collects garbage every millisecond, so an object only a pending read still needs is gone before that read starts.
setInterval(collect, 1).unref();
