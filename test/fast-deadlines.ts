const timeout = AbortSignal.timeout.bind(AbortSignal);

// A test-only Kit gives up a bounded wait within a third of a second, so a deadline spec does not wait it out.
AbortSignal.timeout = (delay: number) => timeout(Math.min(delay, 300));
