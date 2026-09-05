declare module "jsdom" {
  export class JSDOM {
    constructor(html: string, options?: Record<string, unknown>);
    window: unknown;
  }
  export class VirtualConsole {
    constructor();
  }
}