import { SaveTimer } from '../src/saves.ts';

// A test-only Kit never sends the save it would 3 seconds after a change, so a spec's house upload alone saves what it wrote.
SaveTimer.prototype.changed = () => undefined;
