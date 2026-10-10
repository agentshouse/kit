const System = Date;
const fixed = System.parse(process.env.KIT_CLOCK!);

class Clock extends System {
  constructor(...value: unknown[]) {
    super(...((value.length === 0 ? [fixed] : value) as [number]));
  }

  static override now(): number {
    return fixed;
  }
}

globalThis.Date = Clock as DateConstructor;
